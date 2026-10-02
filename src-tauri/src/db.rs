use std::collections::HashSet;
use std::fs;
use std::path::Path;

use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension, Row};

use crate::models::{
    ArchiveFacets, ArchivePage, CountPoint, DashboardOverview, DatabaseStats,
    PublicationSummary, RunSummary, SourceSummary, TopicTrendPoint, SourceDiversitySummary, CoverageHealthSummary,
    ModerationFlagInput, ModerationExclusionInput, EditorialSource, EditorialEntity,
};

const MIGRATION_0001: &str = include_str!("../migrations/0001_init.sql");
const MIGRATION_0002: &str = include_str!("../migrations/0002_sync.sql");
const MIGRATION_0003: &str = include_str!("../migrations/0003_preview_images.sql");
const MIGRATION_0004: &str = include_str!("../migrations/0004_moderation.sql");
const MIGRATION_0005: &str = include_str!("../migrations/0005_editorial_sources.sql");
const MIGRATION_0006: &str = include_str!("../migrations/0006_persistent_settings.sql");

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

    if current < 2 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Не удалось начать миграцию 0002: {e}"))?;
        tx.execute_batch(MIGRATION_0002)
            .map_err(|e| format!("Миграция 0002 завершилась ошибкой: {e}"))?;
        tx.execute("INSERT OR IGNORE INTO schema_migrations(version) VALUES (2)", [])
            .map_err(|e| format!("Не удалось записать версию миграции 0002: {e}"))?;
        tx.commit()
            .map_err(|e| format!("Не удалось завершить миграцию 0002: {e}"))?;
    }

    if current < 3 {
        let tx = conn.unchecked_transaction().map_err(|e| format!("Не удалось начать миграцию 0003: {e}"))?;
        tx.execute_batch(MIGRATION_0003).map_err(|e| format!("Миграция 0003 завершилась ошибкой: {e}"))?;
        tx.execute("INSERT OR IGNORE INTO schema_migrations(version) VALUES (3)", []).map_err(|e| format!("Не удалось записать версию миграции 0003: {e}"))?;
        tx.commit().map_err(|e| format!("Не удалось завершить миграцию 0003: {e}"))?;
    }
    if current < 4 {
        let tx = conn.unchecked_transaction().map_err(|e| format!("Не удалось начать миграцию 0004: {e}"))?;
        tx.execute_batch(MIGRATION_0004).map_err(|e| format!("Миграция 0004 завершилась ошибкой: {e}"))?;
        tx.execute("INSERT OR IGNORE INTO schema_migrations(version) VALUES (4)", []).map_err(|e| format!("Не удалось записать версию миграции 0004: {e}"))?;
        tx.commit().map_err(|e| format!("Не удалось завершить миграцию 0004: {e}"))?;
    }
    if current < 5 {
        let tx = conn.unchecked_transaction().map_err(|e| format!("Не удалось начать миграцию 0005: {e}"))?;
        tx.execute_batch(MIGRATION_0005).map_err(|e| format!("Миграция 0005 завершилась ошибкой: {e}"))?;
        tx.execute("INSERT OR IGNORE INTO schema_migrations(version) VALUES (5)", []).map_err(|e| format!("Не удалось записать версию миграции 0005: {e}"))?;
        tx.commit().map_err(|e| format!("Не удалось завершить миграцию 0005: {e}"))?;
    }
    if current < 6 {
        let tx = conn.unchecked_transaction().map_err(|e| format!("Не удалось начать миграцию 0006: {e}"))?;
        tx.execute_batch(MIGRATION_0006).map_err(|e| format!("Миграция 0006 завершилась ошибкой: {e}"))?;
        tx.execute("INSERT OR IGNORE INTO schema_migrations(version) VALUES (6)", []).map_err(|e| format!("Не удалось записать версию миграции 0006: {e}"))?;
        tx.commit().map_err(|e| format!("Не удалось завершить миграцию 0006: {e}"))?;
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

pub fn database_stats(path: &Path, monitor_key: &str) -> Result<DatabaseStats, String> {
    let conn = open_database(path)?;
    let count = |sql: &str, label: &str| -> Result<i64, String> {
        conn.query_row(sql, params![monitor_key], |row| row.get(0))
            .map_err(|e| format!("Не удалось посчитать {label}: {e}"))
    };

    Ok(DatabaseStats {
        database_path: path.to_string_lossy().into_owned(),
        database_size_bytes: fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        schema_version: schema_version(&conn)?,
        monitors: count("SELECT COUNT(*) FROM monitors WHERE monitor_key=?1", "мониторы")?,
        runs: count("SELECT COUNT(*) FROM runs r JOIN monitors m ON m.id=r.monitor_id WHERE m.monitor_key=?1", "запуски")?,
        documents: count("SELECT COUNT(DISTINCT d.id) FROM documents d JOIN monitor_items mi ON mi.document_id=d.id JOIN monitors m ON m.id=mi.monitor_id WHERE m.monitor_key=?1", "публикации")?,
        sources: count("SELECT COUNT(DISTINCT d.source_id) FROM documents d JOIN monitor_items mi ON mi.document_id=d.id JOIN monitors m ON m.id=mi.monitor_id WHERE m.monitor_key=?1 AND d.source_id IS NOT NULL", "источники")?,
        monitor_items: count("SELECT COUNT(*) FROM monitor_items mi JOIN monitors m ON m.id=mi.monitor_id WHERE m.monitor_key=?1", "элементы мониторинга")?,
    })
}

pub fn list_runs(path: &Path, monitor_key: &str) -> Result<Vec<RunSummary>, String> {
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
            WHERE m.monitor_key = ?1
            ORDER BY COALESCE(r.started_at, r.imported_at) DESC, r.id DESC
            "#,
        )
        .map_err(|e| format!("Не удалось подготовить список запусков: {e}"))?;

    let rows = stmt
        .query_map(params![monitor_key], |row| {
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

fn period_clause(alias: &str, parameter: &str) -> String {
    format!(
        "({parameter} IS NULL OR ({alias}.published_at IS NOT NULL AND datetime({alias}.published_at) >= datetime('now', '-' || {parameter} || ' days')))"
    )
}

fn publication_row(row: &Row<'_>) -> rusqlite::Result<PublicationSummary> {
    let official: Option<i64> = row.get(13)?;
    Ok(PublicationSummary {
        id: row.get(0)?,
        document_uid: row.get(1)?,
        title: row.get(2)?,
        url: row.get(3)?,
        published_at: row.get(4)?,
        source: row.get(5)?,
        category: row.get(6)?,
        subcategory: row.get(7)?,
        region: row.get(8)?,
        locality: row.get(9)?,
        event_object: row.get(10)?,
        event_problem: row.get(11)?,
        excerpt: row.get(12)?,
        official_response: official.map(|value| value != 0),
        score: row.get(14)?,
        preview_image_url: row.get(15)?,
        has_full_text: row.get::<_, i64>(16)? != 0,
        seen_in_runs: row.get(17)?,
    })
}

fn publication_select() -> &'static str {
    r#"
        SELECT
            mi.id,
            d.document_uid,
            d.title,
            d.url,
            d.published_at,
            s.canonical_name,
            mi.category,
            mi.subcategory,
            e.event_region,
            e.event_locality,
            e.event_object,
            e.event_problem,
            d.excerpt,
            mi.official_response,
            mi.score,
            d.preview_image_url,
            CASE WHEN NULLIF(TRIM(d.full_text),'') IS NOT NULL THEN 1 ELSE 0 END AS has_full_text,
            (SELECT COUNT(*) FROM run_items ri2 WHERE ri2.monitor_item_id = mi.id) AS seen_in_runs
        FROM monitor_items mi
        JOIN monitors m ON m.id = mi.monitor_id
        JOIN documents d ON d.id = mi.document_id
        LEFT JOIN sources s ON s.id = d.source_id
        LEFT JOIN event_items ei ON ei.monitor_item_id = mi.id AND ei.relation = 'primary'
        LEFT JOIN events e ON e.id = ei.event_id
    "#
}

fn count_points(
    conn: &Connection,
    sql: &str,
    monitor_key: &str,
    period_days: Option<i64>,
) -> Result<Vec<CountPoint>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| format!("Не удалось подготовить агрегацию: {e}"))?;
    let rows = stmt
        .query_map(params![monitor_key, period_days], |row| {
            Ok(CountPoint { label: row.get(0)?, count: row.get(1)? })
        })
        .map_err(|e| format!("Не удалось выполнить агрегацию: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Не удалось прочитать агрегацию: {e}"))
}


