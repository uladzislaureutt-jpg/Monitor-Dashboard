use std::io::Read;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownSourceArticleResult {
    pub title: String,
    pub source: String,
    pub region: Option<String>,
    pub url: String,
    pub text: String,
    pub quality: String,
    pub strategy: String,
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


fn html_title(html: &str) -> Option<String> {
    for key in ["og:title", "twitter:title"] {
        let pattern = format!(r#"(?is)<meta[^>]+(?:property|name)\s*=\s*["']{}["'][^>]+content\s*=\s*["']([^"']+)["']"#, regex::escape(key));
        if let Ok(re) = Regex::new(&pattern) {
            if let Some(value) = re.captures(html).and_then(|m| m.get(1)) {
                let title = normalize_space(&decode_entities(value.as_str()));
                if !title.is_empty() { return Some(title); }
            }
        }
        let reverse = format!(r#"(?is)<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+(?:property|name)\s*=\s*["']{}["']"#, regex::escape(key));
        if let Ok(re) = Regex::new(&reverse) {
            if let Some(value) = re.captures(html).and_then(|m| m.get(1)) {
                let title = normalize_space(&decode_entities(value.as_str()));
                if !title.is_empty() { return Some(title); }
            }
        }
    }
    let h1 = Regex::new(r"(?is)<h1\b[^>]*>(.*?)</h1>").ok()?;
    if let Some(value) = h1.captures(html).and_then(|m| m.get(1)) {
        let title = clean_fragment(value.as_str());
        if !title.is_empty() { return Some(title); }
    }
    let title_re = Regex::new(r"(?is)<title\b[^>]*>(.*?)</title>").ok()?;
    title_re.captures(html).and_then(|m| m.get(1)).map(|v| clean_fragment(v.as_str())).filter(|v| !v.is_empty())
}

fn has_paywall_marker(html: &str) -> bool {
    let lower = html.to_lowercase();
    ["paywall", "subscription", "subscriber-only", "доступ по подписке", "только для подписчиков", "оформить подписку", "па падпісцы"]
        .iter()
        .any(|marker| lower.contains(marker))
}

fn extract_known_article_from_bytes(bytes: &[u8], fallback_title: &str, transport: &str) -> Result<(String, String, String, bool), String> {
    let capped = if bytes.len() > MAX_HTML_BYTES { &bytes[..MAX_HTML_BYTES] } else { bytes };
    let html = String::from_utf8_lossy(capped);
    let title = html_title(&html).unwrap_or_else(|| fallback_title.to_string());
    let (text, strategy) = extract_article_text(&html, &title)
        .ok_or_else(|| "Текст не удалось выделить из HTML-страницы.".to_string())?;
    Ok((title, text, format!("{transport}:{strategy}"), has_paywall_marker(&html)))
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


#[cfg(target_os = "windows")]
fn find_edge_executable() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(program_files_x86).join("Microsoft/Edge/Application/msedge.exe"));
    }
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("Microsoft/Edge/Application/msedge.exe"));
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local_app_data).join("Microsoft/Edge/Application/msedge.exe"));
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(target_os = "windows")]
fn fetch_with_edge(url: &str, title: &str) -> Result<(String, String), String> {
    // Final fallback: use the installed Edge browser engine rather than another
    // raw HTTP client. This is intentionally limited to operator-selected
    // report items (max 8) and executes the page before dumping the DOM.
    let edge = find_edge_executable().ok_or_else(|| "Microsoft Edge не найден.".to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let profile_dir = std::env::temp_dir().join(format!("monitor-edge-{}-{stamp}", std::process::id()));
    let profile_arg = format!("--user-data-dir={}", profile_dir.to_string_lossy());
    let realistic_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0";
    let ua_arg = format!("--user-agent={realistic_ua}");

    let output = Command::new(edge)
        .args([
            "--headless=new",
            "--disable-gpu",
            "--disable-extensions",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-features=msEdgeFirstRunExperience",
            "--virtual-time-budget=8000",
            "--dump-dom",
        ])
        .arg(profile_arg)
        .arg(ua_arg)
        .arg(url)
        .output()
        .map_err(|e| format!("Не удалось запустить Microsoft Edge: {e}"));

    let _ = std::fs::remove_dir_all(&profile_dir);
    let output = output?;
    if !output.status.success() {
        let stderr = normalize_space(&String::from_utf8_lossy(&output.stderr));
        return Err(if stderr.is_empty() {
            format!("Microsoft Edge завершился с кодом {}", output.status.code().unwrap_or(-1))
        } else {
            format!("Microsoft Edge: {stderr}")
        });
    }
    if output.stdout.is_empty() {
        return Err("Microsoft Edge не вернул DOM страницы.".to_string());
    }
    extract_from_bytes(&output.stdout, title, "windows_edge_dom")
}

#[cfg(not(target_os = "windows"))]
fn fetch_with_edge(_url: &str, _title: &str) -> Result<(String, String), String> {
    Err("Browser fallback недоступен на этой платформе.".to_string())
}

fn fetch_text(client: &Client, url: &str, title: &str) -> Result<(String, String), String> {
    let parsed = safe_public_url(url)?;
    let request = client
        .get(parsed)
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
        .header(reqwest::header::ACCEPT_LANGUAGE, "ru-RU,ru;q=0.9,be;q=0.8,en;q=0.6")
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send();

    let should_fallback = match request {
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
            match extract_from_bytes(&bytes, title, "reqwest") {
                Ok(value) => return Ok(value),
                Err(_) => true,
            }
        }
        Ok(response) => matches!(response.status().as_u16(), 403 | 408 | 429 | 500 | 502 | 503 | 504),
        Err(_) => true,
    };

    if !should_fallback {
        return Err("Источник не отдал пригодную HTML-страницу.".to_string());
    }

    if let Ok(value) = fetch_with_windows_curl(url, title) {
        return Ok(value);
    }
    fetch_with_edge(url, title).map_err(|edge| format!("Не удалось получить полный текст автоматически: {edge}"))
}


