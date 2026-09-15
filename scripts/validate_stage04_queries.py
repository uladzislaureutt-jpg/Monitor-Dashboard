#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path

from validate_stage03 import MIGRATION, load_bundle, reference_import


def add_events(conn: sqlite3.Connection, manifest: dict, pubs: list[dict]) -> None:
    monitor_key = manifest["monitor"]["key"]
    monitor_id = conn.execute("SELECT id FROM monitors WHERE monitor_key=?", (monitor_key,)).fetchone()[0]
    for item in pubs:
        event = item.get("event") or {}
        if not any(event.get(key) for key in ("signature", "region", "locality", "object", "problem")):
            continue
        if event.get("signature"):
            basis = f"{monitor_key}|signature|{event['signature']}"
        else:
            basis = f"{monitor_key}|item|{item['monitor_item_id']}"
        uid = "evt_" + hashlib.sha256(basis.encode()).hexdigest()[:24]
        conn.execute(
            """INSERT INTO events(monitor_id,event_uid,event_signature,event_region,event_locality,geo_status,geo_confidence,event_object,event_problem)
               VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(monitor_id,event_uid) DO UPDATE SET event_region=excluded.event_region,event_locality=excluded.event_locality,event_object=excluded.event_object,event_problem=excluded.event_problem""",
            (monitor_id, uid, event.get("signature"), event.get("region"), event.get("locality"), event.get("geo_status") or "unresolved", event.get("geo_confidence"), event.get("object"), event.get("problem")),
        )
        event_id = conn.execute("SELECT id FROM events WHERE monitor_id=? AND event_uid=?", (monitor_id, uid)).fetchone()[0]
        mid = conn.execute("SELECT id FROM monitor_items WHERE monitor_item_uid=?", (item["monitor_item_id"],)).fetchone()[0]
        conn.execute("INSERT OR REPLACE INTO event_items(event_id,monitor_item_id,relation) VALUES (?,?,'primary')", (event_id, mid))
    conn.commit()


