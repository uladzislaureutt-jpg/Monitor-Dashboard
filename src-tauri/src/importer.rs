use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Seek};
use std::path::Path;

use jsonschema::validator_for;
use rusqlite::{Connection, Transaction, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::db::{existing_run, open_database};
use crate::models::{ImportResult, Manifest, PublicationRecord};

const MAX_INPUT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 128 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES: usize = 4 * 1024 * 1024;
const MANIFEST_SCHEMA: &str = include_str!("../schemas/manifest-0.1.schema.json");
const PUBLICATION_SCHEMA: &str = include_str!("../schemas/publication-0.1.schema.json");
const SOURCE_METRICS_SCHEMA: &str = include_str!("../schemas/source-metrics-0.1.schema.json");
const RUN_METRICS_SCHEMA: &str = include_str!("../schemas/run-metrics-0.1.schema.json");


#[derive(Debug)]
pub struct BundleInspection {
    pub monitor_key: String,
    pub run_number: Option<i64>,
    pub dry_run: Option<bool>,
}

pub fn inspect_bundle(input_path: &Path) -> Result<BundleInspection, String> {
    let metadata = fs::metadata(input_path)
        .map_err(|e| format!("Не удалось открыть ZIP: {e}"))?;
    if metadata.len() > MAX_INPUT_BYTES {
        return Err(format!("ZIP слишком велик: {} МБ (лимит 64 МБ)", metadata.len() / 1024 / 1024));
    }
    let input_bytes = fs::read(input_path)
        .map_err(|e| format!("Не удалось прочитать ZIP: {e}"))?;
    let parsed = parse_bundle(input_bytes)?;
    ensure_supported_contract(&parsed.manifest.dashboard_contract_version)?;
    Ok(BundleInspection {
        monitor_key: parsed.manifest.monitor.key.clone(),
        run_number: parsed.manifest.run.run_number,
        dry_run: parsed.manifest.run.dry_run,
    })
}

struct ParsedBundle {
    input_kind: String,
    bundle_sha256: String,
    manifest_value: Value,
    manifest: Manifest,
    publication_values: Vec<Value>,
    publications: Vec<PublicationRecord>,
    source_metrics: Vec<Value>,
    run_metrics: Value,
}

pub fn import_bundle(db_path: &Path, input_path: &Path) -> Result<ImportResult, String> {
    let metadata = fs::metadata(input_path)
        .map_err(|e| format!("Не удалось открыть выбранный ZIP: {e}"))?;
    if metadata.len() > MAX_INPUT_BYTES {
        return Err(format!("ZIP слишком велик: {} МБ (лимит 64 МБ)", metadata.len() / 1024 / 1024));
    }

    let input_bytes = fs::read(input_path)
        .map_err(|e| format!("Не удалось прочитать выбранный ZIP: {e}"))?;
    let parsed = parse_bundle(input_bytes)?;

    ensure_supported_contract(&parsed.manifest.dashboard_contract_version)?;
    validate_json("manifest.json", MANIFEST_SCHEMA, &parsed.manifest_value)?;
    validate_json("run_metrics.json", RUN_METRICS_SCHEMA, &parsed.run_metrics)?;
    for (index, value) in parsed.publication_values.iter().enumerate() {
        validate_json(&format!("publications.jsonl:строка {}", index + 1), PUBLICATION_SCHEMA, value)?;
    }
    for (index, value) in parsed.source_metrics.iter().enumerate() {
        validate_json(&format!("source_metrics.jsonl:строка {}", index + 1), SOURCE_METRICS_SCHEMA, value)?;
    }
    validate_semantic_consistency(&parsed)?;

    let conn = open_database(db_path)?;
    ingest(&conn, input_path, parsed)
}


fn validate_semantic_consistency(parsed: &ParsedBundle) -> Result<(), String> {
    let monitor_key = &parsed.manifest.monitor.key;
    let run_monitor = str_field(&parsed.run_metrics, "monitor_key")
        .ok_or("run_metrics.json: отсутствует monitor_key")?;
    if run_monitor != monitor_key {
        return Err(format!(
            "run_metrics.monitor_key={run_monitor} не совпадает с manifest.monitor.key={monitor_key}"
        ));
    }
    if let Some(version) = str_field(&parsed.run_metrics, "schema_version") {
        ensure_supported_contract(version)?;
    }
    for (index, metric) in parsed.source_metrics.iter().enumerate() {
        let metric_monitor = str_field(metric, "monitor_key")
            .ok_or_else(|| format!("source_metrics.jsonl, строка {}: отсутствует monitor_key", index + 1))?;
        if metric_monitor != monitor_key {
            return Err(format!(
                "source_metrics.jsonl, строка {}: monitor_key={} не совпадает с manifest.monitor.key={}",
                index + 1, metric_monitor, monitor_key
            ));
        }
        if let Some(version) = str_field(metric, "schema_version") {
            ensure_supported_contract(version)?;
        }
    }
    Ok(())
}

fn parse_bundle(input_bytes: Vec<u8>) -> Result<ParsedBundle, String> {
    let mut outer = ZipArchive::new(Cursor::new(input_bytes.as_slice()))
        .map_err(|e| format!("Файл не является читаемым ZIP: {e}"))?;

    let direct = outer.file_names().any(|name| name == "manifest.json");

    let (bundle_bytes, input_kind) = if direct {
        (input_bytes.clone(), "direct_bundle".to_string())
    } else {
        let mut candidates = Vec::new();
        for i in 0..outer.len() {
            let file = outer.by_index(i).map_err(|e| format!("Ошибка чтения ZIP: {e}"))?;
            let name = file.name().to_string();
            if name.to_ascii_lowercase().ends_with(".zip") && name.contains("dashboard") {
                candidates.push(name);
            }
        }
        if candidates.len() != 1 {
            return Err(format!(
                "Не найден однозначный dashboard bundle внутри GitHub artifact (найдено вложенных dashboard ZIP: {}).",
                candidates.len()
            ));
        }
        let nested = read_zip_entry(&mut outer, &candidates[0])?;
        (nested, "github_artifact_wrapper".to_string())
    };

    let bundle_sha256 = hex::encode(Sha256::digest(&bundle_bytes));
    let mut archive = ZipArchive::new(Cursor::new(bundle_bytes))
        .map_err(|e| format!("Вложенный dashboard bundle повреждён: {e}"))?;

    let manifest_bytes = read_zip_entry(&mut archive, "manifest.json")?;
    let manifest_value: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("manifest.json содержит некорректный JSON: {e}"))?;
    let manifest: Manifest = serde_json::from_value(manifest_value.clone())
        .map_err(|e| format!("manifest.json не соответствует ожидаемой структуре: {e}"))?;

    let publication_bytes = read_zip_entry(&mut archive, &manifest.files.publications)?;
    let source_metric_bytes = read_zip_entry(&mut archive, &manifest.files.source_metrics)?;
    let run_metric_bytes = read_zip_entry(&mut archive, &manifest.files.run_metrics)?;

    let publication_values = parse_jsonl(&manifest.files.publications, &publication_bytes)?;
    let publications = publication_values
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, value)| {
            serde_json::from_value::<PublicationRecord>(value)
                .map_err(|e| format!("publications.jsonl, строка {}: {e}", index + 1))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let source_metrics = parse_jsonl(&manifest.files.source_metrics, &source_metric_bytes)?;
    let run_metrics: Value = serde_json::from_slice(&run_metric_bytes)
        .map_err(|e| format!("run_metrics.json содержит некорректный JSON: {e}"))?;

    Ok(ParsedBundle {
        input_kind,
        bundle_sha256,
        manifest_value,
        manifest,
        publication_values,
        publications,
        source_metrics,
        run_metrics,
    })
}

