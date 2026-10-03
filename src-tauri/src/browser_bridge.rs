use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};

pub const BRIDGE_ADDR: &str = "127.0.0.1:17842";
const MAX_BODY_BYTES: usize = 1_500_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserImportPayload {
    pub title: String,
    pub source: String,
    pub url: String,
    pub text: String,
}

pub type SharedImport = Arc<Mutex<Option<BrowserImportPayload>>>;

fn response(stream: &mut TcpStream, status: &str, body: &str) {
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type, X-Monitor-Browser-Import\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.as_bytes().len()
    );
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn handle(mut stream: TcpStream, pending: &SharedImport) {
    let mut header_bytes = Vec::new();
    let mut one = [0u8; 1];
    while header_bytes.len() < 32_768 {
        match stream.read(&mut one) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                header_bytes.push(one[0]);
                if header_bytes.ends_with(b"\r\n\r\n") { break; }
            }
        }
    }
    let header = String::from_utf8_lossy(&header_bytes);
    let mut lines = header.lines();
    let request_line = lines.next().unwrap_or_default();
    if request_line.starts_with("OPTIONS ") {
        response(&mut stream, "204 No Content", "");
        return;
    }
    if request_line.starts_with("GET /health ") {
        response(&mut stream, "200 OK", r#"{"ok":true}"#);
        return;
    }
    if !request_line.starts_with("POST /import ") {
        response(&mut stream, "404 Not Found", r#"{"ok":false,"error":"not_found"}"#);
        return;
    }
    let mut content_length = 0usize;
    let mut marker_ok = false;
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        }
        if lower.starts_with("x-monitor-browser-import:") && lower.ends_with('1') {
            marker_ok = true;
        }
    }
    if !marker_ok || content_length == 0 || content_length > MAX_BODY_BYTES {
        response(&mut stream, "400 Bad Request", r#"{"ok":false,"error":"invalid_request"}"#);
        return;
    }
    let mut body = vec![0u8; content_length];
    if stream.read_exact(&mut body).is_err() {
        response(&mut stream, "400 Bad Request", r#"{"ok":false,"error":"incomplete_body"}"#);
        return;
    }
    let Ok(mut payload) = serde_json::from_slice::<BrowserImportPayload>(&body) else {
        response(&mut stream, "400 Bad Request", r#"{"ok":false,"error":"invalid_json"}"#);
        return;
    };
    payload.title = payload.title.trim().to_string();
    payload.source = payload.source.trim().to_string();
    payload.url = payload.url.trim().to_string();
    payload.text = payload.text.trim().to_string();
    if payload.title.is_empty() || payload.text.len() < 80 || !(payload.url.starts_with("http://") || payload.url.starts_with("https://")) {
        response(&mut stream, "422 Unprocessable Entity", r#"{"ok":false,"error":"insufficient_article"}"#);
        return;
    }
    if payload.source.is_empty() { payload.source = "Материал из браузера".to_string(); }
    if let Ok(mut slot) = pending.lock() { *slot = Some(payload); }
    response(&mut stream, "200 OK", r#"{"ok":true}"#);
}

pub fn start(pending: SharedImport) {
    thread::spawn(move || {
        let Ok(listener) = TcpListener::bind(BRIDGE_ADDR) else { return; };
        for stream in listener.incoming().flatten() {
            handle(stream, &pending);
        }
    });
}
