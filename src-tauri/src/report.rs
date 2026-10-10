use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use serde::Deserialize;
use regex::Regex;
use zip::{ZipArchive, ZipWriter};
use zip::write::SimpleFileOptions;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportExportItem {
    pub source: String,
    pub location: String,
    pub title: String,
    pub text: String,
    pub url: String,
}

fn xml_text(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}
fn xml_attr(value: &str) -> String {
    xml_text(value).replace('"', "&quot;").replace('\'', "&apos;")
}
fn run(text: &str, bold: bool, italic: bool, size: u32, color: Option<&str>, underline: bool) -> String {
    let mut props = String::from("<w:rFonts w:ascii=\"Times New Roman\" w:hAnsi=\"Times New Roman\" w:eastAsia=\"Times New Roman\" w:cs=\"Times New Roman\"/>");
    if bold { props.push_str("<w:b/><w:bCs/>"); }
    if italic { props.push_str("<w:i/><w:iCs/>"); }
    props.push_str(&format!("<w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/>"));
    if let Some(value) = color { props.push_str(&format!("<w:color w:val=\"{value}\"/>")); }
    if underline { props.push_str("<w:u w:val=\"single\"/>"); }
    format!("<w:r><w:rPr>{props}</w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>", xml_text(text))
}
fn paragraph(runs: &str, align: &str, first_line: Option<u32>) -> String {
    let indent = first_line.map(|value| format!("<w:ind w:firstLine=\"{value}\"/>" )).unwrap_or_default();
    format!("<w:p><w:pPr><w:jc w:val=\"{align}\"/>{indent}<w:spacing w:before=\"0\" w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr>{runs}</w:p>")
}
fn split_first_sentence(text: &str) -> (&str, &str) {
    let bytes = text.as_bytes();
    for (idx, ch) in text.char_indices() {
        if matches!(ch, '.' | '!' | '?' | '…') {
            let after = idx + ch.len_utf8();
            if after >= text.len() { return (text.trim(), ""); }
            if bytes.get(after).is_some_and(|b| b.is_ascii_whitespace()) {
                return (text[..after].trim(), text[after..].trim());
            }
        }
    }
    (text.trim(), "")
}
fn source_label(value: &str) -> String {
    let clean = value.trim().trim_matches(|c| c == '«' || c == '»');
    format!("«{clean}»")
}

fn sanitize_editorial_text(value: &str) -> String {
    let omission = Regex::new(r"\[\s*(?:…|\.{3})\s*\]").expect("valid omission regex");
    let spaces = Regex::new(r"[ \t]{2,}").expect("valid spaces regex");
    let cleaned = omission.replace_all(value, " ");
    let compact = spaces.replace_all(cleaned.trim(), " ");
    let mut quoted = String::with_capacity(compact.len());
    let mut opening_straight_quote = true;
    for ch in compact.chars() {
        match ch {
            // Existing Russian quotation marks are already directional.
            '«' => quoted.push('«'),
            '»' => quoted.push('»'),
            // Curly quotation marks have their own direction as well.
            '“' | '„' | '‟' => quoted.push('«'),
            '”' => quoted.push('»'),
            // Straight quotes have no direction, so pair only these.
            '"' => {
                quoted.push(if opening_straight_quote { '«' } else { '»' });
                opening_straight_quote = !opening_straight_quote;
            }
            '—' => quoted.push('–'),
            _ => quoted.push(ch),
        }
    }
    let spaced_dash = Regex::new(r"\s-\s").expect("valid spaced dash regex");
    let normalized = spaced_dash.replace_all(&quoted, " – ");
    // The exporter supplies the one final full stop after its closing quotation mark.
    normalized.trim().trim_end_matches('.').trim_end().to_string()
}


fn paragraph_l_monitor(runs: &str) -> String {
    format!("<w:p><w:pPr><w:jc w:val=\"both\"/><w:ind w:firstLine=\"720\"/></w:pPr>{runs}</w:p>")
}


fn run_w_review(text: &str, bold: bool, italic: bool, underline: bool) -> String {
    let mut props = String::from("<w:rFonts w:ascii=\"Arial\" w:hAnsi=\"Arial\" w:eastAsia=\"Arial\" w:cs=\"Arial\"/><w:spacing w:val=\"-6\"/><w:sz w:val=\"32\"/><w:szCs w:val=\"32\"/>");
    if bold { props.push_str("<w:b/><w:bCs/>"); }
    if italic { props.push_str("<w:i/><w:iCs/>"); }
    if underline { props.push_str("<w:u w:val=\"single\"/>"); }
    format!("<w:r><w:rPr>{props}</w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>", xml_text(text))
}

fn paragraph_w_review(runs: &str, heading: bool) -> String {
    let indent = if heading { "" } else { "<w:ind w:firstLine=\"720\" w:right=\"0\"/>" };
    format!("<w:p><w:pPr><w:jc w:val=\"both\"/>{indent}</w:pPr>{runs}</w:p>")
}