fn read_zip_entry<R: Read + Seek>(archive: &mut ZipArchive<R>, name: &str) -> Result<Vec<u8>, String> {
    let mut file = archive
        .by_name(name)
        .map_err(|_| format!("В bundle отсутствует обязательный файл: {name}"))?;
    if file.size() > MAX_ENTRY_BYTES {
        return Err(format!("Файл {name} превышает допустимый размер"));
    }
    let mut bytes = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Не удалось прочитать {name}: {e}"))?;
    Ok(bytes)
}

fn parse_jsonl(name: &str, bytes: &[u8]) -> Result<Vec<Value>, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|e| format!("{name} должен быть UTF-8: {e}"))?;
    let mut out = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.len() > MAX_JSONL_LINE_BYTES {
            return Err(format!("{name}, строка {} слишком велика", index + 1));
        }
        out.push(
            serde_json::from_str(trimmed)
                .map_err(|e| format!("{name}, строка {}: некорректный JSON: {e}", index + 1))?,
        );
    }
    Ok(out)
}

fn ensure_supported_contract(version: &str) -> Result<(), String> {
    let major = version
        .split('.')
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .ok_or_else(|| format!("Некорректная версия Dashboard Contract: {version}"))?;
    if major != 0 {
        return Err(format!("Неподдерживаемая major-версия Dashboard Contract: {version}"));
    }
    Ok(())
}

