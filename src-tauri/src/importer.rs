use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Seek};
use std::path::Path;

use jsonschema::validator_for;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::db::{existing_run, open_database};
use crate::models::{EntityRecord, FullTextRecord, ImportResult, Manifest, PublicationRecord};

const MAX_INPUT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;
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
        return Err(format!("ZIP слишком велик: {} МБ (лимит 128 МБ)", metadata.len() / 1024 / 1024));
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
    full_texts: Vec<FullTextRecord>,
    entities: Vec<EntityRecord>,
}

pub fn import_bundle(db_path: &Path, input_path: &Path) -> Result<ImportResult, String> {
    let metadata = fs::metadata(input_path)
        .map_err(|e| format!("Не удалось открыть выбранный ZIP: {e}"))?;
    if metadata.len() > MAX_INPUT_BYTES {
        return Err(format!("ZIP слишком велик: {} МБ (лимит 128 МБ)", metadata.len() / 1024 / 1024));
    }

    let input_bytes = fs::read(input_path)
        .map_err(|e| format!("Не удалось прочитать выбранный ZIP: {e}"))?;
    let parsed = parse_bundle(input_bytes)?;

    validate_and_ingest(db_path,input_path,parsed)
}

/// Import the same contract directly from the independently authenticated API feed.
/// A collector UUID is a different namespace from GitHub workflow/run numbers.
pub fn import_collector_bundle(db_path:&Path,value:Value)->Result<ImportResult,String>{
    let bytes=serde_json::to_vec(&value).map_err(|e|e.to_string())?;
    if bytes.len() as u64>MAX_INPUT_BYTES{return Err("Пакет помощника превышает 128 МБ".into());}
    let manifest_value=value.get("manifest").cloned().ok_or("Отсутствует manifest помощника")?;
    let manifest:Manifest=serde_json::from_value(manifest_value.clone()).map_err(|e|e.to_string())?;
    if manifest.monitor.key!="lukashenko"||manifest.run.collector.as_deref()!=Some("api_assistant")||manifest.run.collector_run_id.as_deref().unwrap_or("").is_empty(){return Err("Неверный контур пакета помощника".into());}
    let publication_values=value.get("publications").and_then(Value::as_array).cloned().ok_or("Отсутствуют publications помощника")?;
    let publications=publication_values.iter().map(|v|serde_json::from_value(v.clone())).collect::<Result<Vec<PublicationRecord>,_>>().map_err(|e|e.to_string())?;
    let source_metrics=value.get("source_metrics").and_then(Value::as_array).cloned().ok_or("Отсутствуют source_metrics помощника")?;
    let run_metrics=value.get("run_metrics").cloned().ok_or("Отсутствуют run_metrics помощника")?;
    let full_texts=serde_json::from_value(value.get("full_texts").cloned().unwrap_or(serde_json::json!([]))).map_err(|e|e.to_string())?;
    let mut fingerprint = Sha256::new();
    fingerprint.update(&bytes);
    if publication_values.iter().any(|record| record.pointer("/provenance/superseded_document_ids").is_some()) {
        fingerprint.update(b"publisher-alias-reconciliation-v2");
    }
    let parsed=ParsedBundle{input_kind:"collector-json".into(),bundle_sha256:hex::encode(fingerprint.finalize()),manifest_value,manifest,publication_values,publications,source_metrics,run_metrics,full_texts,entities:Vec::new()};
    validate_and_ingest(db_path,Path::new("L-News-Assistant"),parsed)
}

fn validate_and_ingest(db_path:&Path,input_path:&Path,parsed:ParsedBundle)->Result<ImportResult,String>{

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
    let document_ids: std::collections::HashSet<&str> = parsed.publications.iter().map(|item| item.document_id.as_str()).collect();
    for item in &parsed.full_texts {
        ensure_supported_contract(&item.schema_version)?;
        if item.monitor_key.as_str() != monitor_key.as_str() {
            return Err(format!("full_texts.jsonl: monitor_key={} не совпадает с manifest.monitor.key={}", item.monitor_key, monitor_key));
        }
        if !document_ids.contains(item.document_id.as_str()) {
            return Err(format!("full_texts.jsonl ссылается на отсутствующий document_id={}", item.document_id));
        }
        if item.text.trim().is_empty() {
            return Err(format!("full_texts.jsonl: пустой text для document_id={}", item.document_id));
        }
    }
    for item in &parsed.entities {
        ensure_supported_contract(&item.schema_version)?;
        if item.monitor_key.as_str() != monitor_key.as_str() {
            return Err(format!("entities.jsonl: monitor_key={} не совпадает с manifest.monitor.key={}", item.monitor_key, monitor_key));
        }
        if !document_ids.contains(item.document_id.as_str()) {
            return Err(format!("entities.jsonl ссылается на отсутствующий document_id={}", item.document_id));
        }
        if item.entity_type.trim().is_empty() || item.canonical_name.trim().is_empty() || item.normalized_name.trim().is_empty() {
            return Err(format!("entities.jsonl: неполная сущность {}", item.entity_id));
        }
    }
    Ok(())
}

