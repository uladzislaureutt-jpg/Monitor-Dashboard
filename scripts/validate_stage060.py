from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def validate_migrations() -> None:
    conn = sqlite3.connect(":memory:")
    for version in range(1, 6):
        path = next((ROOT / "src-tauri" / "migrations").glob(f"{version:04d}_*.sql"))
        conn.executescript(path.read_text(encoding="utf-8"))
    document_columns = {row[1] for row in conn.execute("pragma table_info(documents)")}
    assert {"full_text", "full_text_sha256", "full_text_quality", "full_text_extraction_strategy", "full_text_transport"} <= document_columns
    entity_columns = {row[1] for row in conn.execute("pragma table_info(document_entities)")}
    assert {"confidence", "method", "surface_form"} <= entity_columns


def validate_contract_markers() -> None:
    importer = (ROOT / "src-tauri" / "src" / "importer.rs").read_text(encoding="utf-8")
    models = (ROOT / "src-tauri" / "src" / "models.rs").read_text(encoding="utf-8")
    db = (ROOT / "src-tauri" / "src" / "db.rs").read_text(encoding="utf-8")
    assert "full_texts: Option<String>" in models
    assert "entities: Option<String>" in models
    assert "ingest_full_texts" in importer and "ingest_entities" in importer
    assert "JOIN document_entities de" in db and "ent.entity_type='person'" in db
    assert "fn person_regex" not in db
    assert "pub fn editorial_source" in db


def validate_versions() -> None:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    tauri = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    cargo = (ROOT / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
    assert package["version"] == "0.6.0"
    assert tauri["version"] == "0.6.0"
    assert re.search(r'^version = "0\.6\.0"$', cargo, re.M)


if __name__ == "__main__":
    validate_migrations()
    validate_contract_markers()
    validate_versions()
    print("stage060 validation: OK")
