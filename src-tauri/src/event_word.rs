use std::{collections::HashMap, fs::File, io::Write, path::Path};

use serde::Deserialize;
use zip::{ZipWriter, write::SimpleFileOptions};

use super::{paragraph, run, xml_attr};

#[derive(Debug, Deserialize)]
pub struct EventReport {
    title: String,
    metadata: Vec<(String, String)>,
    sections: Vec<Section>,
}

#[derive(Debug, Deserialize)]
struct Section {
    heading: String,
    paragraphs: Vec<Vec<Part>>,
    table: Option<Table>,
}

#[derive(Debug, Deserialize)]
struct Table {
    headers: Vec<String>,
    widths: Vec<u32>,
    rows: Vec<Vec<Vec<Part>>>,
}

#[derive(Debug, Deserialize)]
struct Part {
    text: String,
    url: Option<String>,
}

const WIDTH: u32 = 10_100;
const DECL: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;
const WORD: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const OFFICE_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL: &str = "http://schemas.openxmlformats.org/package/2006/relationships";

fn clean(text: &str) -> String {
    text.chars()
        .filter(|ch| matches!(*ch, '\x09' | '\x0a' | '\x0d' | '\u{20}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}'))
        .collect()
}

#[derive(Default)]
struct Links {
    ids: HashMap<String, usize>,
    relations: String,
}