fn first_char_upper(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn w_review_source_ranges(text: &str, source_names: &[String]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    for source in source_names {
        let clean = source.trim().trim_matches('«').trim_matches('»').trim();
        if clean.is_empty() { continue; }
        let variants = [clean.to_string(), first_char_upper(clean)];
        for variant in variants {
            let pattern = format!(r"(?i)«{}»", regex::escape(&variant));
            if let Ok(re) = Regex::new(&pattern) {
                for mat in re.find_iter(text) { ranges.push((mat.start(), mat.end())); }
            }
        }
    }
    ranges.sort_unstable();
    ranges.dedup();
    ranges
}

fn w_review_exact_ranges(text: &str, phrases: &[String]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    for phrase in phrases {
        let needle = phrase.trim();
        if needle.is_empty() { continue; }
        let mut offset = 0usize;
        while let Some(found) = text[offset..].find(needle) {
            let start = offset + found;
            let end = start + needle.len();
            ranges.push((start, end));
            offset = end;
            if offset >= text.len() { break; }
        }
    }
    ranges
}

fn range_contains(ranges: &[(usize, usize)], start: usize, end: usize) -> bool {
    ranges.iter().any(|(a, b)| start >= *a && end <= *b)
}

fn w_review_runs(text: &str, first_paragraph: bool, source_names: &[String], bold_phrases: &[String]) -> String {
    let source_ranges = w_review_source_ranges(text, source_names);
    let mut bold_ranges = w_review_exact_ranges(text, bold_phrases);

    if first_paragraph && text.starts_with('«') {
        if let Some(close) = text.find('»') {
            bold_ranges.push((0, close + '»'.len_utf8()));
        }
    }

    let mut cuts = vec![0usize, text.len()];
    for (a, b) in source_ranges.iter().chain(bold_ranges.iter()) {
        cuts.push(*a); cuts.push(*b);
    }
    cuts.sort_unstable();
    cuts.dedup();

    let mut result = String::new();
    for pair in cuts.windows(2) {
        let start = pair[0]; let end = pair[1];
        if start >= end { continue; }
        let slice = &text[start..end];
        let bold = range_contains(&bold_ranges, start, end);
        let italic = range_contains(&source_ranges, start, end);
        result.push_str(&run_w_review(slice, bold, italic, false));
    }
    if result.is_empty() { result.push_str(&run_w_review(text, false, false, false)); }
    result
}


fn sanitize_l_monitor_text(value: &str) -> String {
    let base = sanitize_editorial_text(value);
    let abbreviations = Regex::new(r"(?i)\b(тыс|млн|млрд|трлн)\.?(\s|$)").expect("valid abbreviation regex");
    let with_abbreviations = abbreviations.replace_all(&base, "$1.$2");
    let initials_pair = Regex::new(r"\b([А-ЯЁA-Z])\.\s+([А-ЯЁA-Z])\.").expect("valid initials regex");
    let compact_pairs = initials_pair.replace_all(&with_abbreviations, "$1.$2.");
    let initial_surname = Regex::new(r"\b([А-ЯЁA-Z])\.\s+([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]+)").expect("valid initial surname regex");
    initial_surname.replace_all(&compact_pairs, "$1.$2").to_string()
}

fn title_separator(title: &str) -> &'static str {
    match title.chars().last() {
        Some('.' | '!' | '?' | '…' | '»') => " ",
        _ => ". ",
    }
}



