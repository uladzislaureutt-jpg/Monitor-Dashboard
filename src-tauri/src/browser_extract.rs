use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager};

const READABILITY_JS: &str = include_str!("../readability.js");

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

const EDGE_DEVTOOLS_PORT: u16 = 9333;

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
  const title = (document.title || "").toLowerCase();
  const bodyText = (document.body?.innerText || "").toLowerCase();
  if (bad.some(x => title.includes(x) || bodyText.includes(x))) {
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
        .map_err(|e| format!("Не удалось подключиться к Microsoft Edge: {e}"))?;

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
        .map_err(|e| format!("Не удалось выполнить извлечение текста в Edge: {e}"))?;

    loop {
        let msg = socket.read()
            .map_err(|e| format!("Ошибка чтения ответа Edge: {e}"))?;
        let Message::Text(text) = msg else { continue; };
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Некорректный ответ Edge: {e}"))?;
        if value.get("id").and_then(|v| v.as_i64()) != Some(1) {
            continue;
        }
        if let Some(exception) = value.get("result").and_then(|v| v.get("exceptionDetails")) {
            return Err(format!("Ошибка Readability в Edge: {exception}"));
        }
        let result_value = value
            .get("result")
            .and_then(|v| v.get("result"))
            .and_then(|v| v.get("value"))
            .cloned()
            .ok_or_else(|| "Edge не вернул результат извлечения текста.".to_string())?;

        if let Some(kind) = result_value.get("__monitorError").and_then(|v| v.as_str()) {
            return Err(kind.to_string());
        }

        return serde_json::from_value(result_value)
            .map_err(|e| format!("Не удалось разобрать текст публикации из Edge: {e}"));
    }
}

pub async fn extract_with_real_edge(app: AppHandle, url: &str) -> Result<BrowserExtractedArticle, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Некорректный URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Разрешены только http/https URL.".to_string());
    }

    let edge = find_edge_executable().ok_or_else(|| "Microsoft Edge не найден.".to_string())?;
    let port = EDGE_DEVTOOLS_PORT;
    let profile_dir = app.path().app_data_dir()
        .map_err(|e| format!("Не удалось определить каталог приложения: {e}"))?
        .join("article-edge-debug-profile-v2");

    let remote_arg = format!("--remote-debugging-port={port}");
    let profile_arg = format!("--user-data-dir={}", profile_dir.to_string_lossy());
    let mut child = std::process::Command::new(edge)
        .args([
            remote_arg.as_str(),
            profile_arg.as_str(),
            "--new-window",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-mode",
            "--remote-allow-origins=*",
        ])
        .arg(parsed.as_str())
        .spawn()
        .map_err(|e| format!("Не удалось запустить Microsoft Edge: {e}"))?;

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| format!("Не удалось создать локальный клиент Edge: {e}"))?;

    let list_url = format!("http://127.0.0.1:{port}/json/list");
    let wanted_host = parsed.host_str().unwrap_or_default().to_lowercase();
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
            if item.get("type").and_then(|v| v.as_str()) != Some("page") {
                return false;
            }
            let Some(target_url) = item.get("url").and_then(|v| v.as_str()) else {
                return false;
            };
            reqwest::Url::parse(target_url)
                .ok()
                .and_then(|value| value.host_str().map(|host| host.to_lowercase()))
                .is_some_and(|host| host == wanted_host
                    || host.ends_with(&format!(".{wanted_host}"))
                    || wanted_host.ends_with(&format!(".{host}")))
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
    Err(format!("EDGE_IMPORT_FAILED: {last_error}. DevTools endpoint: http://127.0.0.1:{port}/json/list"))
}

pub fn open_real_edge_browser(app: AppHandle, url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Некорректный URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Разрешены только http/https URL.".to_string());
    }

    let edge = find_edge_executable().ok_or_else(|| "Microsoft Edge не найден.".to_string())?;
    let profile_dir = app.path().app_data_dir()
        .map_err(|e| format!("Не удалось определить каталог приложения: {e}"))?
        .join("article-edge-debug-profile-v2");
    let profile_arg = format!("--user-data-dir={}", profile_dir.to_string_lossy());

    std::process::Command::new(edge)
        .args([
            format!("--remote-debugging-port={EDGE_DEVTOOLS_PORT}").as_str(),
            profile_arg.as_str(),
            "--new-window",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-mode",
            "--remote-allow-origins=*",
        ])
        .arg(parsed.as_str())
        .spawn()
        .map_err(|e| format!("Не удалось открыть Microsoft Edge: {e}"))?;

    Ok(())
}
