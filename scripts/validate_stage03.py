#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sqlite3
import zipfile
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / "src-tauri" / "schemas"
MIGRATION = ROOT / "src-tauri" / "migrations" / "0001_init.sql"


def load_bundle(path: Path):
    raw = path.read_bytes()
    with zipfile.ZipFile(io.BytesIO(raw)) as outer:
        names = outer.namelist()
        if "manifest.json" in names:
            inner = raw
            kind = "direct_bundle"
        else:
            nested = [n for n in names if n.lower().endswith(".zip") and "dashboard" in n]
            if len(nested) != 1:
                raise AssertionError(f"expected one nested dashboard zip, got {nested}")
            inner = outer.read(nested[0])
            kind = "github_artifact_wrapper"
    with zipfile.ZipFile(io.BytesIO(inner)) as z:
        manifest = json.loads(z.read("manifest.json"))
        pub_name = manifest["files"]["publications"]
        src_name = manifest["files"]["source_metrics"]
        run_name = manifest["files"]["run_metrics"]
        pubs = [json.loads(x) for x in z.read(pub_name).decode("utf-8").splitlines() if x.strip()]
        sources = [json.loads(x) for x in z.read(src_name).decode("utf-8").splitlines() if x.strip()]
        run_metrics = json.loads(z.read(run_name))
    return kind, hashlib.sha256(inner).hexdigest(), manifest, pubs, sources, run_metrics


def validate(schema_name: str, value):
    schema = json.loads((SCHEMAS / schema_name).read_text(encoding="utf-8"))
    errors = list(Draft202012Validator(schema).iter_errors(value))
    if errors:
        raise AssertionError(f"{schema_name}: {errors[0].message}")


def source_uid(name: str, domain: str | None):
    # Domain alone is not unique (e.g. many Telegram channels share t.me).
    basis = f"name:{name.strip().lower()}|domain:{(domain or '').strip().lower()}"
    return "src_" + hashlib.sha256(basis.encode()).hexdigest()[:20]