fn validate_json(label: &str, schema_text: &str, value: &Value) -> Result<(), String> {
    let schema: Value = serde_json::from_str(schema_text)
        .map_err(|e| format!("Встроенная JSON Schema повреждена: {e}"))?;
    let validator = validator_for(&schema)
        .map_err(|e| format!("Не удалось скомпилировать JSON Schema: {e}"))?;
    let errors: Vec<String> = validator
        .iter_errors(value)
        .take(5)
        .map(|error| error.to_string())
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("{label} не прошёл JSON Schema validation: {}", errors.join("; ")))
    }
}

fn ingest(conn: &Connection, input_path: &Path, parsed: ParsedBundle) -> Result<ImportResult, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Не удалось начать импорт: {e}"))?;

    let monitor_id = upsert_monitor(
        &tx,
        &parsed.manifest.monitor.key,
        &parsed.manifest.monitor.display_name,
    )?;
    let external_run_key = parsed
        .manifest
        .run
        .github_run_id
        .clone()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| {
            format!(
                "run:{}:{}",
                parsed.manifest.run.run_number.map(|v| v.to_string()).unwrap_or_else(|| "none".into()),
                parsed.manifest.run.started_at.clone().unwrap_or_else(|| "none".into())
            )
        });

    if let Some((run_id, old_hash)) = existing_run(&tx, monitor_id, &external_run_key)? {
        if old_hash == parsed.bundle_sha256 {
            write_import_log(
                &tx,
                Some(run_id),
                input_path,
                "already_imported",
                "Bundle hash already present; no database rows changed.",
            )?;
            let result = build_result(&tx, &parsed, run_id, "already_imported")?;
            tx.commit().map_err(|e| format!("Не удалось завершить импорт: {e}"))?;
            return Ok(result);
        }
    }

    let existing = existing_run(&tx, monitor_id, &external_run_key)?;
    let status = if existing.is_some() { "replaced" } else { "imported" };
    let run_id = upsert_run(&tx, monitor_id, &external_run_key, &parsed)?;
    if status == "replaced" {
        tx.execute("DELETE FROM run_items WHERE run_id=?1", params![run_id])
            .map_err(|e| format!("Не удалось очистить старые run_items: {e}"))?;
        tx.execute("DELETE FROM source_run_metrics WHERE run_id=?1", params![run_id])
            .map_err(|e| format!("Не удалось очистить старые source metrics: {e}"))?;
    }

    let source_ids = ingest_sources(&tx, run_id, &parsed.manifest.monitor.key, &parsed.source_metrics)?;
    ingest_publications(
        &tx,
        monitor_id,
        run_id,
        &parsed.manifest.monitor.key,
        parsed.manifest.run.started_at.as_deref(),
        &source_ids,
        &parsed.publications,
    )?;

    write_import_log(
        &tx,
        Some(run_id),
        input_path,
        status,
        &format!("Imported dashboard contract {}", parsed.manifest.dashboard_contract_version),
    )?;
    let result = build_result(&tx, &parsed, run_id, status)?;
    tx.commit().map_err(|e| format!("Не удалось завершить импорт: {e}"))?;
    Ok(result)
}

fn upsert_monitor(tx: &Transaction<'_>, key: &str, display_name: &str) -> Result<i64, String> {
    tx.execute(
        r#"INSERT INTO monitors(monitor_key, display_name)
           VALUES (?1, ?2)
           ON CONFLICT(monitor_key) DO UPDATE SET display_name=excluded.display_name"#,
        params![key, display_name],
    )
    .map_err(|e| format!("Не удалось записать monitor: {e}"))?;
    tx.query_row("SELECT id FROM monitors WHERE monitor_key=?1", params![key], |row| row.get(0))
        .map_err(|e| format!("Не удалось найти monitor после записи: {e}"))
}

