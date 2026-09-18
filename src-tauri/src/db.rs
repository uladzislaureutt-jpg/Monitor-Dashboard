use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use std::fs;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::models::{
    ArchiveFacets, ArchivePage, CountPoint, DashboardOverview, DatabaseStats,
    PublicationSummary, RunSummary, SourceSummary, TopicTrendPoint,
};

const MIGRATION_0001: &str = include_str!("../migrations/0001_init.sql");
const MIGRATION_0002: &str = include_str!("../migrations/0002_sync.sql");
const MIGRATION_0003: &str = include_str!("../migrations/0003_preview_images.sql");

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

fn period_clause(alias: &str, parameter: &str) -> String {
    format!(
        "({parameter} IS NULL OR ({alias}.published_at IS NOT NULL AND datetime({alias}.published_at) >= datetime('now', '-' || {parameter} || ' days')))"
    )
}

fn publication_row(row: &Row<'_>) -> rusqlite::Result<PublicationSummary> {
    let official: Option<i64> = row.get(12)?;
    Ok(PublicationSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        url: row.get(2)?,
        published_at: row.get(3)?,
        source: row.get(4)?,
        category: row.get(5)?,
        subcategory: row.get(6)?,
        region: row.get(7)?,
        locality: row.get(8)?,
        event_object: row.get(9)?,
        event_problem: row.get(10)?,
        excerpt: row.get(11)?,
        official_response: official.map(|value| value != 0),
        score: row.get(13)?,
        preview_image_url: row.get(14)?,
        seen_in_runs: row.get(15)?,
    })
}

fn publication_select() -> &'static str {
    r#"
        SELECT
            mi.id,
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
fn person_regex()->&'static Regex{static PERSON_RE:OnceLock<Regex>=OnceLock::new();PERSON_RE.get_or_init(||Regex::new(r"(?u)\b([А-ЯЁІЎ][а-яёіў'’-]{2,})\s+([А-ЯЁІЎ][а-яёіў'’-]{2,})(?:\s+([А-ЯЁІЎ][а-яёіў'’-]{2,}))?\b").expect("valid person regex"))}
fn plausible_person(candidate:&str)->bool{let lower=candidate.to_lowercase();let blocked=["область","обласць","вобласць","район","раён","улица","вуліца","проспект","совет","савет","комитет","камітэт","министерство","міністэрства","суд","больница","бальніца","поликлиника","паліклініка","беларусь","минск","мінск","жители","жыхары","власти","улады","красный крест","чырвоны крыж","белая русь"];if blocked.iter().any(|word|lower.contains(word)){return false;}let first=lower.split_whitespace().next().unwrap_or("");let endings=["ский","ская","ское","ской","ские","цкі","цкая","цкае","скія","ая","ый","ий"];!endings.iter().any(|ending|first.ends_with(ending))}
fn person_breakdown(conn:&Connection,base:&str,monitor_key:&str,period_days:Option<i64>)->Result<Vec<CountPoint>,String>{let sql=format!("SELECT mi.id, d.title, COALESCE(d.excerpt,'') {base}");let mut stmt=conn.prepare(&sql).map_err(|e|format!("Не удалось подготовить извлечение персоналий: {e}"))?;let rows=stmt.query_map(params![monitor_key,period_days],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?))).map_err(|e|format!("Не удалось прочитать тексты для персоналий: {e}"))?;let mut counts:HashMap<String,i64>=HashMap::new();for row in rows{let(_,title,excerpt)=row.map_err(|e|format!("Не удалось прочитать строку для персоналий: {e}"))?;let text=format!("{title}. {excerpt}");let mut seen=HashSet::new();for caps in person_regex().captures_iter(&text){let c=caps.get(0).map(|m|m.as_str().trim()).unwrap_or("");if !c.is_empty()&&plausible_person(c){seen.insert(c.to_string());}}for c in seen{*counts.entry(c).or_insert(0)+=1;}}let mut items:Vec<CountPoint>=counts.into_iter().filter(|(_,count)|*count>=2).map(|(label,count)|CountPoint{label,count}).collect();items.sort_by(|a,b|b.count.cmp(&a.count).then_with(||a.label.cmp(&b.label)));items.truncate(8);Ok(items)}

