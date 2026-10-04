use std::collections::BTreeMap;
use std::sync::mpsc;
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use tauri::{
    AppHandle, Manager, WebviewUrl,
    webview::{PageLoadEvent, WebviewWindowBuilder},
};

const READABILITY_JS: &str = include_str!("../readability.js");
const TITLE_PREFIX: &str = "__MONITOR_READABILITY__";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserExtractedArticle {
    pub title: String,
    pub text_content: String,
    pub published_time: Option<String>,
    pub site_name: Option<String>,
    pub byline: Option<String>,
    pub page_url: Option<String>,
}

fn extraction_script() -> String {
    let worker = r#"
(function () {
  const PREFIX = "__MONITOR_READABILITY__";
  function send(kind, value) {
    const json = JSON.stringify({ kind, value });
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    const b64 = btoa(binary);
    const size = 6000;
    const total = Math.max(1, Math.ceil(b64.length / size));
    for (let i = 0; i < total; i++) {
      setTimeout(() => {
        document.title = PREFIX + ":" + i + ":" + total + ":" + b64.slice(i * size, (i + 1) * size);
      }, i * 35);
    }
  }

  async function extract() {
    try {
      await new Promise(resolve => setTimeout(resolve, 2200));
      const clone = document.cloneNode(true);
      const article = new Readability(clone, { charThreshold: 180 }).parse();
      if (!article || !article.textContent || article.textContent.trim().length < 180) {
        send("error", "Readability did not find enough article text");
        return;
      }
      send("article", {
        title: (article.title || document.title || "").trim(),
        textContent: article.textContent.trim(),
        publishedTime: article.publishedTime || null,
        siteName: article.siteName || null,
        byline: article.byline || null,
        pageUrl: location.href || null
      });
    } catch (error) {
      send("error", String(error && error.message ? error.message : error));
    }
  }

  if (document.readyState === "complete") extract();
  else window.addEventListener("load", extract, { once: true });
})();
"#;
    format!("{READABILITY_JS}\n{worker}")
}

pub async fn extract_with_webview2(app: AppHandle, url: &str) -> Result<BrowserExtractedArticle, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Некорректный URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Разрешены только http/https URL.".to_string());
    }

    let label = format!(
        "article-reader-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let profile_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Не удалось определить каталог приложения: {e}"))?
        .join("article-browser-profile");

    let (tx, rx) = mpsc::channel::<String>();
    let tx_title = tx.clone();

    let window = WebviewWindowBuilder::new(
        &app,
        label,
        WebviewUrl::External(parsed.clone()),
    )
    .title("Monitor · браузерный импорт")
    .visible(false)
    .inner_size(1100.0, 800.0)
    .data_directory(profile_dir)
    .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0")
    .initialization_script(extraction_script())
    .on_page_load(|window, payload| {
        if matches!(payload.event(), PageLoadEvent::Finished) {
            let _ = window.set_title("Monitor · извлечение текста");
        }
    })
    .on_document_title_changed(move |_window, title| {
        if title.starts_with(TITLE_PREFIX) {
            let _ = tx_title.send(title);
        }
    })
    .build()
    .map_err(|e| format!("Не удалось открыть WebView2: {e}"))?;

    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut chunks: BTreeMap<usize, String> = BTreeMap::new();
        let mut expected_total: Option<usize> = None;
        loop {
            let title = rx
                .recv_timeout(Duration::from_secs(25))
                .map_err(|_| "WebView2 не вернул извлечённый текст за 25 секунд.".to_string())?;
            let mut parts = title.splitn(4, ':');
            let prefix = parts.next().unwrap_or_default();
            if prefix != TITLE_PREFIX {
                continue;
            }
            let index = parts.next().and_then(|value| value.parse::<usize>().ok())
                .ok_or_else(|| "Некорректный ответ WebView2.".to_string())?;
            let total = parts.next().and_then(|value| value.parse::<usize>().ok())
                .ok_or_else(|| "Некорректный ответ WebView2.".to_string())?;
            let chunk = parts.next().unwrap_or_default().to_string();
            expected_total = Some(total);
            chunks.insert(index, chunk);
            if chunks.len() == total {
                let encoded = (0..total)
                    .map(|idx| chunks.get(&idx).cloned().unwrap_or_default())
                    .collect::<String>();
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|e| format!("Не удалось декодировать результат WebView2: {e}"))?;
                let json = String::from_utf8(bytes)
                    .map_err(|e| format!("Некорректный UTF-8 из WebView2: {e}"))?;
                let envelope: serde_json::Value = serde_json::from_str(&json)
                    .map_err(|e| format!("Некорректный JSON из WebView2: {e}"))?;
                if envelope.get("kind").and_then(|v| v.as_str()) == Some("error") {
                    let detail = envelope.get("value").and_then(|v| v.as_str()).unwrap_or("Readability error");
                    return Err(format!("Readability: {detail}"));
                }
                let value = envelope.get("value").cloned().unwrap_or(serde_json::Value::Null);
                let article = serde_json::from_value::<BrowserExtractedArticle>(value)
                    .map_err(|e| format!("Не удалось разобрать результат Readability: {e}"))?;
                let title_lc = article.title.to_lowercase();
                let text_lc = article.text_content.to_lowercase();
                let page_url_lc = article.page_url.clone().unwrap_or_default().to_lowercase();
                let browser_error = [
                    "не удается открыть эту страницу",
                    "не удаётся открыть эту страницу",
                    "не удается получить доступ к сайту",
                    "не удаётся получить доступ к сайту",
                    "подключение было сброшено",
                    "this page isn’t working",
                    "this page isn't working",
                    "this site can’t be reached",
                    "this site can't be reached",
                    "hmmm… can't reach this page",
                    "err_connection_reset",
                    "err_name_not_resolved",
                    "err_timed_out",
                ].iter().any(|needle| title_lc.contains(needle) || text_lc.contains(needle))
                    || page_url_lc.starts_with("edge-error:")
                    || page_url_lc.starts_with("chrome-error:")
                    || page_url_lc.contains("chromewebdata");
                if browser_error {
                    return Err("BROWSER_PAGE_ERROR: WebView2 открыл служебную страницу ошибки, а не публикацию.".to_string());
                }
                return Ok(article);
            }
            if expected_total.is_some_and(|total| total > 200) {
                return Err("Слишком большой ответ WebView2.".to_string());
            }
        }
    })
    .await
    .map_err(|e| format!("Ошибка задачи WebView2: {e}"))?;

    let _ = window.close();
    result
}


pub fn open_visible_browser(app: AppHandle, url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Некорректный URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Разрешены только http/https URL.".to_string());
    }
    let label = format!(
        "article-browser-visible-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let profile_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Не удалось определить каталог приложения: {e}"))?
        .join("article-browser-profile");
    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(parsed))
        .title("Monitor · браузер")
        .visible(true)
        .inner_size(1200.0, 850.0)
        .data_directory(profile_dir)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0")
        .build()
        .map_err(|e| format!("Не удалось открыть браузер Monitor: {e}"))?;
    Ok(())
}
