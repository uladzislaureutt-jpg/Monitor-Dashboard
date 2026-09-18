CREATE TABLE IF NOT EXISTS moderation_flags (
    monitor_key TEXT NOT NULL,
    document_uid TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    flagged_at TEXT NOT NULL,
    PRIMARY KEY (monitor_key, document_uid, user_id)
);

CREATE TABLE IF NOT EXISTS moderation_exclusions (
    monitor_key TEXT NOT NULL,
    document_uid TEXT NOT NULL,
    excluded_by_name TEXT NOT NULL,
    excluded_at TEXT NOT NULL,
    PRIMARY KEY (monitor_key, document_uid)
);

CREATE INDEX IF NOT EXISTS idx_moderation_flags_document
    ON moderation_flags(monitor_key, document_uid);
CREATE INDEX IF NOT EXISTS idx_moderation_exclusions_document
    ON moderation_exclusions(monitor_key, document_uid);
