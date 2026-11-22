CREATE INDEX IF NOT EXISTS idx_run_items_monitor_item ON run_items(monitor_item_id, run_id);

-- Keep raw memberships for reimports and future revisions. Select one reporting
-- run when both collectors contain the same publication.
CREATE VIEW IF NOT EXISTS suppressed_l_monitor_run_items AS
WITH l_runs AS (
    SELECT r.id, r.dry_run,
           CASE WHEN json_extract(r.manifest_json, '$.run.collector') = 'api_assistant' THEN 1 ELSE 0 END AS assistant,
           COALESCE(julianday(r.started_at), julianday(r.imported_at), 0) AS moment
    FROM runs r JOIN monitors m ON m.id = r.monitor_id
    WHERE m.monitor_key = 'lukashenko'
      AND (json_extract(r.manifest_json, '$.run.collector') = 'api_assistant'
           OR json_extract(r.manifest_json, '$.run.collector') IS NULL)
),
shared_items AS (
    SELECT ri.monitor_item_id
    FROM run_items ri JOIN l_runs r ON r.id = ri.run_id
    WHERE COALESCE(r.dry_run, 0) = 0
    GROUP BY ri.monitor_item_id
    HAVING MIN(r.assistant) <> MAX(r.assistant)
),
ranked AS (
    SELECT ri.run_id, ri.monitor_item_id,
           ROW_NUMBER() OVER (PARTITION BY ri.monitor_item_id ORDER BY r.moment, r.assistant DESC, r.id) AS position
    FROM shared_items i JOIN run_items ri ON ri.monitor_item_id = i.monitor_item_id
    JOIN l_runs r ON r.id = ri.run_id
    WHERE COALESCE(r.dry_run, 0) = 0
)
SELECT run_id, monitor_item_id FROM ranked WHERE position > 1;

CREATE VIEW IF NOT EXISTS reported_run_items AS
SELECT ri.* FROM run_items ri
LEFT JOIN suppressed_l_monitor_run_items s
    ON s.run_id = ri.run_id AND s.monitor_item_id = ri.monitor_item_id
WHERE s.run_id IS NULL;

-- Use source counts after deduplication only for runs whose shown counts changed.
CREATE VIEW IF NOT EXISTS reported_source_run_metrics AS
WITH affected AS (
    SELECT DISTINCT run_id FROM suppressed_l_monitor_run_items
),
source_counts AS (
    SELECT ri.run_id, d.source_id, COUNT(*) AS count
    FROM reported_run_items ri JOIN affected a ON a.run_id = ri.run_id
    JOIN monitor_items mi ON mi.id = ri.monitor_item_id
    JOIN documents d ON d.id = mi.document_id
    GROUP BY ri.run_id, d.source_id
)
SELECT s.id, s.run_id, s.source_id, s.selected_candidates, s.clipped_candidates, s.processed,
       s.fetch_ok, s.relevance_passed, s.relevance_rejected,
       CASE WHEN a.run_id IS NULL THEN s.included ELSE COALESCE(c.count, 0) END AS included,
       s.event_geo_resolved, s.event_signature_ready, s.endpoint_total, s.endpoint_ok, s.endpoint_failed,
       s.access_status, s.admission_status, s.blind_zone_status,
       CASE WHEN a.run_id IS NULL THEN s.results ELSE COALESCE(c.count, 0) END AS results,
       s.error, s.metrics_json
FROM source_run_metrics s
LEFT JOIN affected a ON a.run_id = s.run_id
LEFT JOIN source_counts c ON c.run_id = s.run_id AND c.source_id = s.source_id;
