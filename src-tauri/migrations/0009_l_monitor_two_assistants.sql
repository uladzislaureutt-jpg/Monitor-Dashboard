DROP VIEW IF EXISTS suppressed_l_monitor_run_items;

-- Report one membership across GitHub and both API assistants.
-- Keep raw memberships and same-assistant archive behavior intact.
CREATE VIEW suppressed_l_monitor_run_items AS
WITH l_runs AS (
    SELECT r.id, r.dry_run,
           CASE WHEN json_extract(r.manifest_json, '$.run.collector') = 'api_assistant'
                THEN 'assistant:' || COALESCE(json_extract(r.manifest_json, '$.run.assistant_id'), 1)
                ELSE 'github' END AS feed,
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
    HAVING MIN(r.feed) <> MAX(r.feed)
),
ranked AS (
    SELECT ri.run_id, ri.monitor_item_id,
           ROW_NUMBER() OVER (PARTITION BY ri.monitor_item_id ORDER BY r.moment, r.assistant DESC, r.id) AS position
    FROM shared_items i JOIN run_items ri ON ri.monitor_item_id = i.monitor_item_id
    JOIN l_runs r ON r.id = ri.run_id
    WHERE COALESCE(r.dry_run, 0) = 0
)
SELECT run_id, monitor_item_id FROM ranked WHERE position > 1;