pub fn dashboard_overview(path: &Path, monitor_key: &str, period_days: Option<i64>) -> Result<DashboardOverview, String> {
    let conn = open_database(path)?;
    let period = period_clause("d", "?2");
    let base = format!(
        "FROM monitor_items mi JOIN monitors m ON m.id=mi.monitor_id JOIN documents d ON d.id=mi.document_id LEFT JOIN sources s ON s.id=d.source_id LEFT JOIN event_items ei ON ei.monitor_item_id=mi.id AND ei.relation='primary' LEFT JOIN events e ON e.id=ei.event_id WHERE m.monitor_key=?1 AND {period}"
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

    let visuals_sql = format!(
        "{} WHERE m.monitor_key=?1 AND {} AND NULLIF(TRIM(d.preview_image_url),'') IS NOT NULL ORDER BY COALESCE(datetime(d.published_at), datetime(d.last_seen_at), datetime(d.first_seen_at)) DESC, mi.id DESC LIMIT 4",
        publication_select(), period
    );
    let mut visuals_stmt = conn.prepare(&visuals_sql).map_err(|e| format!("Не удалось подготовить визуальные материалы: {e}"))?;
    let visuals_rows = visuals_stmt.query_map(params![monitor_key, period_days], publication_row)
        .map_err(|e| format!("Не удалось прочитать визуальные материалы: {e}"))?;
    let visuals = visuals_rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Не удалось собрать визуальные материалы: {e}"))?;

    let recent_sql = format!(
        "{} WHERE m.monitor_key=?1 AND {} ORDER BY COALESCE(datetime(d.published_at), datetime(d.last_seen_at), datetime(d.first_seen_at)) DESC, mi.id DESC LIMIT 8",
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
        AND (?6='' OR s.canonical_name=?6)
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

    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(DISTINCT mi.id) {from} WHERE {filters}"),
        params![monitor_key, period_days, query.trim(), category, region, source],
        |row| row.get(0),
    ).map_err(|e| format!("Не удалось посчитать результаты архива: {e}"))?;

    let sql = format!(
        "{} WHERE {} ORDER BY {} LIMIT ?7 OFFSET ?8",
        publication_select(), filters, order
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("Не удалось подготовить архив: {e}"))?;
    let rows = stmt.query_map(
        params![monitor_key, period_days, query.trim(), category, region, source, safe_limit, safe_offset],
        publication_row,
    ).map_err(|e| format!("Не удалось выполнить запрос архива: {e}"))?;
    let items = rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Не удалось прочитать архив: {e}"))?;

    Ok(ArchivePage { total, items })
}

fn string_list(conn: &Connection, sql: &str, monitor_key: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| format!("Не удалось подготовить список фильтра: {e}"))?;
    let rows = stmt.query_map(params![monitor_key], |row| row.get(0)).map_err(|e| format!("Не удалось получить фильтр: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Не удалось прочитать фильтр: {e}"))
}

pub fn archive_facets(path: &Path, monitor_key: &str) -> Result<ArchiveFacets, String> {
    let conn = open_database(path)?;
    let categories = string_list(&conn,
        "SELECT DISTINCT mi.category FROM monitor_items mi JOIN monitors m ON m.id=mi.monitor_id WHERE m.monitor_key=?1 AND mi.category IS NOT NULL AND TRIM(mi.category)<>'' ORDER BY mi.category",
        monitor_key)?;
    let regions = string_list(&conn,
        "SELECT DISTINCT e.event_region FROM events e JOIN monitors m ON m.id=e.monitor_id WHERE m.monitor_key=?1 AND e.event_region IS NOT NULL AND TRIM(e.event_region)<>'' ORDER BY e.event_region",
        monitor_key)?;
    let sources = string_list(&conn,
        "SELECT DISTINCT s.canonical_name FROM sources s WHERE EXISTS (SELECT 1 FROM documents d JOIN monitor_items mi ON mi.document_id=d.id JOIN monitors m ON m.id=mi.monitor_id WHERE d.source_id=s.id AND m.monitor_key=?1) ORDER BY s.canonical_name",
        monitor_key)?;
    Ok(ArchiveFacets { categories, regions, sources })
}

pub fn list_sources(path: &Path, monitor_key: &str) -> Result<Vec<SourceSummary>, String> {
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
              WHERE d.source_id=s.id AND m.monitor_key=?1) AS publications,
            COALESCE((SELECT SUM(COALESCE(srm.results,0))
               FROM source_run_metrics srm
               JOIN runs r ON r.id=srm.run_id
               JOIN monitors m ON m.id=r.monitor_id
              WHERE srm.source_id=s.id AND m.monitor_key=?1),0) AS total_results,
            (SELECT MAX(d.published_at) FROM documents d WHERE d.source_id=s.id) AS last_seen_at,
            (SELECT srm.access_status
               FROM source_run_metrics srm
               JOIN runs r ON r.id=srm.run_id
               JOIN monitors m ON m.id=r.monitor_id
              WHERE srm.source_id=s.id AND m.monitor_key=?1
              ORDER BY COALESCE(r.started_at,r.imported_at) DESC, r.id DESC LIMIT 1) AS access_status,
            (SELECT srm.admission_status
               FROM source_run_metrics srm
               JOIN runs r ON r.id=srm.run_id
               JOIN monitors m ON m.id=r.monitor_id
              WHERE srm.source_id=s.id AND m.monitor_key=?1
              ORDER BY COALESCE(r.started_at,r.imported_at) DESC, r.id DESC LIMIT 1) AS admission_status
        FROM sources s
        WHERE EXISTS (
            SELECT 1 FROM source_run_metrics srm JOIN runs r ON r.id=srm.run_id JOIN monitors m ON m.id=r.monitor_id
            WHERE srm.source_id=s.id AND m.monitor_key=?1
        ) OR EXISTS (
            SELECT 1 FROM documents d JOIN monitor_items mi ON mi.document_id=d.id JOIN monitors m ON m.id=mi.monitor_id
            WHERE d.source_id=s.id AND m.monitor_key=?1
        )
        ORDER BY LOWER(s.canonical_name), s.id
    "#;
    let mut stmt = conn.prepare(sql).map_err(|e| format!("Не удалось подготовить каталог источников: {e}"))?;
    let rows = stmt.query_map(params![monitor_key], |row| {
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