fn upsert_run(
    tx: &Transaction<'_>,
    monitor_id: i64,
    external_run_key: &str,
    parsed: &ParsedBundle,
) -> Result<i64, String> {
    let manifest_json = serde_json::to_string(&parsed.manifest_value).map_err(|e| e.to_string())?;
    let metrics_json = serde_json::to_string(&parsed.run_metrics).map_err(|e| e.to_string())?;
    let dry_run = parsed.manifest.run.dry_run.map(|v| if v { 1_i64 } else { 0_i64 });
    tx.execute(
        r#"
        INSERT INTO runs(
            monitor_id, external_run_key, external_run_id, run_number, build_sha,
            started_at, lookback_hours, dry_run, contract_version, bundle_sha256,
            manifest_json, run_metrics_json, imported_at
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,CURRENT_TIMESTAMP)
        ON CONFLICT(monitor_id, external_run_key) DO UPDATE SET
            external_run_id=excluded.external_run_id,
            run_number=excluded.run_number,
            build_sha=excluded.build_sha,
            started_at=excluded.started_at,
            lookback_hours=excluded.lookback_hours,
            dry_run=excluded.dry_run,
            contract_version=excluded.contract_version,
            bundle_sha256=excluded.bundle_sha256,
            manifest_json=excluded.manifest_json,
            run_metrics_json=excluded.run_metrics_json,
            imported_at=CURRENT_TIMESTAMP
        "#,
        params![
            monitor_id,
            external_run_key,
            parsed.manifest.run.github_run_id,
            parsed.manifest.run.run_number,
            parsed.manifest.run.github_sha,
            parsed.manifest.run.started_at,
            parsed.manifest.run.lookback_hours,
            dry_run,
            parsed.manifest.dashboard_contract_version,
            parsed.bundle_sha256,
            manifest_json,
            metrics_json,
        ],
    )
    .map_err(|e| format!("Не удалось записать run: {e}"))?;
    tx.query_row(
        "SELECT id FROM runs WHERE monitor_id=?1 AND external_run_key=?2",
        params![monitor_id, external_run_key],
        |row| row.get(0),
    )
    .map_err(|e| format!("Не удалось найти run после записи: {e}"))
}

