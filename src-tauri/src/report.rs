use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use serde::Deserialize;
use regex::Regex;
use zip::ZipWriter;
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
    let mut opening_quote = true;
    for ch in compact.chars() {
        match ch {
            '«' | '»' | '“' | '”' | '„' | '‟' | '"' => {
                quoted.push(if opening_quote { '«' } else { '»' });
                opening_quote = !opening_quote;
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

pub fn export_docx(path: &Path, date: &str, items: &[ReportExportItem]) -> Result<(), String> {
    if items.is_empty() { return Err("В обзор не добавлено ни одного материала.".to_string()); }
    if path.extension().and_then(|value| value.to_str()).map(|value| value.eq_ignore_ascii_case("docx")) != Some(true) {
        return Err("Файл отчёта должен иметь расширение .docx".to_string());
    }
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| format!("Не удалось создать каталог отчёта: {e}"))?; }
    let file = File::create(path).map_err(|e| format!("Не удалось создать DOCX: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    let mut body = String::new();
    body.push_str(&paragraph(&run("Обзор критических материалов в СМИ", true, false, 32, None, false), "center", None));
    body.push_str(&paragraph(&run(date.trim(), true, false, 32, None, false), "center", None));
    body.push_str(&paragraph("", "both", None));

    let mut hyperlink_rels = String::new();
    for (index, item) in items.iter().enumerate() {
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

        let rid = format!("rId{}", index + 2);
        let link_run = run(item.url.trim(), false, false, 24, Some("0563C1"), true);
        let hyperlink = format!("<w:hyperlink r:id=\"{rid}\" w:history=\"1\">{link_run}</w:hyperlink>");
        body.push_str(&paragraph(&hyperlink, "left", Some(709)));
        body.push_str(&paragraph("", "both", None));
        hyperlink_rels.push_str(&format!("<Relationship Id=\"{rid}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>", xml_attr(item.url.trim())));
    }
    body.push_str("<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1134\" w:right=\"709\" w:bottom=\"1276\" w:left=\"1276\" w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/></w:sectPr>");

    let document = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><w:body>{body}</w:body></w:document>");
    let styles = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Times New Roman\" w:hAnsi=\"Times New Roman\" w:eastAsia=\"Times New Roman\" w:cs=\"Times New Roman\"/><w:sz w:val=\"32\"/><w:szCs w:val=\"32\"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before=\"0\" w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/><w:rPr><w:rFonts w:ascii=\"Times New Roman\" w:hAnsi=\"Times New Roman\" w:eastAsia=\"Times New Roman\" w:cs=\"Times New Roman\"/><w:sz w:val=\"32\"/><w:szCs w:val=\"32\"/></w:rPr></w:style></w:styles>";
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
