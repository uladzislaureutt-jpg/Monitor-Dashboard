CREATE TABLE IF NOT EXISTS document_url_aliases (
  url_key TEXT PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_document_url_alias_document ON document_url_aliases(document_id);
CREATE TABLE IF NOT EXISTS document_uid_aliases (
  alias_uid TEXT PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_document_uid_alias_document ON document_uid_aliases(document_id);