fn topic_trend_points(conn:&Connection,base:&str,monitor_key:&str,period_days:Option<i64>,trend_bucket:&str,categories:&[CountPoint])->Result<Vec<TopicTrendPoint>,String>{let mut result=Vec::new();for category in categories.iter().filter(|i|!i.label.eq_ignore_ascii_case("Без категории")).take(4){let sql=format!("SELECT {trend_bucket} AS bucket, COUNT(DISTINCT mi.id) AS count {base} AND d.published_at IS NOT NULL AND mi.category=?3 GROUP BY bucket ORDER BY bucket");let mut stmt=conn.prepare(&sql).map_err(|e|format!("Не удалось подготовить динамику темы: {e}"))?;let rows=stmt.query_map(params![monitor_key,period_days,category.label.as_str()],|row|Ok(TopicTrendPoint{bucket:row.get(0)?,category:category.label.clone(),count:row.get(1)?})).map_err(|e|format!("Не удалось рассчитать динамику темы: {e}"))?;result.extend(rows.collect::<Result<Vec<_>,_>>().map_err(|e|format!("Не удалось прочитать динамику темы: {e}"))?);}Ok(result)}
fn person_breakdown(conn:&Connection,base:&str,monitor_key:&str,period_days:Option<i64>)->Result<Vec<CountPoint>,String>{
    let entity_base=base.replacen(
        " WHERE ",
        " JOIN document_entities de ON de.document_id=d.id JOIN entities ent ON ent.id=de.entity_id WHERE ",
        1,
    );
    let sql=format!(
        "SELECT ent.display_name AS label, COUNT(DISTINCT mi.id) AS count {entity_base} AND ent.entity_type='person' GROUP BY ent.normalized_name, ent.display_name HAVING COUNT(DISTINCT mi.id)>=2 ORDER BY count DESC, label LIMIT 8"
    );
    count_points(conn,&sql,monitor_key,period_days)
}