fn parse_bundle(input_bytes: Vec<u8>) -> Result<ParsedBundle, String> {
    let mut outer = ZipArchive::new(Cursor::new(input_bytes.as_slice()))
        .map_err(|e| format!("Файл не является читаемым ZIP: {e}"))?;

    let direct = outer.file_names().any(|name| name.as_ref().map(|n| n.as_ref() == "manifest.json").unwrap_or(false));

    let (bundle_bytes, input_kind) = if direct {
        (input_bytes.clone(), "direct_bundle".to_string())
    } else {
        let mut candidates = Vec::new();
        for i in 0..outer.len() {
            let file = outer.by_index(i).map_err(|e| format!("Ошибка чтения ZIP: {e}"))?;
            let name = file.name().map_err(|e| format!("Ошибка имени файла ZIP: {e}"))?.to_string();
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

    let full_texts = match manifest.files.full_texts.as_deref() {
        Some(name) => {
            let bytes = read_zip_entry(&mut archive, name)?;
            parse_jsonl(name, &bytes)?.into_iter().enumerate().map(|(index, value)| {
                serde_json::from_value::<FullTextRecord>(value)
                    .map_err(|e| format!("{name}, строка {}: {e}", index + 1))
            }).collect::<Result<Vec<_>, _>>()?
        }
        None => Vec::new(),
    };
    let entities = match manifest.files.entities.as_deref() {
        Some(name) => {
            let bytes = read_zip_entry(&mut archive, name)?;
            parse_jsonl(name, &bytes)?.into_iter().enumerate().map(|(index, value)| {
                serde_json::from_value::<EntityRecord>(value)
                    .map_err(|e| format!("{name}, строка {}: {e}", index + 1))
            }).collect::<Result<Vec<_>, _>>()?
        }
        None => Vec::new(),
    };

    Ok(ParsedBundle {
        input_kind,
        bundle_sha256,
        manifest_value,
        manifest,
        publication_values,
        publications,
        source_metrics,
        run_metrics,
        full_texts,
        entities,
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
    let external_run_key = parsed.manifest.run.collector_run_id.as_ref()
        .filter(|v|!v.trim().is_empty())
        .map(|id|format!("collector:{}:{}",parsed.manifest.run.collector.as_deref().unwrap_or("api"),id))
        .or_else(||parsed
        .manifest
        .run
        .github_run_id
        .clone()
        .filter(|v| !v.trim().is_empty()))
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
    let document_ids = ingest_publications(
        &tx,
        monitor_id,
        run_id,
        &parsed.manifest.monitor.key,
        parsed.manifest.run.started_at.as_deref(),
        &source_ids,
        &parsed.publications,
    )?;
    if parsed.manifest.files.full_texts.is_some() {
        ingest_full_texts(&tx, &parsed.full_texts, &document_ids)?;
    }
    if parsed.manifest.files.entities.is_some() {
        ingest_entities(&tx, &parsed.publications, &parsed.entities, &document_ids)?;
    }
    if parsed.input_kind == "collector-json" {
        if let Some(withdrawn) = parsed.run_metrics["withdrawn_document_ids"].as_array() {
            let mut remove_orphan = tx.prepare(
                r#"DELETE FROM monitor_items
                   WHERE monitor_id = ?1
                     AND document_id = (SELECT id FROM documents WHERE document_uid = ?2)
                     AND json_extract(raw_json, '$.provenance.report') = 'L-News-Assistant'
                     AND NOT EXISTS (SELECT 1 FROM run_items WHERE monitor_item_id = monitor_items.id)"#,
            ).map_err(|e| format!("Не удалось подготовить отзыв карточек помощника: {e}"))?;
            for uid in withdrawn.iter().filter_map(Value::as_str) {
                remove_orphan.execute(params![monitor_id, uid])
                    .map_err(|e| format!("Не удалось отозвать карточку помощника: {e}"))?;
            }
        }
    }

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
        let generated_uid = source_uid(name, domain);
        let uid = if monitor_key=="lukashenko" {
            let normalized_domain=domain.unwrap_or("").trim().to_lowercase().trim_start_matches("www.").to_string();
            if normalized_domain.is_empty(){generated_uid}else{
                tx.query_row("SELECT source_uid FROM sources WHERE LOWER(CASE WHEN domain LIKE 'www.%' THEN substr(domain,5) ELSE domain END)=?1 ORDER BY id LIMIT 1",params![normalized_domain],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?.unwrap_or(generated_uid)
            }
        }else{generated_uid};
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
) -> Result<HashMap<String, i64>, String> {
    let mut document_ids = HashMap::new();
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

        let mut aliases=vec![item.publication.normalized_url.clone(),item.publication.url.clone()];
        if let Some(values)=item.provenance.as_ref().and_then(|v|v.get("url_aliases")).and_then(Value::as_array){
            aliases.extend(values.iter().filter_map(Value::as_str).map(str::to_string));
        }
        if monitor_key == "lukashenko" {
            aliases.extend(crate::identity::l_monitor_aliases(&aliases));
        }
        let existing_by_url=crate::identity::find_document(tx,&item.document_id,&aliases)?;

        let document_db_id = if let Some(existing_id) = existing_by_url {
            tx.execute(
                r#"
                UPDATE documents SET
                    source_id=?2,
                    url=?3,
                    published_at=CASE
                        WHEN ?4 IS NULL OR TRIM(?4)='' THEN published_at
                        WHEN published_at IS NULL OR TRIM(published_at)='' THEN ?4
                        WHEN datetime(?4) < datetime(published_at) THEN ?4
                        ELSE published_at
                    END,
                    language=COALESCE(?5, language),
                    title=?6,
                    title_generated=?7,
                    excerpt=COALESCE(?8, excerpt),
                    text_length=COALESCE(?9, text_length),
                    preview_image_url=COALESCE(?10, preview_image_url),
                    last_seen_at=COALESCE(?11, last_seen_at)
                WHERE id=?1
                "#,
                params![
                    existing_id,
                    source_id,
                    item.publication.url,
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
            .map_err(|e| format!("Не удалось обновить document по normalized_url {}: {e}", item.publication.normalized_url))?;
            existing_id
        } else {
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
                    published_at=CASE
                        WHEN excluded.published_at IS NULL OR TRIM(excluded.published_at)='' THEN documents.published_at
                        WHEN documents.published_at IS NULL OR TRIM(documents.published_at)='' THEN excluded.published_at
                        WHEN datetime(excluded.published_at) < datetime(documents.published_at) THEN excluded.published_at
                        ELSE documents.published_at
                    END,
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
            tx.query_row(
                "SELECT id FROM documents WHERE document_uid=?1",
                params![item.document_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Не удалось найти document {}: {e}", item.document_id))?
        };
        document_ids.insert(item.document_id.clone(), document_db_id);

        crate::identity::register(tx,document_db_id,&item.document_id,&aliases)?;
        let stable_document_uid:String=tx.query_row("SELECT document_uid FROM documents WHERE id=?1",params![document_db_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        let existing_item:Option<(String,String)>=tx.query_row("SELECT monitor_item_uid,raw_json FROM monitor_items WHERE monitor_id=?1 AND document_id=?2",params![monitor_id,document_db_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
        let stable_item_uid=existing_item.as_ref().map(|v|v.0.clone()).unwrap_or_else(||format!("item_{}_{}",monitor_key,stable_document_uid));
        let mut raw=serde_json::to_value(item).map_err(|e|e.to_string())?;
        raw["document_id"]=Value::String(stable_document_uid);
        raw["monitor_item_id"]=Value::String(stable_item_uid.clone());
        let mut origins=Vec::new();
        if let Some((_,old))=&existing_item{if let Ok(v)=serde_json::from_str::<Value>(old){
            if let Some(values)=v.pointer("/provenance/collectors").and_then(Value::as_array){origins.extend(values.iter().filter_map(Value::as_str).map(str::to_string));}
            if let Some(report)=v.pointer("/provenance/report").and_then(Value::as_str){origins.push(report.to_string());}
        }}
        if let Some(report)=raw.pointer("/provenance/report").and_then(Value::as_str){origins.push(report.to_string());}
        origins.sort();origins.dedup();
        if !raw["provenance"].is_object(){raw["provenance"]=serde_json::json!({});}
        raw["provenance"]["collectors"]=serde_json::json!(origins);
        let raw_json=serde_json::to_string(&raw).map_err(|e|e.to_string())?;

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
                stable_item_uid,
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
                raw_json,
            ],
        )
        .map_err(|e| format!("Не удалось записать monitor_item {}: {e}", item.monitor_item_id))?;
        let monitor_item_db_id: i64 = tx
            .query_row(
                "SELECT id FROM monitor_items WHERE monitor_item_uid=?1",
                params![stable_item_uid],
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

        let preserve_event=item.provenance.as_ref().and_then(|v|v.get("report")).and_then(Value::as_str)==Some("L-News-Assistant")
            && item.event.signature.is_none()
            && tx.query_row("SELECT EXISTS(SELECT 1 FROM event_items ei JOIN events e ON e.id=ei.event_id WHERE ei.monitor_item_id=?1 AND e.event_signature IS NOT NULL)",params![monitor_item_db_id],|r|r.get::<_,i64>(0)).map_err(|e|e.to_string())?!=0;
        if item.provenance.as_ref().and_then(|value|value.get("report")).and_then(Value::as_str)==Some("L-News-Assistant") {
            if let Some(superseded) = item.provenance.as_ref().and_then(|value| value.get("superseded_document_ids")).and_then(Value::as_array) {
                crate::identity::merge_collector_duplicates(tx,monitor_id,monitor_item_db_id,document_db_id,&aliases,superseded)?;
            }
        }
        if !preserve_event {
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
    }
    Ok(document_ids)
}

fn ingest_full_texts(
    tx: &Transaction<'_>,
    full_texts: &[FullTextRecord],
    document_ids: &HashMap<String, i64>,
) -> Result<(), String> {
    for item in full_texts {
        let document_db_id = document_ids
            .get(&item.document_id)
            .copied()
            .ok_or_else(|| format!("Не найден document mapping для полного текста {}", item.document_id))?;
        let changed = tx.execute(
            r#"UPDATE documents SET
                full_text=?2,
                full_text_sha256=?3,
                full_text_quality=?4,
                full_text_extraction_strategy=?5,
                full_text_transport=?6,
                text_length=COALESCE(?7, text_length)
               WHERE id=?1 AND (COALESCE(full_text_quality,'')<>'FULL_TEXT' OR ?4='FULL_TEXT')
                   AND (COALESCE(length(full_text),0)<=length(?2)
                   OR (COALESCE(full_text_quality,'')<>'FULL_TEXT' AND ?4='FULL_TEXT'))"#,
            params![
                document_db_id,
                item.text,
                item.text_sha256,
                item.quality,
                item.extraction_strategy,
                item.transport,
                item.text_length,
            ],
        ).map_err(|e| format!("Не удалось записать полный текст {}: {e}", item.document_id))?;
        let _ = changed; // A shorter/partial candidate must not downgrade a stored body.
    }
    Ok(())
}

fn ingest_entities(
    tx: &Transaction<'_>,
    publications: &[PublicationRecord],
    entities: &[EntityRecord],
    document_ids: &HashMap<String, i64>,
) -> Result<(), String> {
    for publication in publications {
        let document_db_id = document_ids
            .get(&publication.document_id)
            .copied()
            .ok_or_else(|| format!("Не найден document mapping для сущностей {}", publication.document_id))?;
        tx.execute(
            "DELETE FROM document_entities WHERE document_id=?1",
            params![document_db_id],
        ).map_err(|e| format!("Не удалось обновить сущности {}: {e}", publication.document_id))?;
    }
    for item in entities {
        tx.execute(
            r#"INSERT INTO entities(normalized_name, display_name, entity_type)
               VALUES (?1,?2,?3)
               ON CONFLICT(normalized_name, entity_type) DO UPDATE SET display_name=excluded.display_name"#,
            params![item.normalized_name, item.canonical_name, item.entity_type],
        ).map_err(|e| format!("Не удалось записать сущность {}: {e}", item.canonical_name))?;
        let entity_id: i64 = tx.query_row(
            "SELECT id FROM entities WHERE normalized_name=?1 AND entity_type=?2",
            params![item.normalized_name, item.entity_type],
            |row| row.get(0),
        ).map_err(|e| format!("Не удалось найти сущность {}: {e}", item.canonical_name))?;
        let document_id = document_ids
            .get(&item.document_id)
            .copied()
            .ok_or_else(|| format!("Не найден document mapping {} для сущности", item.document_id))?;
        tx.execute(
            r#"INSERT INTO document_entities(document_id, entity_id, mentions, confidence, method, surface_form)
               VALUES (?1,?2,?3,?4,?5,?6)
               ON CONFLICT(document_id, entity_id) DO UPDATE SET
                 mentions=excluded.mentions,
                 confidence=excluded.confidence,
                 method=excluded.method,
                 surface_form=excluded.surface_form"#,
            params![
                document_id,
                entity_id,
                item.mentions.unwrap_or(1).max(1),
                item.confidence,
                item.method,
                item.surface_form,
            ],
        ).map_err(|e| format!("Не удалось связать сущность {} с документом: {e}", item.canonical_name))?;
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
        .query_row("SELECT COUNT(*) FROM reported_run_items WHERE run_id=?1", params![run_id], |row| row.get(0))
        .map_err(|e| format!("Не удалось посчитать публикации run: {e}"))?;
    let sources_in_result: i64 = tx
        .query_row(
            r#"SELECT COUNT(DISTINCT d.source_id)
               FROM reported_run_items ri
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

#[cfg(test)]
mod identity_integration_tests {
 use super::*;
 use serde_json::json;
 use std::sync::atomic::{AtomicUsize,Ordering};
 static N:AtomicUsize=AtomicUsize::new(0);
 fn test_directory(label: &str) -> std::path::PathBuf {
     let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
     std::env::temp_dir().join(format!("{label}-{}-{stamp}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)))
 }
 fn bundle(api:bool,uid:&str,url:&str,body:&str,quality:&str)->Value{
  let mut run=json!({"run_number":165,"github_run_id":"github-165","started_at":"2026-11-19T12:07:00Z","lookback_hours":26,"dry_run":false});
  if api {run=json!({"run_number":null,"collector":"api_assistant","collector_run_id":"pilot-uuid","collector_number":1,"started_at":"2026-11-19T12:07:00Z","lookback_hours":26,"dry_run":false});}
  json!({"manifest":{"dashboard_contract_version":"0.3","monitor":{"key":"lukashenko","display_name":"L-Monitor"},"run":run,"files":{"publications":"publications.jsonl","source_metrics":"source_metrics.jsonl","run_metrics":"run_metrics.json","full_texts":"full_texts.jsonl"},"capabilities":{}},
   "publications":[{"schema_version":"0.3","monitor_key":"lukashenko","document_id":uid,"monitor_item_id":format!("item_{uid}"),"source":{"name":if api{"Example API"}else{"Example"},"type":"media","configured_region":"Великобритания"},"publication":{"published_at":"2026-11-19T10:00:00Z","title":if api{"Лукашенко: новый заголовок"}else{"Лукашенко: заголовок"},"url":url,"normalized_url":url,"text_length":body.len()},"classification":{"category":"Политика"},"event":{},"provenance":{"report":if api{"L-News-Assistant"}else{"M-Trouble"},"content_level":quality}}],
   "source_metrics":[{"schema_version":"0.3","monitor_key":"lukashenko","source":if api{"Example API"}else{"Example"},"domain":"example.com","source_region":"Великобритания","results":1}],
   "run_metrics":{"schema_version":"0.3","monitor_key":"lukashenko","final_publications":1},
   "full_texts":[{"schema_version":"0.3","monitor_key":"lukashenko","document_id":uid,"text":body,"quality":quality,"text_length":body.len()}]})
 }
 fn import(db:&Path,v:Value){
  if v.pointer("/manifest/run/collector").is_some(){import_collector_bundle(db,v).unwrap();return;}
  // Exercise the exact common validation/import path used after ZIP parsing.
  let manifest_value=v["manifest"].clone();let manifest=serde_json::from_value(manifest_value.clone()).unwrap();
  let parsed=ParsedBundle{input_kind:"test-github".into(),bundle_sha256:hex::encode(Sha256::digest(serde_json::to_vec(&v).unwrap())),manifest_value,manifest,publication_values:v["publications"].as_array().unwrap().clone(),publications:serde_json::from_value(v["publications"].clone()).unwrap(),source_metrics:v["source_metrics"].as_array().unwrap().clone(),run_metrics:v["run_metrics"].clone(),full_texts:serde_json::from_value(v["full_texts"].clone()).unwrap(),entities:vec![]};
  validate_and_ingest(db,Path::new("test"),parsed).unwrap();
 }
 fn check_order(api_first:bool){
  let dir=test_directory("monitor-identity-test");std::fs::create_dir_all(&dir).unwrap();let path=dir.join("test.sqlite");crate::db::initialize_database(&path).unwrap();
  let long="Full original publication body. ".repeat(100);
  let first=bundle(api_first,if api_first{"api-doc"}else{"gh-doc"},"https://www.example.com/News/A?utm_source=first&id=7",&long,"FULL_TEXT");
  import(&path,first.clone());let conn=crate::db::open_database(&path).unwrap();let uid:String=conn.query_row("select document_uid from documents",[],|r|r.get(0)).unwrap();
  conn.execute("insert into moderation_exclusions values('lukashenko',?1,'Operator','2026-11-19')",params![uid]).unwrap();
  conn.execute("insert into moderation_flags values('lukashenko',?1,'u1','Operator','2026-11-19')",params![uid]).unwrap();
  let second=bundle(!api_first,if api_first{"gh-doc"}else{"api-doc"},"http://example.com/News/A/?id=7&utm_source=second#top","Short publicly available lead","SNIPPET");import(&path,second.clone());import(&path,second);
  assert_eq!(conn.query_row("select count(*) from documents",[],|r|r.get::<_,i64>(0)).unwrap(),1);
  assert_eq!(conn.query_row("select count(*) from monitor_items",[],|r|r.get::<_,i64>(0)).unwrap(),1);
  assert_eq!(conn.query_row("select count(*) from runs",[],|r|r.get::<_,i64>(0)).unwrap(),2);
  assert_eq!(conn.query_row("select count(*) from sources",[],|r|r.get::<_,i64>(0)).unwrap(),1);
  assert_eq!(conn.query_row("select full_text from documents",[],|r|r.get::<_,String>(0)).unwrap(),long);
  assert_eq!(crate::identity::stable_uid(&conn,if api_first{"gh-doc"}else{"api-doc"}).unwrap(),uid);
  assert_eq!(conn.query_row("select count(*) from moderation_exclusions where document_uid=?1",params![uid],|r|r.get::<_,i64>(0)).unwrap(),1);
  assert_eq!(conn.query_row("select count(*) from moderation_flags where document_uid=?1",params![uid],|r|r.get::<_,i64>(0)).unwrap(),1);
  let runs=crate::db::list_runs(&path,"lukashenko").unwrap();assert!(runs.iter().any(|r|r.collector.as_deref()==Some("api_assistant")));
  assert_eq!(runs.iter().map(|run| run.publications).sum::<i64>(), 1);
  assert_eq!(runs.iter().map(|run| run.full_text_publications).sum::<i64>(), 1);
  assert_eq!(runs.iter().map(|run| run.cross_collector_duplicates).sum::<i64>(), 1);
  conn.execute("DELETE FROM moderation_exclusions WHERE document_uid=?1", params![uid]).unwrap();
  for run in &runs {
      let expected = usize::from(run.collector.as_deref() == Some("api_assistant"));
      assert_eq!(crate::db::l_monitor_run_publications(&path, run.id).unwrap().len(), expected);
  }
  let sources=crate::db::list_sources(&path,"lukashenko",None).unwrap();assert_eq!(sources.len(),1);
  assert_eq!(sources[0].total_results, 1);
  // A different article ID remains a separate publication.
  import(&path,bundle(true,"another-doc","https://example.com/News/A?id=8","Different article","SNIPPET"));
  assert_eq!(conn.query_row("select count(*) from documents",[],|r|r.get::<_,i64>(0)).unwrap(),2);
  drop(conn);let _=std::fs::remove_dir_all(dir);
 }
 #[test]
 fn two_assistants_share_dedup_but_keep_independent_run_numbers() {
  let dir=test_directory("monitor-two-assistants");let path=dir.join("test.sqlite");crate::db::initialize_database(&path).unwrap();
  let first=bundle(true,"helper1-doc","https://example.com/shared","Full body. ","FULL_TEXT");
  let mut second=bundle(true,"helper2-doc","https://example.com/shared?utm_source=cloro","Lead","SNIPPET");
  second["manifest"]["run"]["assistant_id"]=json!(2);
  second["manifest"]["run"]["collector_run_id"]=json!("helper2-distinct-uuid");
  import(&path,first);import(&path,second.clone());import(&path,second);
  let runs=crate::db::list_runs(&path,"lukashenko").unwrap();assert_eq!(runs.len(),2);
  assert!(runs.iter().any(|r|r.collector_assistant_id==Some(1)&&r.collector_number==Some(1)));
  assert!(runs.iter().any(|r|r.collector_assistant_id==Some(2)&&r.collector_number==Some(1)));
  let conn=crate::db::open_database(&path).unwrap();
  assert_eq!(conn.query_row("select count(*) from documents",[],|r|r.get::<_,i64>(0)).unwrap(),1);
  assert_eq!(runs.iter().map(|r|r.publications).sum::<i64>(),1);
  drop(conn);let _=std::fs::remove_dir_all(dir);
 }
 #[test] fn github_then_api_preserves_moderation_and_body(){check_order(false);}
 #[test] fn api_then_github_preserves_moderation_and_body(){check_order(true);}

 #[test]
 fn withdrawal_removes_assistant_only_card_and_preserves_github_card() {
     let dir = test_directory("monitor-assistant-withdrawal");
     let path = dir.join("test.sqlite");
     crate::db::initialize_database(&path).unwrap();
     let mut revised = bundle(true, "api-only", "https://example.com/only", "Preview", "SNIPPET");
     import(&path, revised.clone());
     import(&path, bundle(true, "api-shared", "https://example.com/shared", "API preview", "SNIPPET"));
     import(&path, bundle(false, "gh-shared", "https://example.com/shared", "GitHub preview", "SNIPPET"));
     revised["publications"] = json!([]);
     revised["full_texts"] = json!([]);
     revised["run_metrics"]["final_publications"] = json!(0);
     revised["run_metrics"]["withdrawn_document_ids"] = json!(["api-only", "api-shared"]);
     for _ in 0..2 {
         import(&path, revised.clone());
     }
     let conn = crate::db::open_database(&path).unwrap();
     let visible: String = conn.query_row(
         "SELECT d.document_uid FROM monitor_items mi JOIN documents d ON mi.document_id=d.id",
         [],
         |row| row.get(0),
     ).unwrap();
     assert_eq!(visible, "api-shared");
     assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_items", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
     assert_eq!(conn.query_row("SELECT COUNT(*) FROM documents", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
     drop(conn);
     let _ = std::fs::remove_dir_all(dir);
 }

 #[test]
 fn migration_merges_already_imported_publisher_editions() {
     let dir = test_directory("monitor-identity-migration");
     let path = dir.join("test.sqlite");
     crate::db::initialize_database(&path).unwrap();
     let mut github = bundle(false, "gh-edition", "https://www.pravda.com.ua/rus/news/2026/11/19/8063865/", "GitHub lead", "SNIPPET");
     github["manifest"]["run"]["started_at"] = json!("2026-11-19T11:00:00Z");
     import(&path, github);
     let conn = crate::db::open_database(&path).unwrap();
     conn.execute("DELETE FROM document_url_aliases WHERE url_key LIKE 'edition:%'", []).unwrap();
     let full_text = "A complete publication that should survive the migration. ".repeat(100);
     import(&path, bundle(true, "api-edition", "https://www.pravda.com.ua/news/2026/11/19/8063865/", &full_text, "FULL_TEXT"));
     conn.execute("INSERT INTO moderation_flags VALUES ('lukashenko','api-edition','u1','Editor','2026-11-19')", []).unwrap();
     assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_items", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
     conn.execute("DELETE FROM schema_migrations WHERE version>=8", []).unwrap();
     crate::db::initialize_database(&path).unwrap();
     assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_items", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
     assert_eq!(conn.query_row("SELECT full_text FROM documents WHERE document_uid='gh-edition'", [], |r| r.get::<_, String>(0)).unwrap(), full_text);
     assert_eq!(crate::identity::stable_uid(&conn, "api-edition").unwrap(), "gh-edition");
     assert_eq!(conn.query_row("SELECT COUNT(*) FROM moderation_flags WHERE document_uid='gh-edition'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
     let runs = crate::db::list_runs(&path, "lukashenko").unwrap();
     assert_eq!(runs.iter().find(|run| run.collector.is_none()).unwrap().publications, 1);
     assert_eq!(runs.iter().find(|run| run.collector.is_some()).unwrap().publications, 0);
     drop(conn);
     let _ = std::fs::remove_dir_all(dir);
 }

 #[test]
 fn assistant_story_collapses_overview_cards_and_keeps_archive_links() {
     let dir = test_directory("monitor-assistant-story");
     let path = dir.join("dashboard.sqlite");
     crate::db::initialize_database(&path).unwrap();
     let cases = [
         ("a", "Источник А", "Лукашенко похвалил россиян, скупающих дома в белорусских деревнях",
          "Россияне скупают пустующие дома в белорусских деревнях", ""),
         ("b", "Источник Б", "Россиян похвалили за покупку домов в соседней стране",
          "Похвалу гражданам России, приобретающим жильё в Белоруссии, высказал Лукашенко.", ""),
         ("c", "Источник В", "Лукашенко словами «батьку услышали» похвалил россиян",
          "Подробности на сайте.", "Лукашенко похвалил россиян, которые покупают дома в белорусских деревнях, и призвал соотечественников брать с них пример."),
         ("d", "Источник Г", "Лукашенко предложил выкупать арендное жильё",
          "Президент рассказал о решении жилищного вопроса и возможности выкупа арендного жилья.", ""),
     ];
     let mut package = bundle(true, "unused", "https://example.com/unused", "Preview", "SNIPPET");
     let template = package["publications"][0].clone();
     package["publications"] = Value::Array(cases.iter().enumerate().map(|(index, &(id, source, title, excerpt, _))| {
         let mut item = template.clone();
         let url = format!("https://example.com/{id}");
         item["document_id"] = json!(id);
         item["monitor_item_id"] = json!(format!("item_{id}"));
         item["source"]["name"] = json!(source);
         item["publication"]["title"] = json!(title);
         item["publication"]["excerpt"] = json!(excerpt);
         item["publication"]["url"] = json!(url);
         item["publication"]["normalized_url"] = json!(url);
         item["publication"]["published_at"] = json!(format!("2025-11-20T{:02}:00:00Z", 16-index));
         item["publication"]["preview_image_url"] = json!(format!("https://example.com/{id}.jpg"));
         item
     }).collect());
     package["run_metrics"]["final_publications"] = json!(4);
     let body = cases[2].4;
     package["full_texts"] = json!([{"schema_version":"0.3","monitor_key":"lukashenko","document_id":"c","text":body,"quality":"FULL_TEXT","text_length":body.chars().count()}]);
     let imported = import_collector_bundle(&path, package).unwrap();
     let overview = crate::db::dashboard_overview(&path, "lukashenko", None).unwrap();
     assert_eq!(overview.stories.len(), 1);
     assert_eq!(overview.stories[0].publications.len(), 3);
     assert_eq!(overview.recent.len(), 2);
     assert_eq!(overview.visuals.len(), 2);
     assert_eq!(crate::db::l_monitor_run_publications(&path, imported.run_id).unwrap().len(), 4);
     let _ = std::fs::remove_dir_all(dir);
 }

 #[test]
 fn assistant_package_updates_dashboard_and_country_counts() {
     let dir = test_directory("monitor-assistant-dashboard");
     let path = dir.join("dashboard.sqlite");
     crate::db::initialize_database(&path).unwrap();
     let mut package = bundle(true, "unused", "https://example.org/unused", "Preview", "SNIPPET");
     let template = package["publications"][0].clone();
     let rows = [
         ("one", "Example UK", "uk.example.org", "Великобритания", "Министр опроверг создание обменного фонда заключённых", "2025-11-19T10:00:00Z"),
         ("two", "Example PL", "pl.example.org", "Польша", "Лукашенко опроверг сообщения о создании обменного фонда заключенных", "2025-11-19T11:00:00Z"),
         ("three", "Example UK", "uk.example.org", "Великобритания", "Вышли новые правила оформления студенческих виз", "2025-11-19T12:00:00Z"),
         ("four", "Example DE", "de.example.org", "Германия", "Президент опроверг создание обменного фонда заключенных", "2025-12-19T10:00:00Z"),
     ];
     package["publications"] = Value::Array(rows.iter().map(|(id, name, domain, country, title, date)| {
         let mut row = template.clone();
         row["document_id"] = json!(id);
         row["monitor_item_id"] = json!(format!("item-{id}"));
         row["source"]["name"] = json!(name);
         row["source"]["configured_region"] = json!(country);
         row["publication"]["title"] = json!(title);
         row["publication"]["published_at"] = json!(date);
         let url = format!("https://{domain}/{id}");
         row["publication"]["url"] = json!(url);
         row["publication"]["normalized_url"] = json!(url);
         row
     }).collect());
     package["source_metrics"] = json!([
         {"schema_version":"0.3","monitor_key":"lukashenko","source":"Example UK","domain":"uk.example.org","source_region":"Великобритания","included":2},
         {"schema_version":"0.3","monitor_key":"lukashenko","source":"Example PL","domain":"pl.example.org","source_region":"Польша","included":1},
         {"schema_version":"0.3","monitor_key":"lukashenko","source":"Example DE","domain":"de.example.org","source_region":"Германия","included":1},
         {"schema_version":"0.3","monitor_key":"lukashenko","source":"Unused","domain":"unused.example.org","source_region":"США","included":0}
     ]);
     package["run_metrics"]["final_publications"] = json!(4);
     package["full_texts"] = json!([]);
     let imported = import_collector_bundle(&path, package).unwrap();
     let runs = crate::db::list_runs(&path, "lukashenko").unwrap();
     let countries = &runs[0].collector_countries;
     assert_eq!(countries.len(), 3);
     assert!(countries.iter().all(|row| row.sources == 1));
     let publications = crate::db::l_monitor_run_publications(&path, imported.run_id).unwrap();
     assert_eq!(publications.len(), 4);
     assert_eq!(publications[0].country.as_deref(), Some("Германия"));
     assert_eq!(publications[1].country.as_deref(), Some("Великобритания"));
     assert_eq!(publications[2].country.as_deref(), Some("Польша"));
     let dashboard = crate::db::dashboard_overview(&path, "lukashenko", None).unwrap();
     assert_eq!((dashboard.publications, dashboard.active_sources, dashboard.regions), (4, 3, 3));
     assert_eq!(dashboard.trend.iter().map(|point| point.count).sum::<i64>(), 4);
     assert_eq!(dashboard.region_breakdown.iter().map(|point| point.count).sum::<i64>(), 4);
     assert_eq!(dashboard.source_breakdown.iter().map(|point| point.count).sum::<i64>(), 4);
     assert_eq!(dashboard.stories.len(), 1);
     assert_eq!(dashboard.stories[0].publications.len(), 2);
     std::fs::remove_dir_all(dir).unwrap();
 }
}
