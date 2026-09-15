CREATE TABLE IF NOT EXISTS sync_run_status (
    monitor_key TEXT NOT NULL,
    run_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    artifact_id INTEGER,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(monitor_key, run_number)
);

CREATE INDEX IF NOT EXISTS idx_sync_run_status_monitor ON sync_run_status(monitor_key, status, run_number);