fn source_diversity_summary(conn:&Connection,base:&str,monitor_key:&str,period_days:Option<i64>)->Result<SourceDiversitySummary,String>{
    let sql=format!("SELECT COALESCE(NULLIF(TRIM(s.canonical_name),''),'Неизвестный источник') AS label, COUNT(DISTINCT mi.id) AS count {base} GROUP BY label ORDER BY count DESC, label");
    let mut stmt=conn.prepare(&sql).map_err(|e|format!("Не удалось подготовить расчёт разнообразия источников: {e}"))?;
    let rows=stmt.query_map(params![monitor_key,period_days],|row|Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?)))
        .map_err(|e|format!("Не удалось рассчитать разнообразие источников: {e}"))?;
    let mut counts=Vec::new();
    for row in rows{counts.push(row.map_err(|e|format!("Не удалось прочитать доли источников: {e}"))?);}
    let total:i64=counts.iter().map(|(_,count)|*count).sum();
    if total<=0{return Ok(SourceDiversitySummary{active_sources:0,top_source:None,top_source_share:0.0,top_five_share:0.0,diversity_index:0.0,effective_sources:0.0});}
    let total_f=total as f64;
    let shares:Vec<f64>=counts.iter().map(|(_,count)|*count as f64/total_f).collect();
    let hhi: f64=shares.iter().map(|share|share*share).sum();
    let top_source_share=shares.first().copied().unwrap_or(0.0)*100.0;
    let top_five_share=shares.iter().take(5).sum::<f64>()*100.0;
    let diversity_index=(1.0-hhi).clamp(0.0,1.0)*100.0;
    let effective_sources=if hhi>0.0{1.0/hhi}else{0.0};
    Ok(SourceDiversitySummary{
        active_sources:counts.len() as i64,
        top_source:counts.first().map(|(name,_)|name.clone()),
        top_source_share,
        top_five_share,
        diversity_index,
        effective_sources,
    })
}

