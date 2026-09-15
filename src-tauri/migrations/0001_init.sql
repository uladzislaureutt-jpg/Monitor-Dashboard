CREATE TABLE IF NOT EXISTS monitors (
    id INTEGER PRIMARY KEY,
    monitor_key TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    external_run_key TEXT NOT NULL,
    external_run_id TEXT,
    run_number INTEGER,
    build_sha TEXT,
    started_at TEXT,
    lookback_hours INTEGER,
    dry_run INTEGER,
    contract_version TEXT NOT NULL,
    bundle_sha256 TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    manifest_json TEXT NOT NULL,
    run_metrics_json TEXT,
    UNIQUE(monitor_id, external_run_key)
);

CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY,
    source_uid TEXT NOT NULL UNIQUE,
    canonical_name TEXT NOT NULL,
    domain TEXT,
    source_type TEXT,
    country TEXT,
    configured_region TEXT,
    configured_locality TEXT,
    priority TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    document_uid TEXT NOT NULL UNIQUE,
    source_id INTEGER REFERENCES sources(id),
    url TEXT NOT NULL,
    normalized_url TEXT NOT NULL UNIQUE,
    published_at TEXT,
    language TEXT,
    title TEXT NOT NULL,
    title_generated INTEGER NOT NULL DEFAULT 0,
    excerpt TEXT,
    text_length INTEGER,
    first_seen_at TEXT,
    last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS monitor_items (
    id INTEGER PRIMARY KEY,
    monitor_item_uid TEXT NOT NULL UNIQUE,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    category TEXT,
    subcategory TEXT,
    signal_type TEXT,
    official_response INTEGER,
    score REAL,
    matched_terms TEXT,
    category_bonus_only INTEGER,
    classification_schema_version TEXT,
    raw_json TEXT NOT NULL,
    UNIQUE(monitor_id, document_id)
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    event_uid TEXT NOT NULL,
    event_signature TEXT,
    event_region TEXT,
    event_locality TEXT,
    geo_status TEXT NOT NULL DEFAULT 'unresolved',
    geo_confidence REAL,
    event_object TEXT,
    event_problem TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(monitor_id, event_uid)
);

CREATE TABLE IF NOT EXISTS event_items (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    monitor_item_id INTEGER NOT NULL REFERENCES monitor_items(id) ON DELETE CASCADE,
    relation TEXT NOT NULL DEFAULT 'primary',
    PRIMARY KEY(event_id, monitor_item_id)
);

CREATE TABLE IF NOT EXISTS run_items (
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    monitor_item_id INTEGER NOT NULL REFERENCES monitor_items(id) ON DELETE CASCADE,
    was_primary_result INTEGER NOT NULL DEFAULT 1,
    event_echo TEXT,
    event_echo_anchor TEXT,
    event_echo_sources TEXT,
    also_covered_by TEXT,
    also_covered_urls TEXT,
    PRIMARY KEY(run_id, monitor_item_id)
);

CREATE TABLE IF NOT EXISTS source_run_metrics (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    selected_candidates INTEGER,
    clipped_candidates INTEGER,
    processed INTEGER,
    fetch_ok INTEGER,
    relevance_passed INTEGER,
    relevance_rejected INTEGER,
    included INTEGER,
    event_geo_resolved INTEGER,
    event_signature_ready INTEGER,
    endpoint_total INTEGER,
    endpoint_ok INTEGER,
    endpoint_failed INTEGER,
    access_status TEXT,
    admission_status TEXT,
    blind_zone_status TEXT,
    results INTEGER,
    error TEXT,
    metrics_json TEXT NOT NULL,
    UNIQUE(run_id, source_id)
);

CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY,
    normalized_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    UNIQUE(normalized_name, entity_type)
);

CREATE TABLE IF NOT EXISTS document_entities (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    mentions INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(document_id, entity_id)
);

CREATE TABLE IF NOT EXISTS import_log (
    id INTEGER PRIMARY KEY,
    run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source_filename TEXT,
    status TEXT NOT NULL,
    details TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_monitor_started ON runs(monitor_id, started_at);
CREATE INDEX IF NOT EXISTS idx_documents_published_at ON documents(published_at);
CREATE INDEX IF NOT EXISTS idx_monitor_items_category ON monitor_items(category);
CREATE INDEX IF NOT EXISTS idx_events_region ON events(event_region);
CREATE INDEX IF NOT EXISTS idx_events_locality ON events(event_locality);
CREATE INDEX IF NOT EXISTS idx_run_items_run ON run_items(run_id);
CREATE INDEX IF NOT EXISTS idx_source_run_metrics_run ON source_run_metrics(run_id);