fn ingest_sources(
    tx: &Transaction<'_>,
    run_id: i64,
    monitor_key: &str,
    metrics: &[Value],
) -> Result<HashMap<String, i64>, String> {
    let mut by_name = HashMap::new();
    for metric in metrics {
        let name = str_field(metric, "source").ok_or("source_metrics: отсутствует source")?;
        let domain = str_field(metric, "domain");
        let uid = source_uid(name, domain);
        tx.execute(
            r#"
            INSERT INTO sources(source_uid, canonical_name, domain, source_type, configured_region, configured_locality, priority)
            VALUES (?1,?2,?3,?4,?5,?6,?7)
            ON CONFLICT(source_uid) DO UPDATE SET
                canonical_name=excluded.canonical_name,
                domain=COALESCE(excluded.domain, sources.domain),
                source_type=COALESCE(excluded.source_type, sources.source_type),
                configured_region=COALESCE(excluded.configured_region, sources.configured_region),
                configured_locality=COALESCE(excluded.configured_locality, sources.configured_locality),
                priority=COALESCE(excluded.priority, sources.priority)
            "#,
            params![
                uid,
                name,
                domain,
                str_field(metric, "source_type"),
                str_field(metric, "source_region"),
                str_field(metric, "source_locality"),
                str_field(metric, "priority"),
            ],
        )
        .map_err(|e| format!("Не удалось записать источник {name}: {e}"))?;
        let source_id: i64 = tx
            .query_row("SELECT id FROM sources WHERE source_uid=?1", params![uid], |row| row.get(0))
            .map_err(|e| format!("Не удалось найти источник {name}: {e}"))?;
        by_name.insert(name.to_lowercase(), source_id);

        tx.execute(
            r#"
            INSERT INTO source_run_metrics(
                run_id, source_id, selected_candidates, clipped_candidates, processed, fetch_ok,
                relevance_passed, relevance_rejected, included, event_geo_resolved,
                event_signature_ready, endpoint_total, endpoint_ok, endpoint_failed,
                access_status, admission_status, blind_zone_status, results, error, metrics_json
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
            ON CONFLICT(run_id, source_id) DO UPDATE SET
                selected_candidates=excluded.selected_candidates,
                clipped_candidates=excluded.clipped_candidates,
                processed=excluded.processed,
                fetch_ok=excluded.fetch_ok,
                relevance_passed=excluded.relevance_passed,
                relevance_rejected=excluded.relevance_rejected,
                included=excluded.included,
                event_geo_resolved=excluded.event_geo_resolved,
                event_signature_ready=excluded.event_signature_ready,
                endpoint_total=excluded.endpoint_total,
                endpoint_ok=excluded.endpoint_ok,
                endpoint_failed=excluded.endpoint_failed,
                access_status=excluded.access_status,
                admission_status=excluded.admission_status,
                blind_zone_status=excluded.blind_zone_status,
                results=excluded.results,
                error=excluded.error,
                metrics_json=excluded.metrics_json
            "#,
            params![
                run_id,
                source_id,
                int_field(metric, "selected_candidates"),
                int_field(metric, "clipped_candidates"),
                int_field(metric, "processed"),
                int_field(metric, "fetch_ok"),
                int_field(metric, "relevance_passed"),
                int_field(metric, "relevance_rejected"),
                int_field(metric, "included"),
                int_field(metric, "event_geo_resolved"),
                int_field(metric, "event_signature_ready"),
                int_field(metric, "endpoint_total"),
                int_field(metric, "endpoint_ok"),
                int_field(metric, "endpoint_failed"),
                str_field(metric, "access_status"),
                str_field(metric, "admission_status"),
                str_field(metric, "blind_zone_status"),
                int_field(metric, "results"),
                str_field(metric, "error"),
                serde_json::to_string(metric).map_err(|e| e.to_string())?,
            ],
        )
        .map_err(|e| format!("Не удалось записать coverage для {name}: {e}"))?;
    }
    let _ = monitor_key;
    Ok(by_name)
}

#[allow(clippy::too_many_arguments)]
fn ingest_publications(
    tx: &Transaction<'_>,
    monitor_id: i64,
    run_id: i64,
    monitor_key: &str,
    observed_at: Option<&str>,
    source_ids: &HashMap<String, i64>,
    publications: &[PublicationRecord],
) -> Result<(), String> {
    for item in publications {
        if item.monitor_key != monitor_key {
            return Err(format!("monitor_key публикации {} не совпадает с manifest", item.document_id));
        }
        ensure_supported_contract(&item.schema_version)?;
        let source_id = match source_ids.get(&item.source.name.to_lowercase()).copied() {
            Some(id) => id,
            None => upsert_fallback_source(tx, &item.source)?,
        };
        let seen = observed_at.or(item.publication.published_at.as_deref());

        tx.execute(
            r#"
            INSERT INTO documents(
                document_uid, source_id, url, normalized_url, published_at, language, title,
                title_generated, excerpt, text_length, preview_image_url, first_seen_at, last_seen_at
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)
            ON CONFLICT(document_uid) DO UPDATE SET
                source_id=excluded.source_id,
                url=excluded.url,
                normalized_url=excluded.normalized_url,
                published_at=COALESCE(excluded.published_at, documents.published_at),
                language=COALESCE(excluded.language, documents.language),
                title=excluded.title,
                title_generated=excluded.title_generated,
                excerpt=COALESCE(excluded.excerpt, documents.excerpt),
                text_length=COALESCE(excluded.text_length, documents.text_length),
                preview_image_url=COALESCE(excluded.preview_image_url, documents.preview_image_url),
                last_seen_at=COALESCE(excluded.last_seen_at, documents.last_seen_at)
            "#,
            params![
                item.document_id,
                source_id,
                item.publication.url,
                item.publication.normalized_url,
                item.publication.published_at,
                item.source.language,
                item.publication.title,
                if item.publication.title_generated { 1_i64 } else { 0_i64 },
                item.publication.excerpt,
                item.publication.text_length,
                item.publication.preview_image_url,
                seen,
            ],
        )
        .map_err(|e| format!("Не удалось записать document {}: {e}", item.document_id))?;
        let document_db_id: i64 = tx
            .query_row("SELECT id FROM documents WHERE document_uid=?1", params![item.document_id], |row| row.get(0))
            .map_err(|e| format!("Не удалось найти document {}: {e}", item.document_id))?;

        tx.execute(
            r#"
            INSERT INTO monitor_items(
                monitor_item_uid, monitor_id, document_id, category, subcategory, signal_type,
                official_response, score, matched_terms, category_bonus_only, classification_schema_version, raw_json
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
            ON CONFLICT(monitor_item_uid) DO UPDATE SET
                category=excluded.category,
                subcategory=excluded.subcategory,
                signal_type=excluded.signal_type,
                official_response=excluded.official_response,
                score=excluded.score,
                matched_terms=excluded.matched_terms,
                category_bonus_only=excluded.category_bonus_only,
                classification_schema_version=excluded.classification_schema_version,
                raw_json=excluded.raw_json
            "#,
            params![
                item.monitor_item_id,
                monitor_id,
                document_db_id,
                item.classification.category,
                item.classification.subcategory,
                item.classification.signal_type,
                item.classification.official_response.map(|v| if v { 1_i64 } else { 0_i64 }),
                item.classification.score,
                value_to_text(item.classification.matched_terms.as_ref()),
                item.classification.category_bonus_only.map(|v| if v { 1_i64 } else { 0_i64 }),
                item.schema_version,
                serde_json::to_string(&item).map_err(|e| format!("Не удалось сериализовать publication raw_json: {e}"))?,
            ],
        )
        .map_err(|e| format!("Не удалось записать monitor_item {}: {e}", item.monitor_item_id))?;
        let monitor_item_db_id: i64 = tx
            .query_row(
                "SELECT id FROM monitor_items WHERE monitor_item_uid=?1",
                params![item.monitor_item_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Не удалось найти monitor_item {}: {e}", item.monitor_item_id))?;

        tx.execute(
            r#"INSERT INTO run_items(run_id, monitor_item_id, was_primary_result, event_echo, event_echo_anchor, event_echo_sources, also_covered_by, also_covered_urls)
               VALUES (?1,?2,1,?3,?4,?5,?6,?7)
               ON CONFLICT(run_id, monitor_item_id) DO UPDATE SET
                    event_echo=excluded.event_echo,
                    event_echo_anchor=excluded.event_echo_anchor,
                    event_echo_sources=excluded.event_echo_sources,
                    also_covered_by=excluded.also_covered_by,
                    also_covered_urls=excluded.also_covered_urls"#,
            params![
                run_id,
                monitor_item_db_id,
                value_to_text(item.event.echo.as_ref()),
                value_to_text(item.event.echo_anchor.as_ref()),
                value_to_text(item.event.echo_sources.as_ref()),
                value_to_text(item.event.also_covered_by.as_ref()),
                value_to_text(item.event.also_covered_urls.as_ref()),
            ],
        )
        .map_err(|e| format!("Не удалось связать publication с run: {e}"))?;

        tx.execute("DELETE FROM event_items WHERE monitor_item_id=?1", params![monitor_item_db_id])
            .map_err(|e| format!("Не удалось обновить event relation: {e}"))?;
        if has_event(&item.event) {
            let event_uid = event_uid(monitor_key, item);
            tx.execute(
                r#"
                INSERT INTO events(
                    monitor_id, event_uid, event_signature, event_region, event_locality,
                    geo_status, geo_confidence, event_object, event_problem
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
                ON CONFLICT(monitor_id, event_uid) DO UPDATE SET
                    event_signature=COALESCE(excluded.event_signature, events.event_signature),
                    event_region=COALESCE(excluded.event_region, events.event_region),
                    event_locality=COALESCE(excluded.event_locality, events.event_locality),
                    geo_status=excluded.geo_status,
                    geo_confidence=COALESCE(excluded.geo_confidence, events.geo_confidence),
                    event_object=COALESCE(excluded.event_object, events.event_object),
                    event_problem=COALESCE(excluded.event_problem, events.event_problem)
                "#,
                params![
                    monitor_id,
                    event_uid,
                    item.event.signature,
                    item.event.region,
                    item.event.locality,
                    item.event.geo_status.as_deref().unwrap_or("unresolved"),
                    item.event.geo_confidence,
                    item.event.object,
                    item.event.problem,
                ],
            )
            .map_err(|e| format!("Не удалось записать event: {e}"))?;
            let event_id: i64 = tx
                .query_row(
                    "SELECT id FROM events WHERE monitor_id=?1 AND event_uid=?2",
                    params![monitor_id, event_uid],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Не удалось найти event после записи: {e}"))?;
            tx.execute(
                "INSERT OR REPLACE INTO event_items(event_id, monitor_item_id, relation) VALUES (?1,?2,'primary')",
                params![event_id, monitor_item_db_id],
            )
            .map_err(|e| format!("Не удалось связать event и publication: {e}"))?;
        }
    }
    Ok(())
}

fn upsert_fallback_source(tx: &Transaction<'_>, source: &crate::models::PublicationSource) -> Result<i64, String> {
    let uid = source_uid(&source.name, None);
    tx.execute(
        r#"INSERT INTO sources(source_uid, canonical_name, source_type, configured_region, configured_locality, priority)
           VALUES (?1,?2,?3,?4,?5,?6)
           ON CONFLICT(source_uid) DO UPDATE SET
             source_type=COALESCE(excluded.source_type, sources.source_type),
             configured_region=COALESCE(excluded.configured_region, sources.configured_region),
             configured_locality=COALESCE(excluded.configured_locality, sources.configured_locality),
             priority=COALESCE(excluded.priority, sources.priority)"#,
        params![
            uid,
            source.name,
            source.source_type,
            source.configured_region,
            source.configured_locality,
            source.priority,
        ],
    )
    .map_err(|e| format!("Не удалось записать fallback source {}: {e}", source.name))?;
    tx.query_row("SELECT id FROM sources WHERE source_uid=?1", params![uid], |row| row.get(0))
        .map_err(|e| format!("Не удалось найти fallback source {}: {e}", source.name))
}

fn build_result(
    tx: &Transaction<'_>,
    parsed: &ParsedBundle,
    run_id: i64,
    status: &str,
) -> Result<ImportResult, String> {
    let publications: i64 = tx
        .query_row("SELECT COUNT(*) FROM run_items WHERE run_id=?1", params![run_id], |row| row.get(0))
        .map_err(|e| format!("Не удалось посчитать публикации run: {e}"))?;
    let sources_in_result: i64 = tx
        .query_row(
            r#"SELECT COUNT(DISTINCT d.source_id)
               FROM run_items ri
               JOIN monitor_items mi ON mi.id=ri.monitor_item_id
               JOIN documents d ON d.id=mi.document_id
               WHERE ri.run_id=?1 AND d.source_id IS NOT NULL"#,
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Не удалось посчитать источники результата: {e}"))?;
    let sources_in_coverage: i64 = tx
        .query_row("SELECT COUNT(*) FROM source_run_metrics WHERE run_id=?1", params![run_id], |row| row.get(0))
        .map_err(|e| format!("Не удалось посчитать coverage: {e}"))?;

    Ok(ImportResult {
        status: status.to_string(),
        run_id,
        monitor_key: parsed.manifest.monitor.key.clone(),
        run_number: parsed.manifest.run.run_number,
        dry_run: parsed.manifest.run.dry_run,
        contract_version: parsed.manifest.dashboard_contract_version.clone(),
        publications,
        sources_in_result,
        sources_in_coverage,
        bundle_sha256: parsed.bundle_sha256.clone(),
        input_kind: parsed.input_kind.clone(),
    })
}

fn source_uid(name: &str, domain: Option<&str>) -> String {
    // Domain alone is not unique: multiple Telegram sources legitimately share t.me.
    // The canonical source name therefore always participates in the stable key.
    let canonical_name = name.trim().to_lowercase();
    let canonical_domain = domain.unwrap_or("").trim().to_lowercase();
    let basis = format!("name:{canonical_name}|domain:{canonical_domain}");
    format!("src_{}", &hex::encode(Sha256::digest(basis.as_bytes()))[..20])
}

fn event_uid(monitor_key: &str, item: &PublicationRecord) -> String {
    let basis = item
        .event
        .signature
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|signature| format!("{monitor_key}|signature|{signature}"))
        .unwrap_or_else(|| format!("{monitor_key}|item|{}", item.monitor_item_id));
    format!("evt_{}", &hex::encode(Sha256::digest(basis.as_bytes()))[..24])
}

fn has_event(event: &crate::models::EventData) -> bool {
    event.signature.is_some()
        || event.region.is_some()
        || event.locality.is_some()
        || event.object.is_some()
        || event.problem.is_some()
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str).filter(|v| !v.trim().is_empty())
}

fn int_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|v| {
        v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
    })
}

fn value_to_text(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => Some(other.to_string()),
    }
}

fn write_import_log(
    tx: &Transaction<'_>,
    run_id: Option<i64>,
    input_path: &Path,
    status: &str,
    details: &str,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO import_log(run_id, source_filename, status, details) VALUES (?1,?2,?3,?4)",
        params![
            run_id,
            input_path.file_name().map(|v| v.to_string_lossy().to_string()),
            status,
            details,
        ],
    )
    .map_err(|e| format!("Не удалось записать import_log: {e}"))?;
    Ok(())
}