fn coverage_health_summary(conn:&Connection,monitor_key:&str)->Result<CoverageHealthSummary,String>{
    let latest=conn.query_row(r#"
        SELECT r.id, r.run_number FROM runs r
        JOIN monitors m ON m.id=r.monitor_id
        WHERE m.monitor_key=?1 AND r.dry_run=0
        ORDER BY COALESCE(datetime(r.started_at),datetime(r.imported_at)) DESC, r.id DESC LIMIT 1
    "#,params![monitor_key],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,Option<i64>>(1)?))).optional()
        .map_err(|e|format!("Не удалось определить последний production-запуск: {e}"))?;
    let Some((run_id,run_number))=latest else{return Ok(CoverageHealthSummary{run_number:None,total_sources:0,stable_sources:0,recovery_sources:0,limited_sources:0,attention_sources:0});};
    let mut stmt=conn.prepare(r#"
        SELECT access_status, admission_status, blind_zone_status, endpoint_total, endpoint_ok, endpoint_failed, error
        FROM source_run_metrics WHERE run_id=?1
    "#).map_err(|e|format!("Не удалось подготовить сводку здоровья источников: {e}"))?;
    let rows=stmt.query_map(params![run_id],|row|Ok((
        row.get::<_,Option<String>>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,Option<String>>(2)?,
        row.get::<_,Option<i64>>(3)?,row.get::<_,Option<i64>>(4)?,row.get::<_,Option<i64>>(5)?,row.get::<_,Option<String>>(6)?
    ))).map_err(|e|format!("Не удалось прочитать сводку здоровья источников: {e}"))?;
    let(mut total,mut stable,mut recovery,mut limited,mut attention)=(0,0,0,0,0);
    for row in rows{
        let(access,admission,blind,total_ep,ok_ep,failed_ep,error)=row.map_err(|e|format!("Не удалось прочитать источник в health summary: {e}"))?;
        total+=1;
        let access=access.unwrap_or_default(); let admission=admission.unwrap_or_default(); let blind=blind.unwrap_or_default();
        let has_error=error.as_deref().map(str::trim).is_some_and(|v|!v.is_empty());
        let endpoints_bad=failed_ep.unwrap_or(0)>0 && ok_ep.unwrap_or(0)==0 && total_ep.unwrap_or(0)>0;
        if has_error || endpoints_bad || (!access.is_empty() && access!="healthy_active" && access!="protected_recovery") {attention+=1;}
        else if matches!(admission.as_str(),"soft_admission_limited"|"source_clipped") || blind=="source_clipped" {limited+=1;}
        else if access=="protected_recovery" {recovery+=1;}
        else {stable+=1;}
    }
    Ok(CoverageHealthSummary{run_number,total_sources:total,stable_sources:stable,recovery_sources:recovery,limited_sources:limited,attention_sources:attention})
}

pub fn dashboard_overview(path: &Path, monitor_key: &str, period_days: Option<i64>) -> Result<DashboardOverview, String> {
    let conn = open_database(path)?;
    let period = period_clause("d", "?2");
    let base = format!(
        "FROM monitor_items mi JOIN monitors m ON m.id=mi.monitor_id JOIN documents d ON d.id=mi.document_id LEFT JOIN sources s ON s.id=d.source_id LEFT JOIN event_items ei ON ei.monitor_item_id=mi.id AND ei.relation='primary' LEFT JOIN events e ON e.id=ei.event_id WHERE m.monitor_key=?1 AND {period} AND NOT EXISTS (SELECT 1 FROM moderation_flags mf WHERE mf.monitor_key=m.monitor_key AND mf.document_uid=d.document_uid) AND NOT EXISTS (SELECT 1 FROM moderation_exclusions mx WHERE mx.monitor_key=m.monitor_key AND mx.document_uid=d.document_uid)"
    );

    let scalar = |expr: &str| -> Result<i64, String> {
        conn.query_row(&format!("SELECT {expr} {base}"), params![monitor_key, period_days], |row| row.get(0))
            .map_err(|e| format!("Не удалось рассчитать dashboard KPI: {e}"))
    };

    let publications = scalar("COUNT(DISTINCT mi.id)")?;
    let active_sources = scalar("COUNT(DISTINCT d.source_id)")?;
    let regions = scalar("COUNT(DISTINCT NULLIF(TRIM(e.event_region),''))")?;
    let categories = scalar("COUNT(DISTINCT NULLIF(TRIM(mi.category),''))")?;
    let official_responses = scalar("COUNT(DISTINCT CASE WHEN mi.official_response=1 THEN mi.id END)")?;

    let trend_bucket = if period_days.is_none() || period_days.unwrap_or(0) > 90 {
        "substr(d.published_at,1,7)"
    } else {
        "substr(d.published_at,1,10)"
    };
    let trend_sql = format!(
        "SELECT {trend_bucket} AS label, COUNT(DISTINCT mi.id) AS count {base} AND d.published_at IS NOT NULL GROUP BY label ORDER BY label"
    );
    let trend = count_points(&conn, &trend_sql, monitor_key, period_days)?;

    let category_sql = format!(
        "SELECT COALESCE(NULLIF(TRIM(mi.category),''),'Без категории') AS label, COUNT(DISTINCT mi.id) AS count {base} GROUP BY label ORDER BY count DESC, label LIMIT 12"
    );
    let category_breakdown = count_points(&conn, &category_sql, monitor_key, period_days)?;
    let topic_trend = topic_trend_points(&conn, &base, monitor_key, period_days, trend_bucket, &category_breakdown)?;

    let source_sql = format!(
        "SELECT COALESCE(NULLIF(TRIM(s.canonical_name),''),'Неизвестный источник') AS label, COUNT(DISTINCT mi.id) AS count {base} GROUP BY label ORDER BY count DESC, label LIMIT 16"
    );
    let source_breakdown = count_points(&conn, &source_sql, monitor_key, period_days)?;

    let region_sql = format!(
        "SELECT COALESCE(NULLIF(TRIM(e.event_region),''),'Не определён') AS label, COUNT(DISTINCT mi.id) AS count {base} GROUP BY label ORDER BY count DESC, label LIMIT 12"
    );
    let region_breakdown = count_points(&conn, &region_sql, monitor_key, period_days)?;
    let concept_sql = format!("SELECT COALESCE(NULLIF(TRIM(e.event_object),''), NULLIF(TRIM(mi.subcategory),'')) AS label, COUNT(DISTINCT mi.id) AS count {base} AND COALESCE(NULLIF(TRIM(e.event_object),''), NULLIF(TRIM(mi.subcategory),'')) IS NOT NULL GROUP BY label ORDER BY count DESC, label LIMIT 12");
    let concept_breakdown = count_points(&conn, &concept_sql, monitor_key, period_days)?;
    let person_breakdown = person_breakdown(&conn, &base, monitor_key, period_days)?;

    // SEP dashboard: prefer stories with explicit cross-media coverage.
    // A primary publication + at least one `also_covered_by`/echo source is
    // already a multi-outlet story. Moderation flags/exclusions are omitted
    // because flagged material must not influence analytical blocks.
    let resonance_sql = format!(
        "{} WHERE m.monitor_key=?1 AND {} \
         AND NOT EXISTS (SELECT 1 FROM moderation_flags mf WHERE mf.monitor_key=m.monitor_key AND mf.document_uid=d.document_uid) \
         AND NOT EXISTS (SELECT 1 FROM moderation_exclusions mx WHERE mx.monitor_key=m.monitor_key AND mx.document_uid=d.document_uid) \
         AND EXISTS (SELECT 1 FROM run_items ri WHERE ri.monitor_item_id=mi.id AND (\
             NULLIF(TRIM(ri.also_covered_by),'') IS NOT NULL OR \
             NULLIF(TRIM(ri.event_echo_sources),'') IS NOT NULL OR \
             LOWER(COALESCE(ri.event_echo,'')) IN ('1','true','yes')\
         )) \
         ORDER BY (SELECT COUNT(*) FROM run_items ri2 WHERE ri2.monitor_item_id=mi.id AND (\
             NULLIF(TRIM(ri2.also_covered_by),'') IS NOT NULL OR \
             NULLIF(TRIM(ri2.event_echo_sources),'') IS NOT NULL OR \
             LOWER(COALESCE(ri2.event_echo,'')) IN ('1','true','yes')\
         )) DESC, COALESCE(mi.score,0) DESC, \
         COALESCE(datetime(d.published_at),datetime(d.last_seen_at),datetime(d.first_seen_at)) DESC, mi.id DESC LIMIT 4",
        publication_select(), period
    );
    let mut resonance_stmt = conn.prepare(&resonance_sql).map_err(|e| format!("Не удалось подготовить резонансные сюжеты: {e}"))?;
    let resonance_rows = resonance_stmt.query_map(params![monitor_key, period_days], publication_row)
        .map_err(|e| format!("Не удалось прочитать резонансные сюжеты: {e}"))?;
    let mut resonance_items = resonance_rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Не удалось собрать резонансные сюжеты: {e}"))?;
    let resonance_fallback = resonance_items.is_empty();
    if resonance_fallback {
        let fallback_sql = format!(
            "{} WHERE m.monitor_key=?1 AND {} \
             AND NOT EXISTS (SELECT 1 FROM moderation_flags mf WHERE mf.monitor_key=m.monitor_key AND mf.document_uid=d.document_uid) \
             AND NOT EXISTS (SELECT 1 FROM moderation_exclusions mx WHERE mx.monitor_key=m.monitor_key AND mx.document_uid=d.document_uid) \
             ORDER BY COALESCE(mi.score,0) DESC, \
             COALESCE(datetime(d.published_at),datetime(d.last_seen_at),datetime(d.first_seen_at)) DESC, mi.id DESC LIMIT 4",
            publication_select(), period
        );
        let mut fallback_stmt = conn.prepare(&fallback_sql).map_err(|e| format!("Не удалось подготовить fallback резонансных сюжетов: {e}"))?;
        let fallback_rows = fallback_stmt.query_map(params![monitor_key, period_days], publication_row)
            .map_err(|e| format!("Не удалось прочитать fallback резонансных сюжетов: {e}"))?;
        resonance_items = fallback_rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Не удалось собрать fallback резонансных сюжетов: {e}"))?;
    }

    let source_diversity = source_diversity_summary(&conn, &base, monitor_key, period_days)?;
    let coverage_health = coverage_health_summary(&conn, monitor_key)?;

    let visuals_sql = format!(
        "{} WHERE m.monitor_key=?1 AND {} AND NOT EXISTS (SELECT 1 FROM moderation_flags mf WHERE mf.monitor_key=m.monitor_key AND mf.document_uid=d.document_uid) AND NOT EXISTS (SELECT 1 FROM moderation_exclusions mx WHERE mx.monitor_key=m.monitor_key AND mx.document_uid=d.document_uid) AND NULLIF(TRIM(d.preview_image_url),'') IS NOT NULL ORDER BY COALESCE(datetime(d.published_at), datetime(d.last_seen_at), datetime(d.first_seen_at)) DESC, mi.id DESC LIMIT 4",
        publication_select(), period
    );
    let mut visuals_stmt = conn.prepare(&visuals_sql).map_err(|e| format!("Не удалось подготовить визуальные материалы: {e}"))?;
    let visuals_rows = visuals_stmt.query_map(params![monitor_key, period_days], publication_row)
        .map_err(|e| format!("Не удалось прочитать визуальные материалы: {e}"))?;
    let visuals = visuals_rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Не удалось собрать визуальные материалы: {e}"))?;

    let recent_sql = format!(
        "{} WHERE m.monitor_key=?1 AND {} AND NOT EXISTS (SELECT 1 FROM moderation_exclusions mx WHERE mx.monitor_key=m.monitor_key AND mx.document_uid=d.document_uid) ORDER BY COALESCE(datetime(d.published_at), datetime(d.last_seen_at), datetime(d.first_seen_at)) DESC, mi.id DESC LIMIT 8",
        publication_select(), period
    );
    let mut recent_stmt = conn.prepare(&recent_sql).map_err(|e| format!("Не удалось подготовить последние публикации: {e}"))?;
    let recent_rows = recent_stmt.query_map(params![monitor_key, period_days], publication_row)
        .map_err(|e| format!("Не удалось прочитать последние публикации: {e}"))?;
    let recent = recent_rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Не удалось собрать последние публикации: {e}"))?;

    Ok(DashboardOverview {
        period_days,
        publications,
        active_sources,
        regions,
        categories,
        official_responses,
        trend,
        topic_trend,
        category_breakdown,
        source_breakdown,
        region_breakdown,
        concept_breakdown,
        person_breakdown,
        resonance_items,
        resonance_fallback,
        source_diversity,
        coverage_health,
        visuals,
        recent,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn list_publications(
    path: &Path,
    monitor_key: &str,
    query: &str,
    period_days: Option<i64>,
    category: &str,
    region: &str,
    source: &str,
    sources: &[String],
    sort: &str,
    limit: i64,
    offset: i64,
) -> Result<ArchivePage, String> {
    let conn = open_database(path)?;
    let safe_limit = limit.clamp(1, 200);
    let safe_offset = offset.max(0);
    let order = match sort {
        "oldest" => "COALESCE(datetime(d.published_at), datetime(d.first_seen_at)) ASC, mi.id ASC",
        "score" => "COALESCE(mi.score, 0) DESC, COALESCE(datetime(d.published_at), datetime(d.first_seen_at)) DESC",
        _ => "COALESCE(datetime(d.published_at), datetime(d.last_seen_at), datetime(d.first_seen_at)) DESC, mi.id DESC",
    };
    let period = period_clause("d", "?2");
    let selected_sources: Vec<String> = if sources.is_empty() {
        if source.trim().is_empty() { Vec::new() } else { vec![source.trim().to_string()] }
    } else {
        let mut unique = HashSet::new();
        sources.iter().filter_map(|value| {
            let value = value.trim();
            (!value.is_empty() && unique.insert(value.to_string())).then(|| value.to_string())
        }).take(200).collect()
    };
    let source_filter = if selected_sources.is_empty() {
        "1=1".to_string()
    } else {
        let placeholders = (6..6 + selected_sources.len()).map(|index| format!("?{index}")).collect::<Vec<_>>().join(", ");
        format!("s.canonical_name IN ({placeholders})")
    };
    let filters = format!(
        r#"
        m.monitor_key=?1
        AND {period}
        AND (?3='' OR
             d.title LIKE '%' || ?3 || '%' OR
             COALESCE(d.excerpt,'') LIKE '%' || ?3 || '%' OR
             COALESCE(s.canonical_name,'') LIKE '%' || ?3 || '%' OR
             COALESCE(mi.category,'') LIKE '%' || ?3 || '%' OR
             COALESCE(mi.subcategory,'') LIKE '%' || ?3 || '%' OR
             COALESCE(mi.matched_terms,'') LIKE '%' || ?3 || '%' OR
             COALESCE(e.event_region,'') LIKE '%' || ?3 || '%' OR
             COALESCE(e.event_locality,'') LIKE '%' || ?3 || '%' OR
             COALESCE(e.event_object,'') LIKE '%' || ?3 || '%' OR
             COALESCE(e.event_problem,'') LIKE '%' || ?3 || '%')
        AND (?4='' OR mi.category=?4)
        AND (?5='' OR e.event_region=?5)
        AND {source_filter}
        AND NOT EXISTS (SELECT 1 FROM moderation_exclusions mx WHERE mx.monitor_key=m.monitor_key AND mx.document_uid=d.document_uid)
        "#
    );

    let from = r#"
        FROM monitor_items mi
        JOIN monitors m ON m.id=mi.monitor_id
        JOIN documents d ON d.id=mi.document_id
        LEFT JOIN sources s ON s.id=d.source_id
        LEFT JOIN event_items ei ON ei.monitor_item_id=mi.id AND ei.relation='primary'
        LEFT JOIN events e ON e.id=ei.event_id
    "#;

    let mut filter_values = vec![
        Value::Text(monitor_key.to_string()),
        period_days.map(Value::Integer).unwrap_or(Value::Null),
        Value::Text(query.trim().to_string()),
        Value::Text(category.to_string()),
        Value::Text(region.to_string()),
    ];
    filter_values.extend(selected_sources.iter().cloned().map(Value::Text));

    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(DISTINCT mi.id) {from} WHERE {filters}"),
        params_from_iter(filter_values.iter()),
        |row| row.get(0),
    ).map_err(|e| format!("Не удалось посчитать результаты архива: {e}"))?;

    let sql = format!(
        "{} WHERE {} ORDER BY {} LIMIT ?{} OFFSET ?{}",
        publication_select(), filters, order, filter_values.len() + 1, filter_values.len() + 2
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("Не удалось подготовить архив: {e}"))?;
    let mut page_values = filter_values;
    page_values.push(Value::Integer(safe_limit));
    page_values.push(Value::Integer(safe_offset));
    let rows = stmt.query_map(
        params_from_iter(page_values.iter()),
        publication_row,
    ).map_err(|e| format!("Не удалось выполнить запрос архива: {e}"))?;
    let items = rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Не удалось прочитать архив: {e}"))?;

    Ok(ArchivePage { total, items })
}

/// Returns the publications represented by one point in the 3D topic trend.
/// `bucket` is deliberately restricted to the ISO day/month values that the
/// dashboard itself produces, rather than being interpolated into SQL.
pub fn list_topic_bucket_publications(
    path: &Path,
    monitor_key: &str,
    category: &str,
    bucket: &str,
    limit: i64,
) -> Result<Vec<PublicationSummary>, String> {
    let bucket = bucket.trim();
    let is_month = bucket.len() == 7
        && bucket.as_bytes().get(4) == Some(&b'-')
        && bucket.chars().enumerate().all(|(index, ch)| index == 4 || ch.is_ascii_digit());
    let is_day = bucket.len() == 10
        && bucket.as_bytes().get(4) == Some(&b'-')
        && bucket.as_bytes().get(7) == Some(&b'-')
        && bucket.chars().enumerate().all(|(index, ch)| index == 4 || index == 7 || ch.is_ascii_digit());
    if !is_month && !is_day {
        return Err("Некорректный период точки динамики".to_string());
    }

    let conn = open_database(path)?;
    let prefix_length = if is_day { 10 } else { 7 };
    let safe_limit = limit.clamp(1, 12);
    let filters = r#"
        m.monitor_key=?1
        AND mi.category=?2
        AND substr(d.published_at,1,?3)=?4
        AND NOT EXISTS (SELECT 1 FROM moderation_exclusions mx WHERE mx.monitor_key=m.monitor_key AND mx.document_uid=d.document_uid)
    "#;
    let sql = format!(
        "{} WHERE {} ORDER BY COALESCE(datetime(d.published_at), datetime(d.last_seen_at), datetime(d.first_seen_at)) DESC, mi.id DESC LIMIT ?5",
        publication_select(),
        filters,
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("Не удалось подготовить публикации точки динамики: {e}"))?;
    let rows = stmt.query_map(
        params![monitor_key, category.trim(), prefix_length, bucket, safe_limit],
        publication_row,
    ).map_err(|e| format!("Не удалось получить публикации точки динамики: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Не удалось прочитать публикации точки динамики: {e}"))
}

fn string_list(conn: &Connection, sql: &str, monitor_key: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| format!("Не удалось подготовить список фильтра: {e}"))?;
    let rows = stmt.query_map(params![monitor_key], |row| row.get(0)).map_err(|e| format!("Не удалось получить фильтр: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Не удалось прочитать фильтр: {e}"))
}

pub fn archive_facets(path: &Path, monitor_key: &str) -> Result<ArchiveFacets, String> {
    let conn = open_database(path)?;
    let categories = string_list(&conn,
        "SELECT DISTINCT mi.category FROM monitor_items mi JOIN monitors m ON m.id=mi.monitor_id JOIN documents d ON d.id=mi.document_id WHERE m.monitor_key=?1 AND mi.category IS NOT NULL AND TRIM(mi.category)<>'' AND NOT EXISTS (SELECT 1 FROM moderation_exclusions mx WHERE mx.monitor_key=m.monitor_key AND mx.document_uid=d.document_uid) ORDER BY mi.category",
        monitor_key)?;
    let regions = string_list(&conn,
        "SELECT DISTINCT e.event_region FROM events e JOIN monitors m ON m.id=e.monitor_id JOIN event_items ei ON ei.event_id=e.id JOIN monitor_items mi ON mi.id=ei.monitor_item_id JOIN documents d ON d.id=mi.document_id WHERE m.monitor_key=?1 AND e.event_region IS NOT NULL AND TRIM(e.event_region)<>'' AND NOT EXISTS (SELECT 1 FROM moderation_exclusions mx WHERE mx.monitor_key=m.monitor_key AND mx.document_uid=d.document_uid) ORDER BY e.event_region",
        monitor_key)?;
    let sources = string_list(&conn,
        "SELECT DISTINCT s.canonical_name FROM sources s WHERE EXISTS (SELECT 1 FROM documents d JOIN monitor_items mi ON mi.document_id=d.id JOIN monitors m ON m.id=mi.monitor_id WHERE d.source_id=s.id AND m.monitor_key=?1 AND NOT EXISTS (SELECT 1 FROM moderation_exclusions mx WHERE mx.monitor_key=m.monitor_key AND mx.document_uid=d.document_uid)) ORDER BY s.canonical_name",
        monitor_key)?;
    Ok(ArchiveFacets { categories, regions, sources })
}

pub fn list_sources(path: &Path, monitor_key: &str, period_days: Option<i64>) -> Result<Vec<SourceSummary>, String> {
    let conn = open_database(path)?;
    let sql = r#"
        SELECT
            s.id,
            s.canonical_name,
            s.domain,
            s.source_type,
            s.configured_region,
            s.configured_locality,
            s.priority,
            (SELECT COUNT(DISTINCT mi.document_id)
               FROM documents d
               JOIN monitor_items mi ON mi.document_id=d.id
               JOIN monitors m ON m.id=mi.monitor_id
              WHERE d.source_id=s.id AND m.monitor_key=?1
                AND (?2 IS NULL OR (d.published_at IS NOT NULL AND datetime(d.published_at) >= datetime('now', '-' || ?2 || ' days')))
                AND NOT EXISTS (SELECT 1 FROM moderation_flags mf WHERE mf.monitor_key=m.monitor_key AND mf.document_uid=d.document_uid)
                AND NOT EXISTS (SELECT 1 FROM moderation_exclusions mx WHERE mx.monitor_key=m.monitor_key AND mx.document_uid=d.document_uid)) AS publications,
            COALESCE((SELECT SUM(COALESCE(srm.results,0))
               FROM source_run_metrics srm
               JOIN runs r ON r.id=srm.run_id
               JOIN monitors m ON m.id=r.monitor_id
              WHERE srm.source_id=s.id AND m.monitor_key=?1
                AND (?2 IS NULL OR datetime(COALESCE(r.started_at,r.imported_at)) >= datetime('now', '-' || ?2 || ' days'))),0) AS total_results,
            (SELECT MAX(d.published_at) FROM documents d
              WHERE d.source_id=s.id
                AND (?2 IS NULL OR (d.published_at IS NOT NULL AND datetime(d.published_at) >= datetime('now', '-' || ?2 || ' days')))) AS last_seen_at,
            (SELECT srm.access_status
               FROM source_run_metrics srm
               JOIN runs r ON r.id=srm.run_id
               JOIN monitors m ON m.id=r.monitor_id
              WHERE srm.source_id=s.id AND m.monitor_key=?1
                AND (?2 IS NULL OR datetime(COALESCE(r.started_at,r.imported_at)) >= datetime('now', '-' || ?2 || ' days'))
              ORDER BY COALESCE(r.started_at,r.imported_at) DESC, r.id DESC LIMIT 1) AS access_status,
            (SELECT srm.admission_status
               FROM source_run_metrics srm
               JOIN runs r ON r.id=srm.run_id
               JOIN monitors m ON m.id=r.monitor_id
              WHERE srm.source_id=s.id AND m.monitor_key=?1
                AND (?2 IS NULL OR datetime(COALESCE(r.started_at,r.imported_at)) >= datetime('now', '-' || ?2 || ' days'))
              ORDER BY COALESCE(r.started_at,r.imported_at) DESC, r.id DESC LIMIT 1) AS admission_status
        FROM sources s
        WHERE EXISTS (
            SELECT 1
            FROM source_run_metrics srm
            WHERE srm.source_id=s.id
              AND srm.run_id=COALESCE(
                  (
                    SELECT r.id FROM runs r JOIN monitors m ON m.id=r.monitor_id
                    WHERE m.monitor_key=?1 AND r.dry_run=0
                    ORDER BY COALESCE(r.started_at,r.imported_at) DESC, r.id DESC LIMIT 1
                  ),
                  (
                    SELECT r.id FROM runs r JOIN monitors m ON m.id=r.monitor_id
                    WHERE m.monitor_key=?1
                    ORDER BY COALESCE(r.started_at,r.imported_at) DESC, r.id DESC LIMIT 1
                  )
              )
        )
        ORDER BY LOWER(s.canonical_name), s.id
    "#;
    let mut stmt = conn.prepare(sql).map_err(|e| format!("Не удалось подготовить каталог источников: {e}"))?;
    let rows = stmt.query_map(params![monitor_key, period_days], |row| {
        Ok(SourceSummary {
            id: row.get(0)?,
            name: row.get(1)?,
            domain: row.get(2)?,
            source_type: row.get(3)?,
            region: row.get(4)?,
            locality: row.get(5)?,
            priority: row.get(6)?,
            publications: row.get(7)?,
            total_results: row.get(8)?,
            last_seen_at: row.get(9)?,
            access_status: row.get(10)?,
            admission_status: row.get(11)?,
        })
    }).map_err(|e| format!("Не удалось получить каталог источников: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Не удалось прочитать источник: {e}"))
}

pub fn editorial_source(path: &Path, monitor_key: &str, document_uid: &str) -> Result<Option<EditorialSource>, String> {
    let conn = open_database(path)?;
    let document = conn.query_row(
        r#"
        SELECT d.id, d.document_uid, d.title, d.url, COALESCE(s.canonical_name,''),
               d.full_text, d.full_text_sha256, d.full_text_quality,
               d.full_text_extraction_strategy, d.full_text_transport
        FROM documents d
        JOIN monitor_items mi ON mi.document_id=d.id
        JOIN monitors m ON m.id=mi.monitor_id
        LEFT JOIN sources s ON s.id=d.source_id
        WHERE m.monitor_key=?1 AND d.document_uid=?2
          AND NOT EXISTS (SELECT 1 FROM moderation_exclusions mx WHERE mx.monitor_key=m.monitor_key AND mx.document_uid=d.document_uid)
        LIMIT 1
        "#,
        params![monitor_key, document_uid],
        |row| Ok((
            row.get::<_,i64>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?,
            row.get::<_,String>(3)?, row.get::<_,String>(4)?, row.get::<_,Option<String>>(5)?,
            row.get::<_,Option<String>>(6)?, row.get::<_,Option<String>>(7)?,
            row.get::<_,Option<String>>(8)?, row.get::<_,Option<String>>(9)?,
        )),
    ).optional().map_err(|e| format!("Не удалось прочитать редакционный источник: {e}"))?;
    let Some((document_id, document_uid, title, url, source, full_text, text_sha256, quality, extraction_strategy, transport)) = document else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(
        r#"
        SELECT ent.entity_type, ent.display_name, de.surface_form, de.confidence, de.mentions, de.method
        FROM document_entities de
        JOIN entities ent ON ent.id=de.entity_id
        WHERE de.document_id=?1
        ORDER BY ent.entity_type, de.mentions DESC, ent.display_name
        "#
    ).map_err(|e| format!("Не удалось подготовить сущности публикации: {e}"))?;
    let rows = stmt.query_map(params![document_id], |row| Ok(EditorialEntity {
        entity_type: row.get(0)?, name: row.get(1)?, surface_form: row.get(2)?,
        confidence: row.get(3)?, mentions: row.get(4)?, method: row.get(5)?,
    })).map_err(|e| format!("Не удалось прочитать сущности публикации: {e}"))?;
    let entities = rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Не удалось собрать сущности публикации: {e}"))?;
    Ok(Some(EditorialSource {
        document_uid, title, url, source, full_text, text_sha256, quality,
        extraction_strategy, transport, entities,
    }))
}

pub fn replace_moderation_snapshot(
    path: &Path,
    monitor_key: &str,
    flags: &[ModerationFlagInput],
    exclusions: &[ModerationExclusionInput],
) -> Result<(), String> {
    let conn = open_database(path)?;
    let tx = conn.unchecked_transaction().map_err(|e| format!("Не удалось начать синхронизацию модерации: {e}"))?;
    tx.execute("DELETE FROM moderation_flags WHERE monitor_key=?1", params![monitor_key])
        .map_err(|e| format!("Не удалось очистить локальные флаги модерации: {e}"))?;
    tx.execute("DELETE FROM moderation_exclusions WHERE monitor_key=?1", params![monitor_key])
        .map_err(|e| format!("Не удалось очистить локальные исключения модерации: {e}"))?;
    for flag in flags {
        tx.execute(
            "INSERT OR REPLACE INTO moderation_flags(monitor_key,document_uid,user_id,user_name,flagged_at) VALUES (?1,?2,?3,?4,?5)",
            params![monitor_key, flag.document_uid, flag.user_id, flag.user_name, flag.flagged_at],
        ).map_err(|e| format!("Не удалось сохранить локальный флаг модерации: {e}"))?;
    }
    for exclusion in exclusions {
        tx.execute(
            "INSERT OR REPLACE INTO moderation_exclusions(monitor_key,document_uid,excluded_by_name,excluded_at) VALUES (?1,?2,?3,?4)",
            params![monitor_key, exclusion.document_uid, exclusion.excluded_by_name, exclusion.excluded_at],
        ).map_err(|e| format!("Не удалось сохранить локальное исключение модерации: {e}"))?;
    }
    tx.commit().map_err(|e| format!("Не удалось завершить синхронизацию модерации: {e}"))?;
    Ok(())
}


pub fn get_app_setting(path: &Path, key: &str) -> Result<Option<String>, String> {
    let conn = open_database(path)?;
    conn.query_row(
        "SELECT value FROM app_settings WHERE key=?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("Не удалось прочитать настройку {key}: {e}"))
}

pub fn set_app_setting(path: &Path, key: &str, value: &str) -> Result<(), String> {
    let conn = open_database(path)?;
    conn.execute(
        r#"
        INSERT INTO app_settings(key,value,updated_at) VALUES (?1,?2,CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
        "#,
        params![key, value],
    )
    .map_err(|e| format!("Не удалось сохранить настройку {key}: {e}"))?;
    Ok(())
}

pub fn delete_app_setting(path: &Path, key: &str) -> Result<(), String> {
    let conn = open_database(path)?;
    conn.execute("DELETE FROM app_settings WHERE key=?1", params![key])
        .map_err(|e| format!("Не удалось удалить настройку {key}: {e}"))?;
    Ok(())
}

pub fn sync_skipped_run_numbers(path: &Path, monitor_key: &str) -> Result<HashSet<i64>, String> {
    let conn = open_database(path)?;
    let mut stmt = conn
        .prepare("SELECT run_number FROM sync_run_status WHERE monitor_key=?1 AND status='dry_run'")
        .map_err(|e| format!("Не удалось подготовить sync status: {e}"))?;
    let rows = stmt
        .query_map(params![monitor_key], |row| row.get::<_, i64>(0))
        .map_err(|e| format!("Не удалось прочитать sync status: {e}"))?;
    rows.collect::<Result<HashSet<_>, _>>()
        .map_err(|e| format!("Не удалось собрать sync status: {e}"))
}

pub fn mark_sync_dry_run(path: &Path, monitor_key: &str, run_number: i64, artifact_id: u64) -> Result<(), String> {
    let conn = open_database(path)?;
    conn.execute(
        r#"
        INSERT INTO sync_run_status(monitor_key, run_number, status, artifact_id, updated_at)
        VALUES (?1,?2,'dry_run',?3,CURRENT_TIMESTAMP)
        ON CONFLICT(monitor_key, run_number) DO UPDATE SET
            status='dry_run', artifact_id=excluded.artifact_id, updated_at=CURRENT_TIMESTAMP
        "#,
        params![monitor_key, run_number, artifact_id as i64],
    )
    .map_err(|e| format!("Не удалось сохранить dry-run sync status: {e}"))?;
    Ok(())
}