def period_clause(alias: str, parameter: str) -> str:
    return f"({parameter} IS NULL OR ({alias}.published_at IS NOT NULL AND datetime({alias}.published_at) >= datetime('now', '-' || {parameter} || ' days')))"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    _, bundle_hash, manifest, pubs, sources, run_metrics = load_bundle(args.bundle)
    conn = sqlite3.connect(":memory:")
    conn.executescript("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);\n" + MIGRATION.read_text(encoding="utf-8"))
    conn.execute("INSERT INTO schema_migrations(version) VALUES (1)")
    reference_import(conn, bundle_hash, manifest, pubs, sources, run_metrics)
    add_events(conn, manifest, pubs)

    monitor_key = manifest["monitor"]["key"]
    period_days = 30
    period = period_clause("d", "?2")
    base = f"FROM monitor_items mi JOIN monitors m ON m.id=mi.monitor_id JOIN documents d ON d.id=mi.document_id LEFT JOIN sources s ON s.id=d.source_id LEFT JOIN event_items ei ON ei.monitor_item_id=mi.id AND ei.relation='primary' LEFT JOIN events e ON e.id=ei.event_id WHERE m.monitor_key=?1 AND {period}"
    publications = conn.execute(f"SELECT COUNT(DISTINCT mi.id) {base}", (monitor_key, period_days)).fetchone()[0]
    active_sources = conn.execute(f"SELECT COUNT(DISTINCT d.source_id) {base}", (monitor_key, period_days)).fetchone()[0]
    regions = conn.execute(f"SELECT COUNT(DISTINCT NULLIF(TRIM(e.event_region),'')) {base}", (monitor_key, period_days)).fetchone()[0]
    categories = conn.execute(f"SELECT COUNT(DISTINCT NULLIF(TRIM(mi.category),'')) {base}", (monitor_key, period_days)).fetchone()[0]

    search_query = "вод"
    search_filters = f"""
        m.monitor_key=?1 AND {period}
        AND (?3='' OR d.title LIKE '%' || ?3 || '%' OR COALESCE(d.excerpt,'') LIKE '%' || ?3 || '%' OR COALESCE(s.canonical_name,'') LIKE '%' || ?3 || '%' OR COALESCE(mi.category,'') LIKE '%' || ?3 || '%' OR COALESCE(mi.subcategory,'') LIKE '%' || ?3 || '%' OR COALESCE(mi.matched_terms,'') LIKE '%' || ?3 || '%' OR COALESCE(e.event_region,'') LIKE '%' || ?3 || '%' OR COALESCE(e.event_locality,'') LIKE '%' || ?3 || '%' OR COALESCE(e.event_object,'') LIKE '%' || ?3 || '%' OR COALESCE(e.event_problem,'') LIKE '%' || ?3 || '%')
        AND (?4='' OR mi.category=?4) AND (?5='' OR e.event_region=?5) AND (?6='' OR s.canonical_name=?6)
    """
    from_sql = "FROM monitor_items mi JOIN monitors m ON m.id=mi.monitor_id JOIN documents d ON d.id=mi.document_id LEFT JOIN sources s ON s.id=d.source_id LEFT JOIN event_items ei ON ei.monitor_item_id=mi.id AND ei.relation='primary' LEFT JOIN events e ON e.id=ei.event_id"
    search_total = conn.execute(f"SELECT COUNT(DISTINCT mi.id) {from_sql} WHERE {search_filters}", (monitor_key, None, search_query, "", "", "")).fetchone()[0]

    all_sources = conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0]

    source_sql = r"""
        SELECT s.id, s.canonical_name, s.domain, s.source_type, s.configured_region, s.configured_locality, s.priority,
        (SELECT COUNT(DISTINCT mi.document_id) FROM documents d JOIN monitor_items mi ON mi.document_id=d.id JOIN monitors m ON m.id=mi.monitor_id WHERE d.source_id=s.id AND m.monitor_key=?1) AS publications,
        COALESCE((SELECT SUM(COALESCE(srm.results,0)) FROM source_run_metrics srm JOIN runs r ON r.id=srm.run_id JOIN monitors m ON m.id=r.monitor_id WHERE srm.source_id=s.id AND m.monitor_key=?1),0) AS total_results,
        (SELECT MAX(d.published_at) FROM documents d WHERE d.source_id=s.id) AS last_seen_at,
        (SELECT srm.access_status FROM source_run_metrics srm JOIN runs r ON r.id=srm.run_id JOIN monitors m ON m.id=r.monitor_id WHERE srm.source_id=s.id AND m.monitor_key=?1 ORDER BY COALESCE(r.started_at,r.imported_at) DESC, r.id DESC LIMIT 1) AS access_status,
        (SELECT srm.admission_status FROM source_run_metrics srm JOIN runs r ON r.id=srm.run_id JOIN monitors m ON m.id=r.monitor_id WHERE srm.source_id=s.id AND m.monitor_key=?1 ORDER BY COALESCE(r.started_at,r.imported_at) DESC, r.id DESC LIMIT 1) AS admission_status
        FROM sources s
        WHERE EXISTS (SELECT 1 FROM source_run_metrics srm JOIN runs r ON r.id=srm.run_id JOIN monitors m ON m.id=r.monitor_id WHERE srm.source_id=s.id AND m.monitor_key=?1)
           OR EXISTS (SELECT 1 FROM documents d JOIN monitor_items mi ON mi.document_id=d.id JOIN monitors m ON m.id=mi.monitor_id WHERE d.source_id=s.id AND m.monitor_key=?1)
        ORDER BY LOWER(s.canonical_name), s.id
    """
    source_rows = conn.execute(source_sql, (monitor_key,)).fetchall()
    coverage_sources = conn.execute("SELECT COUNT(*) FROM source_run_metrics").fetchone()[0]
    region_rows = conn.execute(f"SELECT COALESCE(NULLIF(TRIM(e.event_region),''),'Не определён'), COUNT(DISTINCT mi.id) {base} GROUP BY 1 ORDER BY 2 DESC", (monitor_key, period_days)).fetchall()

    all_time_publications = conn.execute("SELECT COUNT(DISTINCT mi.id) FROM monitor_items mi JOIN monitors m ON m.id=mi.monitor_id WHERE m.monitor_key=?", (monitor_key,)).fetchone()[0]
    assert all_time_publications == len(pubs), (all_time_publications, len(pubs))
    assert publications == len([p for p in pubs if p["publication"].get("published_at")]), (publications, len(pubs))
    assert all_sources == len(sources), (all_sources, len(sources))
    assert coverage_sources == len(sources), (coverage_sources, len(sources))
    assert len(source_rows) == len(sources), (len(source_rows), len(sources))
    assert categories > 0
    assert search_total > 0

    result = {
        "status": "PASS",
        "run_number": manifest["run"].get("run_number"),
        "publications_30d": publications,
        "publications_all_time": all_time_publications,
        "active_sources_30d": active_sources,
        "regions_30d": regions,
        "categories_30d": categories,
        "catalog_sources": all_sources,
        "source_query_rows": len(source_rows),
        "search_query": search_query,
        "search_results_all_time": search_total,
        "region_breakdown": [{"label": label, "count": count} for label, count in region_rows],
    }
    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.output:
        args.output.write_text(text + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
