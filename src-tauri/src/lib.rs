mod db;
mod importer;
mod models;

use std::path::PathBuf;

use tauri::{Manager, State};

use models::{DatabaseStats, ImportResult, RunSummary};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let db_path = app_data_dir.join("monitor-dashboard.sqlite3");
            db::initialize_database(&db_path)
                .map_err(std::io::Error::other)?;
            app.manage(AppState { db_path });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_database_stats,
            list_runs,
            import_dashboard_bundle
        ])
        .run(tauri::generate_context!())
        .expect("error while running Monitor Dashboard");
}
