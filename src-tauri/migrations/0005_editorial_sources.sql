ALTER TABLE documents ADD COLUMN full_text TEXT;
ALTER TABLE documents ADD COLUMN full_text_sha256 TEXT;
ALTER TABLE documents ADD COLUMN full_text_quality TEXT;
ALTER TABLE documents ADD COLUMN full_text_extraction_strategy TEXT;
ALTER TABLE documents ADD COLUMN full_text_transport TEXT;

ALTER TABLE document_entities ADD COLUMN confidence REAL;
ALTER TABLE document_entities ADD COLUMN method TEXT;
ALTER TABLE document_entities ADD COLUMN surface_form TEXT;

CREATE INDEX IF NOT EXISTS idx_entities_type_name
    ON entities(entity_type, normalized_name);
CREATE INDEX IF NOT EXISTS idx_document_entities_document
    ON document_entities(document_id);
