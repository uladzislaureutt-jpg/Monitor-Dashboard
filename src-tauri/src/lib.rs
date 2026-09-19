mod db;
mod fulltext;
mod importer;
mod models;
mod report;
mod sync;

use std::path::PathBuf;
use std::process::Command;

use tauri::{Manager, State};

use models::{
    ArchiveFacets, ArchivePage, DashboardOverview, DatabaseStats, EditorialSource, ImportResult, RunSummary,
    SourceSummary, ModerationFlagInput, ModerationExclusionInput,
};

#[derive(Clone)]
struct AppState {
    db_path: PathBuf,
}

#[tauri::command]
fn get_database_stats(state: State<'_, AppState>) -> Result<DatabaseStats, String> {
    db::database_stats(&state.db_path)
}

#[tauri::command]
fn list_runs(state: State<'_, AppState>) -> Result<Vec<RunSummary>, String> {
    db::list_runs(&state.db_path)
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
        &sort,
        limit,
        offset,
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
fn export_report_docx(
    path: String,
    date: String,
    items: Vec<report::ReportExportItem>,
) -> Result<(), String> {
    report::export_docx(&PathBuf::from(path), &date, &items)
}

#[tauri::command]
fn sync_github_artifacts(
    repository: String,
    token: String,
    state: State<'_, AppState>,
) -> Result<sync::SyncResult, String> {
    sync::sync_github(&state.db_path, &repository, &token)
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
            get_archive_facets,
            list_sources,
            get_editorial_source,
            hydrate_report_full_texts,
            export_report_docx,
            sync_github_artifacts,
            replace_moderation_snapshot,
            get_app_setting,
            set_app_setting,
            delete_app_setting,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running Monitor Dashboard");
}