def reference_import(conn, bundle_hash, manifest, pubs, sources, run_metrics):
    mon = manifest["monitor"]
    run = manifest["run"]
    conn.execute("INSERT INTO monitors(monitor_key, display_name) VALUES (?,?) ON CONFLICT(monitor_key) DO UPDATE SET display_name=excluded.display_name", (mon["key"], mon["display_name"]))
    monitor_id = conn.execute("SELECT id FROM monitors WHERE monitor_key=?", (mon["key"],)).fetchone()[0]
    ext_key = run.get("github_run_id") or f"run:{run.get('run_number')}:{run.get('started_at')}"
    old = conn.execute("SELECT id,bundle_sha256 FROM runs WHERE monitor_id=? AND external_run_key=?", (monitor_id, ext_key)).fetchone()
    if old and old[1] == bundle_hash:
        return "already_imported", old[0]
    status = "replaced" if old else "imported"
    conn.execute(
        """INSERT INTO runs(monitor_id,external_run_key,external_run_id,run_number,build_sha,started_at,lookback_hours,dry_run,contract_version,bundle_sha256,manifest_json,run_metrics_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(monitor_id,external_run_key) DO UPDATE SET external_run_id=excluded.external_run_id,run_number=excluded.run_number,build_sha=excluded.build_sha,started_at=excluded.started_at,lookback_hours=excluded.lookback_hours,dry_run=excluded.dry_run,contract_version=excluded.contract_version,bundle_sha256=excluded.bundle_sha256,manifest_json=excluded.manifest_json,run_metrics_json=excluded.run_metrics_json,imported_at=CURRENT_TIMESTAMP""",
        (monitor_id, ext_key, run.get("github_run_id"), run.get("run_number"), run.get("github_sha"), run.get("started_at"), run.get("lookback_hours"), None if run.get("dry_run") is None else int(run["dry_run"]), manifest["dashboard_contract_version"], bundle_hash, json.dumps(manifest, ensure_ascii=False), json.dumps(run_metrics, ensure_ascii=False)),
    )
    run_id = conn.execute("SELECT id FROM runs WHERE monitor_id=? AND external_run_key=?", (monitor_id, ext_key)).fetchone()[0]
    if status == "replaced":
        conn.execute("DELETE FROM run_items WHERE run_id=?", (run_id,))
        conn.execute("DELETE FROM source_run_metrics WHERE run_id=?", (run_id,))
    source_map = {}
    for s in sources:
        uid = source_uid(s["source"], s.get("domain"))
        conn.execute("""INSERT INTO sources(source_uid,canonical_name,domain,source_type,configured_region,configured_locality,priority)
                        VALUES (?,?,?,?,?,?,?) ON CONFLICT(source_uid) DO UPDATE SET canonical_name=excluded.canonical_name""",
                     (uid,s["source"],s.get("domain"),s.get("source_type"),s.get("source_region"),s.get("source_locality"),s.get("priority")))
        sid = conn.execute("SELECT id FROM sources WHERE source_uid=?", (uid,)).fetchone()[0]
        source_map[s["source"].lower()] = sid
        conn.execute("""INSERT INTO source_run_metrics(run_id,source_id,selected_candidates,clipped_candidates,processed,fetch_ok,relevance_passed,relevance_rejected,included,event_geo_resolved,event_signature_ready,endpoint_total,endpoint_ok,endpoint_failed,access_status,admission_status,blind_zone_status,results,error,metrics_json)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,source_id) DO UPDATE SET metrics_json=excluded.metrics_json""",
                     (run_id,sid,s.get("selected_candidates"),s.get("clipped_candidates"),s.get("processed"),s.get("fetch_ok"),s.get("relevance_passed"),s.get("relevance_rejected"),s.get("included"),s.get("event_geo_resolved"),s.get("event_signature_ready"),s.get("endpoint_total"),s.get("endpoint_ok"),s.get("endpoint_failed"),s.get("access_status"),s.get("admission_status"),s.get("blind_zone_status"),s.get("results"),s.get("error"),json.dumps(s,ensure_ascii=False)))
    for p in pubs:
        src = p["source"]
        sid = source_map.get(src["name"].lower())
        if sid is None:
            uid = source_uid(src["name"], None)
            conn.execute("INSERT OR IGNORE INTO sources(source_uid,canonical_name,source_type,configured_region,configured_locality,priority) VALUES (?,?,?,?,?,?)",(uid,src["name"],src.get("type"),src.get("configured_region"),src.get("configured_locality"),src.get("priority")))
            sid = conn.execute("SELECT id FROM sources WHERE source_uid=?",(uid,)).fetchone()[0]
        pub = p["publication"]
        conn.execute("""INSERT INTO documents(document_uid,source_id,url,normalized_url,published_at,language,title,title_generated,excerpt,text_length,first_seen_at,last_seen_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(document_uid) DO UPDATE SET last_seen_at=excluded.last_seen_at""",
                     (p["document_id"],sid,pub["url"],pub["normalized_url"],pub.get("published_at"),src.get("language"),pub["title"],int(pub.get("title_generated",False)),pub.get("excerpt"),pub.get("text_length"),run.get("started_at"),run.get("started_at")))
        did=conn.execute("SELECT id FROM documents WHERE document_uid=?",(p["document_id"],)).fetchone()[0]
        c=p["classification"]
        conn.execute("""INSERT INTO monitor_items(monitor_item_uid,monitor_id,document_id,category,subcategory,signal_type,official_response,score,matched_terms,category_bonus_only,classification_schema_version,raw_json)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(monitor_item_uid) DO UPDATE SET category=excluded.category""",
                     (p["monitor_item_id"],monitor_id,did,c.get("category"),c.get("subcategory"),c.get("signal_type"),None if c.get("official_response") is None else int(c["official_response"]),c.get("score"),json.dumps(c.get("matched_terms"),ensure_ascii=False) if not isinstance(c.get("matched_terms"),str) else c.get("matched_terms"),None if c.get("category_bonus_only") is None else int(c["category_bonus_only"]),p["schema_version"],json.dumps(p,ensure_ascii=False)))
        mid=conn.execute("SELECT id FROM monitor_items WHERE monitor_item_uid=?",(p["monitor_item_id"],)).fetchone()[0]
        conn.execute("INSERT INTO run_items(run_id,monitor_item_id) VALUES (?,?) ON CONFLICT(run_id,monitor_item_id) DO NOTHING",(run_id,mid))
    conn.commit()
    return status, run_id


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("bundle", type=Path)
    ap.add_argument("--output", type=Path)
    args=ap.parse_args()
    kind,bundle_hash,manifest,pubs,sources,run_metrics=load_bundle(args.bundle)
    validate("manifest-0.1.schema.json",manifest)
    validate("run-metrics-0.1.schema.json",run_metrics)
    for p in pubs: validate("publication-0.1.schema.json",p)
    for s in sources: validate("source-metrics-0.1.schema.json",s)
    conn=sqlite3.connect(":memory:")
    conn.executescript("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);\n"+MIGRATION.read_text(encoding="utf-8"))
    conn.execute("INSERT INTO schema_migrations(version) VALUES (1)")
    first,run_id=reference_import(conn,bundle_hash,manifest,pubs,sources,run_metrics)
    counts1={t:conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ["monitors","runs","sources","documents","monitor_items","run_items","source_run_metrics"]}
    second,_=reference_import(conn,bundle_hash,manifest,pubs,sources,run_metrics)
    counts2={t:conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in counts1}
    assert first=="imported"
    assert second=="already_imported"
    assert counts1==counts2, (counts1,counts2)
    assert counts1["documents"]==len(pubs)
    assert counts1["run_items"]==len(pubs)
    assert counts1["source_run_metrics"]==len(sources)
    result={
        "status":"PASS",
        "input":str(args.bundle),
        "input_kind":kind,
        "bundle_sha256":bundle_hash,
        "contract":manifest["dashboard_contract_version"],
        "run_number":manifest["run"].get("run_number"),
        "dry_run":manifest["run"].get("dry_run"),
        "publications":len(pubs),
        "sources_in_coverage":len(sources),
        "first_import":first,
        "second_import":second,
        "counts_after_first":counts1,
        "counts_after_second":counts2,
        "schema_version":1,
    }
    text=json.dumps(result,ensure_ascii=False,indent=2)
    print(text)
    if args.output:
        args.output.write_text(text+"\n",encoding="utf-8")

if __name__=="__main__": main()