pub(crate) fn known_source_for_host(db_path: &Path, host: &str) -> Result<Option<(String, Option<String>, String)>, String> {
    let conn = open_database(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT canonical_name, configured_region, domain FROM sources WHERE NULLIF(TRIM(domain),'') IS NOT NULL"
    ).map_err(|e| format!("Не удалось прочитать каталог источников: {e}"))?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?))
    }).map_err(|e| format!("Не удалось прочитать каталог источников: {e}"))?;
    let host = host.trim().trim_start_matches("www.").to_lowercase();
    for row in rows {
        let (name, region, domain) = row.map_err(|e| format!("Ошибка каталога источников: {e}"))?;
        let domain_norm = domain.trim().trim_start_matches("www.").to_lowercase();
        if !domain_norm.is_empty() && (host == domain_norm || host.ends_with(&format!(".{domain_norm}"))) {
            return Ok(Some((name, region, domain_norm)));
        }
    }
    Ok(None)
}

pub fn fetch_known_source_article(db_path: &Path, url: &str) -> Result<KnownSourceArticleResult, String> {
    let parsed = safe_public_url(url)?;
    let host = parsed.host_str().unwrap_or_default();
    let Some((source, region, _domain)) = known_source_for_host(db_path, host)? else {
        return Err("Источник с таким доменом отсутствует в локальной базе Monitor. Используйте вставку из буфера.".to_string());
    };

    // Fast path: if this exact publication already exists in the local archive,
    // reuse its title/full text instead of downloading it again.
    {
        let conn = open_database(db_path)?;
        let local = conn.query_row(
            r#"
            SELECT title, full_text, full_text_quality
            FROM documents
            WHERE RTRIM(TRIM(url), '/') = RTRIM(TRIM(?1), '/')
              AND NULLIF(TRIM(COALESCE(full_text,'')),'') IS NOT NULL
            ORDER BY id DESC
            LIMIT 1
            "#,
            params![parsed.as_str()],
            |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            )),
        ).optional().map_err(|e| format!("Не удалось проверить локальный архив: {e}"))?;
        if let Some((title, text, quality_hint)) = local {
            let partial = quality_hint.as_deref().is_some_and(|value| value.to_lowercase().contains("partial"));
            return Ok(KnownSourceArticleResult {
                title,
                source,
                region,
                url: parsed.to_string(),
                text,
                quality: if partial { "partial" } else { "full" }.to_string(),
                strategy: "local_archive".to_string(),
            });
        }
    }
    let fallback_title = parsed.path_segments()
        .and_then(|segments| segments.filter(|part| !part.trim().is_empty()).last())
        .map(|part| part.replace('-', " ").replace('_', " "))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| source.clone());

    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(DESKTOP_UA)
        .build()
        .map_err(|e| format!("Не удалось создать HTTP-клиент: {e}"))?;

    let request = client.get(parsed.clone())
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
        .header(reqwest::header::ACCEPT_LANGUAGE, "ru-RU,ru;q=0.9,be;q=0.8,en;q=0.6")
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send();

    let mut direct_error = None;
    if let Ok(mut response) = request {
        if response.status().is_success() {
            let mut bytes = Vec::new();
            response.take(MAX_HTML_BYTES as u64 + 1).read_to_end(&mut bytes)
                .map_err(|e| format!("Чтение ответа: {e}"))?;
            if let Ok((title, text, strategy, paywall)) = extract_known_article_from_bytes(&bytes, &fallback_title, "reqwest") {
                return Ok(KnownSourceArticleResult {
                    title, source, region, url: parsed.to_string(), text,
                    quality: if paywall { "partial" } else { "full" }.to_string(),
                    strategy,
                });
            }
        } else {
            direct_error = Some(format!("HTTP {}", response.status()));
        }
    }


    // Nashaniva often exposes a cleaner public AMP page even when the canonical
    // route is unstable for automated clients. Try the language-preserving AMP
    // variants before falling back to curl/Edge.
    if host == "nashaniva.com" || host.ends_with(".nashaniva.com") {
        if let Some(article_id) = parsed.path_segments()
            .and_then(|segments| segments.filter(|part| !part.trim().is_empty()).last())
            .filter(|part| part.chars().all(|ch| ch.is_ascii_digit()))
        {
            let mut amp_urls = Vec::new();
            let path = parsed.path().to_lowercase();
            if path.starts_with("/ru/") {
                amp_urls.push(format!("https://nashaniva.com/amp/ru/{article_id}"));
            } else if path.starts_with("/en/") {
                amp_urls.push(format!("https://nashaniva.com/amp/en/{article_id}"));
            } else {
                amp_urls.push(format!("https://nashaniva.com/amp/{article_id}"));
                amp_urls.push(format!("https://nashaniva.com/amp/be/{article_id}"));
            }
            for amp_url in amp_urls {
                if let Ok(mut response) = client.get(&amp_url)
                    .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
                    .header(reqwest::header::ACCEPT_LANGUAGE, "be,ru;q=0.9,en;q=0.6")
                    .header(reqwest::header::CACHE_CONTROL, "no-cache")
                    .send()
                {
                    if response.status().is_success() {
                        let mut bytes = Vec::new();
                        if response.take(MAX_HTML_BYTES as u64 + 1).read_to_end(&mut bytes).is_ok() {
                            if let Ok((title, text, strategy, paywall)) =
                                extract_known_article_from_bytes(&bytes, &fallback_title, "nashaniva_amp")
                            {
                                return Ok(KnownSourceArticleResult {
                                    title, source, region, url: parsed.to_string(), text,
                                    quality: if paywall { "partial" } else { "full" }.to_string(),
                                    strategy,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    let mut fallback_urls = vec![parsed.to_string()];
    if host == "nashaniva.com" || host.ends_with(".nashaniva.com") {
        if let Some(article_id) = parsed.path_segments()
            .and_then(|segments| segments.filter(|part| !part.trim().is_empty()).last())
            .filter(|part| part.chars().all(|ch| ch.is_ascii_digit()))
        {
            let path = parsed.path().to_lowercase();
            if path.starts_with("/ru/") {
                fallback_urls.push(format!("https://nashaniva.com/amp/ru/{article_id}"));
            } else if path.starts_with("/en/") {
                fallback_urls.push(format!("https://nashaniva.com/amp/en/{article_id}"));
            } else {
                fallback_urls.push(format!("https://nashaniva.com/amp/{article_id}"));
                fallback_urls.push(format!("https://nashaniva.com/amp/be/{article_id}"));
                fallback_urls.push(format!("https://nashaniva.com/amp/ru/{article_id}"));
            }
        }
    }
    fallback_urls.sort();
    fallback_urls.dedup();

    #[cfg(target_os = "windows")]
    {
        let mut diagnostics: Vec<String> = Vec::new();
        for candidate_url in &fallback_urls {
            let output = Command::new("curl.exe")
                .args([
                    "--location","--compressed","--http1.1","--silent","--show-error","--fail",
                    "--connect-timeout","10","--max-time","25","--max-filesize","2500000",
                    "--user-agent",DESKTOP_UA,
                    "--header","Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
                    "--header","Accept-Language: ru-RU,ru;q=0.9,be;q=0.8,en;q=0.6",
                    "--header","Cache-Control: no-cache",
                    candidate_url.as_str(),
                ]).output();
            match output {
                Ok(output) if output.status.success() && !output.stdout.is_empty() => {
                    match extract_known_article_from_bytes(&output.stdout, &fallback_title, "windows_curl") {
                        Ok((title, text, strategy, paywall)) => {
                            return Ok(KnownSourceArticleResult {
                                title, source, region, url: parsed.to_string(), text,
                                quality: if paywall { "partial" } else { "full" }.to_string(),
                                strategy: format!("{strategy}:{}", candidate_url),
                            });
                        }
                        Err(error) => diagnostics.push(format!("curl extract {}: {}", candidate_url, error)),
                    }
                }
                Ok(output) => {
                    let stderr = normalize_space(&String::from_utf8_lossy(&output.stderr));
                    diagnostics.push(format!("curl {}: {}", candidate_url, if stderr.is_empty() { format!("exit {}", output.status.code().unwrap_or(-1)) } else { stderr }));
                }
                Err(error) => diagnostics.push(format!("curl start {}: {}", candidate_url, error)),
            }
        }

        if let Some(edge) = find_edge_executable() {
            for candidate_url in &fallback_urls {
                let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
                let profile_dir = std::env::temp_dir().join(format!("monitor-edge-known-{}-{stamp}", std::process::id()));
                let profile_arg = format!("--user-data-dir={}", profile_dir.to_string_lossy());
                let ua_arg = "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0";
                let output = Command::new(&edge)
                    .args([
                        "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
                        "--no-default-browser-check","--disable-background-networking",
                        "--disable-features=msEdgeFirstRunExperience","--virtual-time-budget=10000","--dump-dom",
                    ])
                    .arg(profile_arg).arg(ua_arg).arg(candidate_url).output();
                let _ = std::fs::remove_dir_all(&profile_dir);
                match output {
                    Ok(output) if output.status.success() && !output.stdout.is_empty() => {
                        match extract_known_article_from_bytes(&output.stdout, &fallback_title, "windows_edge_dom") {
                            Ok((title, text, strategy, paywall)) => {
                                return Ok(KnownSourceArticleResult {
                                    title, source, region, url: parsed.to_string(), text,
                                    quality: if paywall { "partial" } else { "full" }.to_string(),
                                    strategy: format!("{strategy}:{}", candidate_url),
                                });
                            }
                            Err(error) => diagnostics.push(format!("edge extract {}: {}", candidate_url, error)),
                        }
                    }
                    Ok(output) => diagnostics.push(format!("edge {}: exit {}", candidate_url, output.status.code().unwrap_or(-1))),
                    Err(error) => diagnostics.push(format!("edge start {}: {}", candidate_url, error)),
                }
            }
        }

        let detail = diagnostics.into_iter().take(4).collect::<Vec<_>>().join(" | ");
        return Err(format!(
            "Не удалось скачать материал автоматически{}{}. Используйте вставку из буфера.",
            direct_error.map(|e| format!(" ({e})")).unwrap_or_default(),
            if detail.is_empty() { String::new() } else { format!(" Диагностика: {detail}") }
        ));
    }

    #[cfg(not(target_os = "windows"))]
    Err(format!("Не удалось скачать материал автоматически{}. Используйте вставку из буфера.",
        direct_error.map(|e| format!(" ({e})")).unwrap_or_default()))
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
                let transport = if strategy.starts_with("windows_edge_dom:") { "desktop_windows_edge" } else if strategy.starts_with("windows_curl:") { "desktop_windows_curl" } else { "desktop_direct_http" };
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
