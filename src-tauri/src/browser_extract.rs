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


fn find_edge_executable() -> Option<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        candidates.push(std::path::PathBuf::from(program_files_x86).join("Microsoft/Edge/Application/msedge.exe"));
    }
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        candidates.push(std::path::PathBuf::from(program_files).join("Microsoft/Edge/Application/msedge.exe"));
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        candidates.push(std::path::PathBuf::from(local_app_data).join("Microsoft/Edge/Application/msedge.exe"));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn free_local_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Не удалось подобрать локальный DevTools-порт: {e}"))?;
    let port = listener.local_addr()
        .map_err(|e| format!("Не удалось определить локальный DevTools-порт: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn readability_eval_expression() -> String {
    let body = r#"
(() => {
  const bad = [
    "не удается открыть эту страницу",
    "не удаётся открыть эту страницу",
    "не удается получить доступ к сайту",
    "не удаётся получить доступ к сайту",
    "подключение было сброшено",
    "this page isn’t working",
    "this page isn't working",
    "this site can’t be reached",
    "this site can't be reached",
    "err_connection_reset",
    "err_name_not_resolved",
    "err_timed_out"
  ];
  const t = (document.title || "").toLowerCase();
  const b = (document.body?.innerText || "").toLowerCase();
  if (bad.some(x => t.includes(x) || b.includes(x))) {
    return { __monitorError: "BROWSER_PAGE_ERROR" };
  }
  const article = new Readability(document.cloneNode(true), { charThreshold: 180 }).parse();
  if (!article || !article.textContent || article.textContent.trim().length < 180) {
    return { __monitorError: "READABILITY_EMPTY" };
  }
  return {
    title: (article.title || document.title || "").trim(),
    textContent: article.textContent.trim(),
    publishedTime: article.publishedTime || null,
    siteName: article.siteName || null,
    byline: article.byline || null,
    pageUrl: location.href || null
  };
})()
"#;
    format!("{}\n{}", READABILITY_JS, body)
}

fn cdp_evaluate(ws_url: &str, expression: &str) -> Result<BrowserExtractedArticle, String> {
    use tungstenite::{connect, Message};
    let (mut socket, _) = connect(ws_url)
        .map_err(|e| format!("Не удалось подключиться к DevTools Edge: {e}"))?;

    let request = serde_json::json!({
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {
            "expression": expression,
            "returnByValue": true,
            "awaitPromise": true
        }
    });
    socket.send(Message::Text(request.to_string().into()))
        .map_err(|e| format!("Не удалось отправить команду DevTools: {e}"))?;

    loop {
        let msg = socket.read()
            .map_err(|e| format!("Ошибка чтения DevTools: {e}"))?;
        let Message::Text(text) = msg else { continue; };
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Некорректный ответ DevTools: {e}"))?;
        if value.get("id").and_then(|v| v.as_i64()) != Some(1) {
            continue;
        }
        if let Some(exception) = value.get("result").and_then(|v| v.get("exceptionDetails")) {
            return Err(format!("DevTools JavaScript error: {exception}"));
        }
        let result_value = value
            .get("result")
            .and_then(|v| v.get("result"))
            .and_then(|v| v.get("value"))
            .cloned()
            .ok_or_else(|| "DevTools не вернул результат Readability.".to_string())?;

        if let Some(kind) = result_value.get("__monitorError").and_then(|v| v.as_str()) {
            return Err(kind.to_string());
        }

        return serde_json::from_value(result_value)
            .map_err(|e| format!("Не удалось разобрать результат Readability из Edge: {e}"));
    }
}

pub async fn extract_with_real_edge(app: AppHandle, url: &str) -> Result<BrowserExtractedArticle, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Некорректный URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Разрешены только http/https URL.".to_string());
    }
    let edge = find_edge_executable().ok_or_else(|| "Microsoft Edge не найден.".to_string())?;
    let port = free_local_port()?;
    let profile_dir = app.path().app_data_dir()
        .map_err(|e| format!("Не удалось определить каталог приложения: {e}"))?
        .join("article-edge-profile");

    let remote_arg = format!("--remote-debugging-port={port}");
    let profile_arg = format!("--user-data-dir={}", profile_dir.to_string_lossy());
    let mut child = std::process::Command::new(edge)
        .args([
            remote_arg.as_str(),
            profile_arg.as_str(),
            "--new-window",
            "--no-first-run",
            "--no-default-browser-check",
        ])
        .arg(parsed.as_str())
        .spawn()
        .map_err(|e| format!("Не удалось запустить Microsoft Edge: {e}"))?;

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| format!("Не удалось создать локальный DevTools-клиент: {e}"))?;

    let list_url = format!("http://127.0.0.1:{port}/json/list");
    let deadline = std::time::Instant::now() + Duration::from_secs(45);
    let expression = readability_eval_expression();
    let mut last_error = "Edge ещё загружает страницу.".to_string();

    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(900));
        let targets = match client.get(&list_url).send() {
            Ok(response) if response.status().is_success() => response.json::<Vec<serde_json::Value>>().ok(),
            _ => None,
        };
        let Some(targets) = targets else { continue; };
        let target = targets.iter().find(|item| {
            item.get("type").and_then(|v| v.as_str()) == Some("page")
                && item.get("url").and_then(|v| v.as_str()).is_some()
        });
        let Some(target) = target else { continue; };
        let Some(ws_url) = target.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) else { continue; };

        match cdp_evaluate(ws_url, &expression) {
            Ok(article) if article.text_content.trim().len() >= 180 => {
                let _ = child.kill();
                return Ok(article);
            }
            Ok(_) => last_error = "Edge открыл страницу, но основной текст слишком короткий.".to_string(),
            Err(error) => last_error = error,
        }
    }

    let _ = child.kill();
    Err(format!("REAL_EDGE_FAILED: {last_error}"))
}
