use std::io::Read;
use std::net::IpAddr;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use regex::Regex;
use reqwest::blocking::Client;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::db::open_database;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullTextHydrationResult {
    pub document_uid: String,
    pub status: String,
    pub text_length: Option<usize>,
    pub detail: Option<String>,
}

fn normalize_space(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&#160;", " ")
        .replace("&quot;", "\"")
        .replace("&#34;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&laquo;", "«")
        .replace("&raquo;", "»")
        .replace("&ndash;", "–")
        .replace("&mdash;", "—")
        .replace("&hellip;", "…")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn clean_fragment(fragment: &str) -> String {
    let breaks = Regex::new(r"(?is)<br\s*/?>").expect("valid br regex");
    let tags = Regex::new(r"(?is)<[^>]+>").expect("valid tag regex");
    let text = breaks.replace_all(fragment, " ");
    let text = tags.replace_all(&text, " ");
    normalize_space(&decode_entities(&text))
}

fn is_noise_paragraph(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "читайте также", "чытайце таксама", "смотрите также", "глядзіце таксама",
        "подписывайтесь", "падпісвайцеся", "реклама", "рэклама", "на правах рекламы",
        "использование материалов", "выкарыстанне матэрыялаў", "источник:", "крыніца:",
        "фото:", "фота:", "автор:", "аўтар:", "комментарии", "каментары",
    ]
    .iter()
    .any(|marker| lower.starts_with(marker))
}

fn paragraphs_from(block: &str, title: &str) -> String {
    let p_re = Regex::new(r"(?is)<p\b[^>]*>(.*?)</p>").expect("valid paragraph regex");
    let title_norm = normalize_space(title).to_lowercase();
    let mut result: Vec<String> = Vec::new();
    for capture in p_re.captures_iter(block) {
        let Some(fragment) = capture.get(1) else { continue; };
        let text = clean_fragment(fragment.as_str());
        if text.len() < 24 || is_noise_paragraph(&text) {
            continue;
        }
        if !title_norm.is_empty() && text.to_lowercase() == title_norm {
            continue;
        }
        if result.last().is_some_and(|last| last == &text) {
            continue;
        }
        result.push(text);
    }
    result.join("\n\n")
}

fn find_article_body(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let Some(text) = map.get("articleBody").and_then(Value::as_str) {
                let normalized = normalize_space(text);
                if normalized.len() >= 220 {
                    return Some(normalized);
                }
            }
            for child in map.values() {
                if let Some(found) = find_article_body(child) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(find_article_body),
        _ => None,
    }
}

fn json_ld_body(html: &str) -> Option<String> {
    let script_re = Regex::new(
        r#"(?is)<script[^>]*type\s*=\s*[\"'][^\"']*ld\+json[^\"']*[\"'][^>]*>(.*?)</script>"#,
    )
    .expect("valid json-ld regex");
    for capture in script_re.captures_iter(html) {
        let Some(raw) = capture.get(1) else { continue; };
        if let Ok(value) = serde_json::from_str::<Value>(raw.as_str().trim()) {
            if let Some(text) = find_article_body(&value) {
                return Some(text);
            }
        }
    }
    None
}

fn longest_tag_block(html: &str, tag: &str) -> Option<String> {
    let pattern = format!(r"(?is)<{tag}\b[^>]*>(.*?)</{tag}>");
    let regex = Regex::new(&pattern).ok()?;
    regex
        .captures_iter(html)
        .filter_map(|capture| capture.get(1).map(|item| item.as_str().to_string()))
        .max_by_key(String::len)
}

fn extract_article_text(html: &str, title: &str) -> Option<(String, String)> {
    if let Some(text) = json_ld_body(html) {
        return Some((text, "json_ld_article_body".to_string()));
    }

    let strip_re = Regex::new(r"(?is)<(?:script|style|svg|noscript|form|nav|footer)\b[^>]*>.*?</(?:script|style|svg|noscript|form|nav|footer)>")
        .expect("valid boilerplate regex");
    let cleaned = strip_re.replace_all(html, " ");

    for tag in ["article", "main"] {
        if let Some(block) = longest_tag_block(&cleaned, tag) {
            let text = paragraphs_from(&block, title);
            if text.len() >= 220 {
                return Some((text, format!("{tag}_paragraphs")));
            }
        }
    }

    let text = paragraphs_from(&cleaned, title);
    if text.len() >= 220 {
        return Some((text, "page_paragraphs".to_string()));
    }
    None
}

