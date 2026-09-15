use std::fs;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use crate::models::{DatabaseStats, RunSummary};

const MIGRATION_0001: &str = include_str!("../migrations/0001_init.sql");

pub fn open_database(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("Не удалось открыть SQLite: {e}"))?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;\nPRAGMA journal_mode = WAL;\nPRAGMA synchronous = NORMAL;\nPRAGMA busy_timeout = 5000;",
    )
    .map_err(|e| format!("Не удалось настроить SQLite: {e}"))?;
    Ok(conn)
}

pub fn initialize_database(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Не удалось создать каталог данных: {e}"))?;
    }
    let conn = open_database(path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);",
    )
    .map_err(|e| format!("Не удалось создать таблицу миграций: {e}"))?;

    let current: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Не удалось прочитать версию БД: {e}"))?;

    if current < 1 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Не удалось начать миграцию: {e}"))?;
        tx.execute_batch(MIGRATION_0001)
            .map_err(|e| format!("Миграция 0001 завершилась ошибкой: {e}"))?;
        tx.execute("INSERT INTO schema_migrations(version) VALUES (1)", [])
            .map_err(|e| format!("Не удалось записать версию миграции: {e}"))?;
        tx.commit()
            .map_err(|e| format!("Не удалось завершить миграцию: {e}"))?;
    }
    Ok(())
}

pub fn schema_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )
    .map_err(|e| format!("Не удалось прочитать версию БД: {e}"))
}

pub fn database_stats(path: &Path) -> Result<DatabaseStats, String> {
    let conn = open_database(path)?;
    let count = |table: &str| -> Result<i64, String> {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .map_err(|e| format!("Не удалось посчитать {table}: {e}"))
    };

    Ok(DatabaseStats {
        database_path: path.to_string_lossy().into_owned(),
        database_size_bytes: fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        schema_version: schema_version(&conn)?,
        monitors: count("monitors")?,
        runs: count("runs")?,
        documents: count("documents")?,
        sources: count("sources")?,
        monitor_items: count("monitor_items")?,
    })
}

pub fn list_runs(path: &Path) -> Result<Vec<RunSummary>, String> {
    let conn = open_database(path)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                r.id,
                m.monitor_key,
                m.display_name,
                r.run_number,
                r.external_run_id,
                r.started_at,
                r.lookback_hours,
                r.dry_run,
                r.contract_version,
                r.imported_at,
                (SELECT COUNT(*) FROM run_items ri WHERE ri.run_id = r.id) AS publications,
                (SELECT COUNT(DISTINCT d.source_id)
                   FROM run_items ri
                   JOIN monitor_items mi ON mi.id = ri.monitor_item_id
                   JOIN documents d ON d.id = mi.document_id
                  WHERE ri.run_id = r.id AND d.source_id IS NOT NULL) AS sources_in_result,
                (SELECT COUNT(*) FROM source_run_metrics srm WHERE srm.run_id = r.id) AS sources_in_coverage
            FROM runs r
            JOIN monitors m ON m.id = r.monitor_id
            ORDER BY COALESCE(r.started_at, r.imported_at) DESC, r.id DESC
            "#,
        )
        .map_err(|e| format!("Не удалось подготовить список запусков: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let dry: Option<i64> = row.get(7)?;
            Ok(RunSummary {
                id: row.get(0)?,
                monitor_key: row.get(1)?,
                monitor_name: row.get(2)?,
                run_number: row.get(3)?,
                external_run_id: row.get(4)?,
                started_at: row.get(5)?,
                lookback_hours: row.get(6)?,
                dry_run: dry.map(|v| v != 0),
                contract_version: row.get(8)?,
                imported_at: row.get(9)?,
                publications: row.get(10)?,
                sources_in_result: row.get(11)?,
                sources_in_coverage: row.get(12)?,
            })
        })
        .map_err(|e| format!("Не удалось прочитать список запусков: {e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Не удалось прочитать запуск: {e}"))
}

pub fn existing_run(
    conn: &Connection,
    monitor_id: i64,
    external_run_key: &str,
) -> Result<Option<(i64, String)>, String> {
    conn.query_row(
        "SELECT id, bundle_sha256 FROM runs WHERE monitor_id=?1 AND external_run_key=?2",
        params![monitor_id, external_run_key],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|e| format!("Не удалось проверить существующий run: {e}"))
}