impl Links {
    fn runs(&mut self, parts: &[Part], size: u32) -> String {
        let mut result = String::new();
        for part in parts {
            if part.text.is_empty() { continue; }
            let target = part.url.as_deref().filter(|url| (url.starts_with("https://") || url.starts_with("http://"))
                && url.len() <= 2048 && !url.chars().any(|ch| ch.is_control() || ch.is_whitespace()));
            if let Some(url) = target {
                let id = if let Some(id) = self.ids.get(url) { *id } else {
                    let id = self.ids.len() + 1;
                    self.ids.insert(url.to_string(), id);
                    self.relations.push_str(&format!(
                        r#"<Relationship Id="rId{id}" Type="{OFFICE_REL}/hyperlink" Target="{}" TargetMode="External"/>"#,
                        xml_attr(&clean(url))
                    ));
                    id
                };
                let content = run(&clean(&part.text), false, false, size, Some("1F5482"), true);
                result.push_str(&format!(r#"<w:hyperlink r:id="rId{id}">{content}</w:hyperlink>"#));
            } else {
                result.push_str(&run(&clean(&part.text), false, false, size, None, false));
            }
        }
        result
    }
}

fn cell(content: &str, width: u32, shading: Option<&str>) -> String {
    let fill = shading.map(|fill| format!(r#"<w:shd w:fill="{fill}"/>"#)).unwrap_or_default();
    format!(r#"<w:tc><w:tcPr><w:tcW w:w="{width}" w:type="dxa"/>{fill}<w:vAlign w:val="top"/></w:tcPr>{}</w:tc>"#,
        paragraph(content, "left", None))
}

fn table_start(widths: &[u32]) -> String {
    let mut xml = format!(r#"<w:tbl><w:tblPr><w:tblW w:w="{WIDTH}" w:type="dxa"/><w:tblBorders>"#);
    for border in ["top", "left", "bottom", "right", "insideH", "insideV"] {
        xml.push_str(&format!(r#"<w:{border} w:val="single" w:sz="4" w:color="919DA5"/>"#));
    }
    xml.push_str(r#"</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="65" w:type="dxa"/><w:left w:w="85" w:type="dxa"/><w:bottom w:w="65" w:type="dxa"/><w:right w:w="85" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>"#);
    for width in widths {
        xml.push_str(&format!(r#"<w:gridCol w:w="{width}"/>"#));
    }
    xml.push_str("</w:tblGrid>");
    xml
}

fn table_xml(table: &Table, links: &mut Links) -> Result<String, String> {
    let n = table.headers.len();
    if n == 0 || n > 8 || table.widths.len() != n || table.widths.iter().any(|width| *width < 5 || *width > 100)
        || table.widths.iter().sum::<u32>() != 100 || table.rows.len() > 100 || table.rows.iter().any(|row| row.len() != n) {
        return Err("Некорректная структура таблицы отчёта.".to_string());
    }
    let widths: Vec<u32> = table.widths.iter().map(|percent| WIDTH * percent / 100).collect();
    let mut xml = table_start(&widths);
    xml.push_str(r#"<w:tr><w:trPr><w:tblHeader/></w:trPr>"#);
    for (header, &width) in table.headers.iter().zip(&widths) {
        xml.push_str(&cell(&run(&clean(header), true, false, 19, Some("173653"), false), width, Some("D9E8F4")));
    }
    xml.push_str("</w:tr>");
    for row in &table.rows {
        xml.push_str("<w:tr><w:trPr><w:cantSplit/></w:trPr>");
        for (parts, &width) in row.iter().zip(&widths) {
            xml.push_str(&cell(&links.runs(parts, 18), width, None));
        }
        xml.push_str("</w:tr>");
    }
    xml.push_str("</w:tbl>");
    Ok(xml)
}

fn heading(text: &str, title: bool) -> String {
    let body = run(&clean(text), true, false, if title { 34 } else { 25 }, Some(if title { "173653" } else { "26527A" }), false);
    let (align, before, after) = if title { ("center", 0, 215) } else { ("left", 195, 95) };
    format!(r#"<w:p><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="{before}" w:after="{after}"/><w:jc w:val="{align}"/></w:pPr>{body}</w:p>"#)
}

fn word_parts(report: &EventReport) -> Result<(String, String), String> {
    if report.title.trim().is_empty() || report.sections.is_empty() || report.sections.len() > 16 {
        return Err("Отчёт о событии пуст.".to_string());
    }
    let mut links = Links::default();
    let mut body = heading(&report.title, true);
    let meta_widths = [3_200, WIDTH - 3_200];
    body.push_str(&table_start(&meta_widths));
    for (key, value) in &report.metadata {
        body.push_str("<w:tr>");
        body.push_str(&cell(&run(&clean(key), true, false, 20, None, false), meta_widths[0], Some("F1F4F5")));
        body.push_str(&cell(&run(&clean(value), false, false, 20, None, false), meta_widths[1], None));
        body.push_str("</w:tr>");
    }
    body.push_str("</w:tbl>");
    for section in &report.sections {
        body.push_str(&heading(&section.heading, false));
        for parts in &section.paragraphs {
            let content = links.runs(parts, 22);
            body.push_str(&format!(r#"<w:p><w:pPr><w:spacing w:after="100" w:line="278" w:lineRule="auto"/></w:pPr>{content}</w:p>"#));
        }
        if let Some(table) = &section.table {
            body.push_str(&table_xml(table, &mut links)?);
        }
    }
    body.push_str(r#"<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="960" w:right="900" w:bottom="960" w:left="900" w:header="420" w:footer="420" w:gutter="0"/></w:sectPr>"#);
    let document = format!(r#"{DECL}<w:document xmlns:w="{WORD}" xmlns:r="{OFFICE_REL}"><w:body>{body}</w:body></w:document>"#);
    let rels = format!(r#"{DECL}<Relationships xmlns="{PKG_REL}">{}</Relationships>"#, links.relations);
    Ok((document, rels))
}

pub fn export_event_report_docx(path: &Path, report: &EventReport) -> Result<(), String> {
    if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("docx")) {
        return Err("Файл отчёта должен иметь расширение .docx.".to_string());
    }
    let (document, document_rels) = word_parts(report)?;
    let archive = (|| -> Result<(), Box<dyn std::error::Error>> {
        let mut archive = ZipWriter::new(File::create(path)?);
        for (name, content) in [
            ("[Content_Types].xml", format!(r#"{DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#)),
            ("_rels/.rels", format!(r#"{DECL}<Relationships xmlns="{PKG_REL}"><Relationship Id="rId1" Type="{OFFICE_REL}/officeDocument" Target="word/document.xml"/></Relationships>"#)),
            ("word/document.xml", document),
            ("word/_rels/document.xml.rels", document_rels),
        ] {
            archive.start_file(name, SimpleFileOptions::default())?;
            archive.write_all(content.as_bytes())?;
        }
        archive.finish()?;
        Ok(())
    })();
    archive.map_err(|error| format!("Не удалось записать DOCX отчёта: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_tables_and_preserves_exact_source_links() {
        let report: EventReport = serde_json::from_str(r#"{
           "title":"Янтарный трон","metadata":[["Период","18–19 ноября"]],
           "sections":[{"heading":"Хронология","paragraphs":[],"table":{
             "headers":["Источник"],"widths":[100],
             "rows":[[ [{"text":"Оригинал","url":"https://tvn24.pl/news?a=1&b=2"}] ]]
           }},{"heading":"Реестр","paragraphs":[[{"text":"Оригинал","url":"https://tvn24.pl/news?a=1&b=2"}]]}]
        }"#).unwrap();
        let (word, rels) = word_parts(&report).unwrap();
        assert!(word.contains("<w:tblHeader/>"));
        assert_eq!(word.matches("<w:hyperlink ").count(), 2);
        assert_eq!(rels.matches(" TargetMode=").count(), 1);
        assert!(rels.contains("https://tvn24.pl/news?a=1&amp;b=2"));
    }
}