fn safe_public_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Некорректный URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Разрешены только http/https URL.".to_string());
    }
    let host = parsed.host_str().unwrap_or_default().to_lowercase();
    if host.is_empty() || host == "localhost" || host.ends_with(".local") {
        return Err("Локальные адреса не разрешены.".to_string());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        let blocked = match ip {
            IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified(),
            IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),
        };
        if blocked {
            return Err("Локальные IP-адреса не разрешены.".to_string());
        }
    }
    Ok(parsed)
}

const DESKTOP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153 Safari/537.36 MonitorDashboard/0.6.1";
const MAX_HTML_BYTES: usize = 2_500_000;

fn extract_from_bytes(bytes: &[u8], title: &str, transport: &str) -> Result<(String, String), String> {
    let capped = if bytes.len() > MAX_HTML_BYTES { &bytes[..MAX_HTML_BYTES] } else { bytes };
    let html = String::from_utf8_lossy(capped);
    let (text, strategy) = extract_article_text(&html, title)
        .ok_or_else(|| "Полный текст не удалось выделить из публичной HTML-страницы.".to_string())?;
    Ok((text, format!("{transport}:{strategy}")))
}

#[cfg(target_os = "windows")]
fn fetch_with_windows_curl(url: &str, title: &str) -> Result<(String, String), String> {
    // Windows 10/11 ships curl.exe using the system networking/TLS stack.
    // It is an intentionally narrow fallback for cases where reqwest/rustls
    // cannot negotiate a site or the local Windows proxy/certificate chain.
    let output = Command::new("curl.exe")
        .args([
            "--location",
            "--compressed",
            "--http1.1",
            "--silent",
            "--show-error",
            "--fail",
            "--connect-timeout",
            "10",
            "--max-time",
            "25",
            "--max-filesize",
            "2500000",
            "--user-agent",
            DESKTOP_UA,
            "--header",
            "Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
            "--header",
            "Accept-Language: ru-RU,ru;q=0.9,be;q=0.8,en;q=0.6",
            "--header",
            "Cache-Control: no-cache",
            url,
        ])
        .output()
        .map_err(|e| format!("Windows curl недоступен: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = normalize_space(stderr.trim());
        return Err(if detail.is_empty() {
            format!("Windows curl завершился с кодом {}", output.status.code().unwrap_or(-1))
        } else {
            format!("Windows curl: {detail}")
        });
    }
    extract_from_bytes(&output.stdout, title, "windows_curl")
}

#[cfg(not(target_os = "windows"))]
fn fetch_with_windows_curl(_url: &str, _title: &str) -> Result<(String, String), String> {
    Err("Windows curl fallback недоступен на этой платформе.".to_string())
}

fn fetch_text(client: &Client, url: &str, title: &str) -> Result<(String, String), String> {
    let parsed = safe_public_url(url)?;
    let request = client
        .get(parsed)
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
        .header(reqwest::header::ACCEPT_LANGUAGE, "ru-RU,ru;q=0.9,be;q=0.8,en;q=0.6")
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send();

    match request {
        Ok(mut response) if response.status().is_success() => {
            if let Some(content_type) = response.headers().get(reqwest::header::CONTENT_TYPE) {
                let value = content_type.to_str().unwrap_or_default().to_lowercase();
                if !(value.contains("text/html") || value.contains("application/xhtml+xml") || value.is_empty()) {
                    return Err(format!("Не HTML: {value}"));
                }
            }
            let mut bytes = Vec::new();
            response
                .take(MAX_HTML_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| format!("Чтение ответа: {e}"))?;
            extract_from_bytes(&bytes, title, "reqwest")
        }
        Ok(response) => {
            let status = response.status().as_u16();
            if matches!(status, 403 | 408 | 429 | 500 | 502 | 503 | 504) {
                return fetch_with_windows_curl(url, title)
                    .map_err(|fallback| format!("HTTP {status}; {fallback}"));
            }
            Err(format!("HTTP {status}"))
        }
        Err(primary) => fetch_with_windows_curl(url, title).map_err(|fallback| {
            let primary_kind = if primary.is_timeout() { "таймаут" } else if primary.is_connect() { "соединение/TLS" } else { "HTTP-клиент" };
            format!("{primary_kind}: {}; {fallback}", normalize_space(&primary.to_string()))
        }),
    }
}

pub fn hydrate_selected(
    db_path: &Path,
    monitor_key: &str,
    document_uids: &[String],
) -> Result<Vec<FullTextHydrationResult>, String> {
    if document_uids.len() > 8 {
        return Err("За один раз можно догрузить не более 8 публикаций.".to_string());
    }
    let conn = open_database(db_path)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(DESKTOP_UA)
        .build()
        .map_err(|e| format!("Не удалось создать HTTP-клиент: {e}"))?;

    let mut results = Vec::new();
    for uid in document_uids {
        let row = conn
            .query_row(
                r#"
                SELECT d.url, d.title, d.full_text
                FROM documents d
                JOIN monitor_items mi ON mi.document_id=d.id
                JOIN monitors m ON m.id=mi.monitor_id
                WHERE m.monitor_key=?1 AND d.document_uid=?2
                  AND NOT EXISTS (
                    SELECT 1 FROM moderation_exclusions mx
                    WHERE mx.monitor_key=m.monitor_key AND mx.document_uid=d.document_uid
                  )
                LIMIT 1
                "#,
                params![monitor_key, uid],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?)),
            )
            .optional()
            .map_err(|e| format!("Не удалось прочитать публикацию {uid}: {e}"))?;

        let Some((url, title, existing)) = row else {
            results.push(FullTextHydrationResult {
                document_uid: uid.clone(),
                status: "failed".to_string(),
                text_length: None,
                detail: Some("Публикация не найдена в локальной базе.".to_string()),
            });
            continue;
        };

        if let Some(text) = existing.filter(|value| !value.trim().is_empty()) {
            results.push(FullTextHydrationResult {
                document_uid: uid.clone(),
                status: "already_present".to_string(),
                text_length: Some(text.chars().count()),
                detail: None,
            });
            continue;
        }

        match fetch_text(&client, &url, &title) {
            Ok((text, strategy)) => {
                let text_length = text.chars().count();
                let digest = hex::encode(Sha256::digest(text.as_bytes()));
                let transport = if strategy.starts_with("windows_curl:") { "desktop_windows_curl" } else { "desktop_direct_http" };
                conn.execute(
                    r#"
                    UPDATE documents SET
                        full_text=?2,
                        full_text_sha256=?3,
                        full_text_quality='on_demand_public_html',
                        full_text_extraction_strategy=?4,
                        full_text_transport=?5,
                        text_length=CASE WHEN COALESCE(text_length,0) < ?6 THEN ?6 ELSE text_length END,
                        last_seen_at=COALESCE(last_seen_at,CURRENT_TIMESTAMP)
                    WHERE document_uid=?1
                    "#,
                    params![uid, &text, digest, strategy, transport, text_length as i64],
                )
                .map_err(|e| format!("Не удалось сохранить полный текст {uid}: {e}"))?;
                results.push(FullTextHydrationResult {
                    document_uid: uid.clone(),
                    status: "fetched".to_string(),
                    text_length: Some(text_length),
                    detail: Some(strategy),
                });
            }
            Err(detail) => results.push(FullTextHydrationResult {
                document_uid: uid.clone(),
                status: "failed".to_string(),
                text_length: None,
                detail: Some(detail),
            }),
        }
    }
    Ok(results)
}
