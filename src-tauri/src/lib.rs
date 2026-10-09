mod db;
mod fulltext;
mod importer;
mod models;
mod report;
mod sync;

use std::path::PathBuf;
use std::process::Command;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use models::{
    ArchiveFacets, ArchivePage, DashboardOverview, DatabaseStats, EditorialSource, ImportResult, PublicationSummary, RunSummary,
    SourceSummary, ModerationFlagInput, ModerationExclusionInput,
};

#[derive(Clone)]
struct AppState {
    db_path: PathBuf,
}

#[tauri::command]
fn get_database_stats(state: State<'_, AppState>, monitor_key: String) -> Result<DatabaseStats, String> {
    db::database_stats(&state.db_path, &monitor_key)
}

#[tauri::command]
fn list_runs(state: State<'_, AppState>, monitor_key: String) -> Result<Vec<RunSummary>, String> {
    db::list_runs(&state.db_path, &monitor_key)
}

#[tauri::command]
fn import_dashboard_bundle(path: String, state: State<'_, AppState>) -> Result<ImportResult, String> {
    let path = PathBuf::from(path);
    importer::import_bundle(&state.db_path, &path)
}

#[tauri::command]
fn get_dashboard_overview(
    monitor_key: String,
    period_days: Option<i64>,
    state: State<'_, AppState>,
) -> Result<DashboardOverview, String> {
    db::dashboard_overview(&state.db_path, &monitor_key, period_days)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn list_publications(
    monitor_key: String,
    query: String,
    period_days: Option<i64>,
    category: String,
    region: String,
    source: String,
    sources: Option<Vec<String>>,
    sort: String,
    limit: i64,
    offset: i64,
    state: State<'_, AppState>,
) -> Result<ArchivePage, String> {
    db::list_publications(
        &state.db_path,
        &monitor_key,
        &query,
        period_days,
        &category,
        &region,
        &source,
        sources.as_deref().unwrap_or(&[]),
        &sort,
        limit,
        offset,
    )
}

#[tauri::command]
fn list_topic_bucket_publications(
    monitor_key: String,
    category: String,
    bucket: String,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<Vec<PublicationSummary>, String> {
    db::list_topic_bucket_publications(
        &state.db_path,
        &monitor_key,
        &category,
        &bucket,
        limit,
    )
}

#[tauri::command]
fn get_archive_facets(
    monitor_key: String,
    state: State<'_, AppState>,
) -> Result<ArchiveFacets, String> {
    db::archive_facets(&state.db_path, &monitor_key)
}

#[tauri::command]
fn list_sources(
    monitor_key: String,
    period_days: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<SourceSummary>, String> {
    db::list_sources(&state.db_path, &monitor_key, period_days)
}

#[tauri::command]
fn get_editorial_source(
    monitor_key: String,
    document_uid: String,
    state: State<'_, AppState>,
) -> Result<Option<EditorialSource>, String> {
    db::editorial_source(&state.db_path, &monitor_key, &document_uid)
}

#[tauri::command]
fn hydrate_report_full_texts(
    monitor_key: String,
    document_uids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<fulltext::FullTextHydrationResult>, String> {
    fulltext::hydrate_selected(&state.db_path, &monitor_key, &document_uids)
}

#[tauri::command]
fn fetch_known_source_article(url: String, state: State<'_, AppState>) -> Result<fulltext::KnownSourceArticleResult, String> {
    fulltext::fetch_known_source_article(&state.db_path, &url)
}

#[tauri::command]
fn resolve_known_source_article(
    url: String,
    state: State<'_, AppState>,
) -> Result<fulltext::KnownSourceMetadataResult, String> {
    fulltext::resolve_known_source(&state.db_path, &url)
}

#[tauri::command]
fn read_clipboard_text(app: AppHandle) -> Result<String, String> {
    app.clipboard().read_text().map_err(|e| format!("Не удалось прочитать буфер обмена: {e}"))
}

#[tauri::command]
fn write_clipboard_text(text: String, app: AppHandle) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| format!("Не удалось записать в буфер обмена: {e}"))
}

#[tauri::command]
fn call_supabase_edge(
    base_url: String,
    anon_key: String,
    slug: String,
    access_token: Option<String>,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let parsed = reqwest::Url::parse(base_url.trim())
        .map_err(|e| format!("Некорректный Supabase URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("Supabase Edge Functions разрешены только по HTTPS.".to_string());
    }
    let host = parsed.host_str().unwrap_or_default().to_lowercase();
    if !host.ends_with(".supabase.co") {
        return Err("Разрешён только домен Supabase.".to_string());
    }
    if slug.is_empty() || !slug.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-') {
        return Err("Некорректное имя Edge Function.".to_string());
    }
    let base = base_url.trim().trim_end_matches('/');
    let url = format!("{base}/functions/v1/{slug}");
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Не удалось создать HTTP-клиент: {e}"))?;
    let mut request = client.post(url)
        .header("apikey", anon_key.trim())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&body);
    if let Some(token) = access_token.filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    let response = request.send().map_err(|e| format!("EDGE_NETWORK: {e}"))?;
    let status = response.status();
    let text = response.text().map_err(|e| format!("EDGE_RESPONSE: {e}"))?;
    if !status.is_success() {
        return Err(format!("EDGE_{}: {}", status.as_u16(), text));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("EDGE_JSON: {e}; body={text}"))
}

#[tauri::command]
fn export_report_docx(
    path: String,
    date: String,
    items: Vec<report::ReportExportItem>,
    monitor_key: String,
) -> Result<(), String> {
    report::export_docx(&PathBuf::from(path), &date, &items, &monitor_key)
}

#[tauri::command]
fn export_w_review_docx(path: String, text: String) -> Result<(), String> {
    report::export_w_review_docx(&PathBuf::from(path), &text)
}

#[tauri::command]
fn extract_w_review_sample(path: String) -> Result<String, String> {
    report::extract_w_review_sample(&PathBuf::from(path))
}

#[tauri::command]
fn sync_github_artifacts(
    repository: String,
    token: String,
    monitor_key: String,
    state: State<'_, AppState>,
) -> Result<sync::SyncResult, String> {
    sync::sync_github(&state.db_path, &repository, &token, &monitor_key)
}

#[tauri::command]
fn sync_server_artifacts(
    base_url: String,
    anon_key: String,
    access_token: String,
    monitor_key: String,
    state: State<'_, AppState>,
) -> Result<sync::SyncResult, String> {
    sync::sync_server(&state.db_path, &base_url, &anon_key, &access_token, &monitor_key)
}

#[tauri::command]
fn replace_moderation_snapshot(
    monitor_key: String,
    flags: Vec<ModerationFlagInput>,
    exclusions: Vec<ModerationExclusionInput>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    db::replace_moderation_snapshot(&state.db_path, &monitor_key, &flags, &exclusions)
}


#[tauri::command]
fn get_app_setting(key: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    db::get_app_setting(&state.db_path, &key)
}

#[tauri::command]
fn set_app_setting(key: String, value: String, state: State<'_, AppState>) -> Result<(), String> {
    db::set_app_setting(&state.db_path, &key, &value)
}

#[tauri::command]
fn delete_app_setting(key: String, state: State<'_, AppState>) -> Result<(), String> {
    db::delete_app_setting(&state.db_path, &key)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = url.trim();
    if !(parsed.starts_with("https://") || parsed.starts_with("http://")) {
        return Err("Разрешены только http/https ссылки.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(parsed)
            .spawn()
            .map_err(|e| format!("Не удалось открыть ссылку в браузере: {e}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = parsed;
        Err("Открытие внешних ссылок реализовано для Windows-сборки.".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let db_path = app_data_dir.join("monitor-dashboard.sqlite3");
            db::initialize_database(&db_path).map_err(std::io::Error::other)?;
            app.manage(AppState { db_path });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_database_stats,
            list_runs,
            import_dashboard_bundle,
            get_dashboard_overview,
            list_publications,
            list_topic_bucket_publications,
            get_archive_facets,
            list_sources,
            get_editorial_source,
            hydrate_report_full_texts,
            fetch_known_source_article,
            resolve_known_source_article,
            read_clipboard_text,
            write_clipboard_text,
            call_supabase_edge,
            export_report_docx,
            export_w_review_docx,
            extract_w_review_sample,
            sync_github_artifacts,
            sync_server_artifacts,
            replace_moderation_snapshot,
            get_app_setting,
            set_app_setting,
            delete_app_setting,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running Monitor Dashboard");
}