fn decode_word_xml(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

pub fn extract_w_review_sample(path: &Path) -> Result<String, String> {
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_lowercase();
    if extension == "txt" {
        let text = fs::read_to_string(path).map_err(|e| format!("Не удалось прочитать TXT-образец: {e}"))?;
        let clean = text.trim().to_string();
        if clean.is_empty() { return Err("Образец пуст.".to_string()); }
        return Ok(clean);
    }
    if extension != "docx" {
        return Err("Для образцов W-Review поддерживаются DOCX и TXT.".to_string());
    }

    let file = File::open(path).map_err(|e| format!("Не удалось открыть DOCX-образец: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Некорректный DOCX-образец: {e}"))?;
    let mut document = archive.by_name("word/document.xml").map_err(|e| format!("В DOCX нет word/document.xml: {e}"))?;
    let mut xml = String::new();
    use std::io::Read;
    document.read_to_string(&mut xml).map_err(|e| format!("Не удалось прочитать XML DOCX: {e}"))?;

    let paragraph_re = Regex::new(r"(?s)<w:p\b[^>]*>(.*?)</w:p>").expect("valid paragraph regex");
    let text_re = Regex::new(r"(?s)<w:t(?:\s[^>]*)?>(.*?)</w:t>").expect("valid text regex");
    let mut paragraphs = Vec::new();
    for paragraph in paragraph_re.captures_iter(&xml) {
        let inner = paragraph.get(1).map(|value| value.as_str()).unwrap_or("");
        let mut text = String::new();
        for part in text_re.captures_iter(inner) {
            if let Some(value) = part.get(1) { text.push_str(&decode_word_xml(value.as_str())); }
        }
        let clean = text.replace('\u{00A0}', " ").trim().to_string();
        if !clean.is_empty() { paragraphs.push(clean); }
    }
    let result = paragraphs.join("\n\n");
    if result.trim().is_empty() { return Err("В DOCX-образце не найден текст.".to_string()); }
    if result.chars().count() > 30000 { return Err("Один образец W-Review не должен превышать 30 000 знаков.".to_string()); }
    Ok(result)
}

pub fn export_w_review_docx(path: &Path, text: &str, source_names: &[String], section_titles: &[String], bold_phrases: &[String]) -> Result<(), String> {
    if text.trim().is_empty() { return Err("Итоговый текст W-Review пуст.".to_string()); }
    if path.extension().and_then(|value| value.to_str()).map(|value| value.eq_ignore_ascii_case("docx")) != Some(true) {
        return Err("Файл W-Review должен иметь расширение .docx".to_string());
    }
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| format!("Не удалось создать каталог W-Review: {e}"))?; }
    let file = File::create(path).map_err(|e| format!("Не удалось создать DOCX W-Review: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    let cleaned = sanitize_l_monitor_text(text).replace("**", "").replace("__", "");
    let blocks = Regex::new(r"\n\s*\n+").expect("valid paragraph split regex");
    let mut body = String::new();
    let mut prose_index = 0usize;
    for block in blocks.split(&cleaned).map(str::trim).filter(|value| !value.is_empty()) {
        let is_heading = section_titles.iter().any(|title| title.trim() == block);
        if is_heading {
            let runs = run_w_review(block, false, true, true);
            body.push_str(&paragraph_w_review(&runs, true));
        } else {
            let runs = w_review_runs(block, prose_index == 0, source_names, bold_phrases);
            body.push_str(&paragraph_w_review(&runs, false));
            prose_index += 1;
        }
    }
    body.push_str("<w:sectPr><w:type w:val=\"nextPage\"/><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:left=\"1260\" w:right=\"747\" w:gutter=\"0\" w:header=\"0\" w:top=\"1418\" w:footer=\"0\" w:bottom=\"851\"/><w:pgNumType w:fmt=\"decimal\"/><w:docGrid w:type=\"default\" w:linePitch=\"360\" w:charSpace=\"0\"/></w:sectPr>");

    let document = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><w:body>{body}</w:body></w:document>");
    let styles = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Arial\" w:hAnsi=\"Arial\" w:eastAsia=\"Arial\" w:cs=\"Arial\"/><w:spacing w:val=\"-6\"/><w:sz w:val=\"32\"/><w:szCs w:val=\"32\"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults><w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/><w:rPr><w:rFonts w:ascii=\"Arial\" w:hAnsi=\"Arial\" w:eastAsia=\"Arial\" w:cs=\"Arial\"/><w:spacing w:val=\"-6\"/><w:sz w:val=\"32\"/><w:szCs w:val=\"32\"/></w:rPr></w:style></w:styles>";
    let root_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>";
    let doc_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>";
    let content_types = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/></Types>";

    for (name, content) in [
        ("[Content_Types].xml", content_types.to_string()),
        ("_rels/.rels", root_rels.to_string()),
        ("word/document.xml", document),
        ("word/styles.xml", styles.to_string()),
        ("word/_rels/document.xml.rels", doc_rels.to_string()),
    ] {
        zip.start_file(name, options).map_err(|e| format!("Не удалось создать часть DOCX {name}: {e}"))?;
        zip.write_all(content.as_bytes()).map_err(|e| format!("Не удалось записать часть DOCX {name}: {e}"))?;
    }
    zip.finish().map_err(|e| format!("Не удалось завершить DOCX W-Review: {e}"))?;
    Ok(())
}

pub fn export_docx(path: &Path, date: &str, items: &[ReportExportItem], monitor_key: &str) -> Result<(), String> {
    if items.is_empty() { return Err("В обзор не добавлено ни одного материала.".to_string()); }
    if path.extension().and_then(|value| value.to_str()).map(|value| value.eq_ignore_ascii_case("docx")) != Some(true) {
        return Err("Файл отчёта должен иметь расширение .docx".to_string());
    }
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| format!("Не удалось создать каталог отчёта: {e}"))?; }
    let file = File::create(path).map_err(|e| format!("Не удалось создать DOCX: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let is_l_monitor = monitor_key == "lukashenko";

    let mut body = String::new();
    if !is_l_monitor {
        body.push_str(&paragraph(&run("Обзор критических материалов в СМИ", true, false, 32, None, false), "center", None));
        body.push_str(&paragraph(&run(date.trim(), true, false, 32, None, false), "center", None));
        body.push_str(&paragraph("", "both", None));
    }

    let mut hyperlink_rels = String::new();
    let mut next_rid = 2usize;
    for item in items {
        if is_l_monitor {
            let cleaned_title = sanitize_l_monitor_text(item.title.trim());
            let raw_text = item.text.trim();
            let cleaned_text = if raw_text.is_empty() { String::new() } else { sanitize_l_monitor_text(raw_text) };

            let mut runs = run(&source_label(&item.source), false, true, 32, None, false);
            if !item.location.trim().is_empty() {
                runs.push_str(&run(&format!(" ({})", item.location.trim()), false, false, 32, None, false));
            }
            runs.push_str(&run(": «", false, false, 32, None, false));
            runs.push_str(&run(&cleaned_title, true, true, 32, None, false));
            if !cleaned_text.is_empty() {
                runs.push_str(&run(title_separator(&cleaned_title), false, false, 32, None, false));
                runs.push_str(&run(&cleaned_text, false, false, 32, None, false));
            }
            runs.push_str(&run("».", false, false, 32, None, false));
            body.push_str(&paragraph_l_monitor(&runs));
            continue;
        }

        let raw_text = if item.text.trim().is_empty() { item.title.trim() } else { item.text.trim() };
        let cleaned_text = sanitize_editorial_text(raw_text);
        let text = cleaned_text.as_str();
        let (first, rest) = split_first_sentence(text);
        let mut runs = run(&source_label(&item.source), false, true, 32, None, false);
        if !item.location.trim().is_empty() {
            runs.push_str(&run(&format!(" ({})", item.location.trim()), false, false, 32, None, false));
        }
        runs.push_str(&run(": «", false, false, 32, None, false));
        runs.push_str(&run(first, true, true, 32, None, false));
        if !rest.is_empty() { runs.push_str(&run(&format!(" {rest}"), false, false, 32, None, false)); }
        runs.push_str(&run("».", false, false, 32, None, false));
        body.push_str(&paragraph(&runs, "both", Some(709)));

        if !item.url.trim().is_empty() {
            let rid = format!("rId{next_rid}");
            next_rid += 1;
            let link_run = run(item.url.trim(), false, false, 24, Some("0563C1"), true);
            let hyperlink = format!("<w:hyperlink r:id=\"{rid}\" w:history=\"1\">{link_run}</w:hyperlink>");
            body.push_str(&paragraph(&hyperlink, "left", Some(709)));
            hyperlink_rels.push_str(&format!("<Relationship Id=\"{rid}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>", xml_attr(item.url.trim())));
        }
        body.push_str(&paragraph("", "both", None));
    }

    if is_l_monitor {
        body.push_str("<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:left=\"1276\" w:right=\"707\" w:gutter=\"0\" w:header=\"720\" w:top=\"1135\" w:footer=\"0\" w:bottom=\"851\"/><w:docGrid w:type=\"default\" w:linePitch=\"272\" w:charSpace=\"0\"/></w:sectPr>");
    } else {
        body.push_str("<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1134\" w:right=\"709\" w:bottom=\"1276\" w:left=\"1276\" w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/></w:sectPr>");
    }

    let document = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><w:body>{body}</w:body></w:document>");
    let styles = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Times New Roman\" w:hAnsi=\"Times New Roman\" w:eastAsia=\"Times New Roman\" w:cs=\"Times New Roman\"/><w:sz w:val=\"32\"/><w:szCs w:val=\"32\"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults><w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/><w:rPr><w:rFonts w:ascii=\"Times New Roman\" w:hAnsi=\"Times New Roman\" w:eastAsia=\"Times New Roman\" w:cs=\"Times New Roman\"/><w:sz w:val=\"32\"/><w:szCs w:val=\"32\"/></w:rPr></w:style></w:styles>";
    let root_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>";
    let doc_rels = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>{hyperlink_rels}</Relationships>");
    let content_types = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/></Types>";

    for (name, content) in [
        ("[Content_Types].xml", content_types.to_string()),
        ("_rels/.rels", root_rels.to_string()),
        ("word/document.xml", document),
        ("word/styles.xml", styles.to_string()),
        ("word/_rels/document.xml.rels", doc_rels),
    ] {
        zip.start_file(name, options).map_err(|e| format!("Не удалось создать часть DOCX {name}: {e}"))?;
        zip.write_all(content.as_bytes()).map_err(|e| format!("Не удалось записать часть DOCX {name}: {e}"))?;
    }
    zip.finish().map_err(|e| format!("Не удалось завершить DOCX: {e}"))?;
    Ok(())
}
