# TikTok thumbnail sync — Monitor 0.8.81

The approved TikTok-Monitor report may carry an optional `preview_image_url`
in each `networks.v1` entry of `networks_cards.jsonl`.

- **Photo posts:** HTTPS image URLs on TikTok CDN hosts (`tiktokcdn.com`,
  `tiktokcdn-us.com`, or `tiktokv.com` and their subdomains).
- **Extracted video frames:** small JPEG previews as
  `data:image/jpeg;base64,...` (maximum 40,000 characters).
- **Missing or broken image:** show the original text-only card; do not
  substitute an unrelated thumbnail.
- The same preview can appear in **Обзор TikTok**, **Архив**, and the selected
  video's original description block in **Редактор обзора**.
- The importer retains verified metadata and keeps operator labels, flags and
  deletion tombstones unchanged. Images added by a late report do not roll back
  a newer operator decision.
- Supabase stores the optional image as part of the existing admin-only card,
  now limited to **65,000 bytes per JSONB card**, so an already uploaded
  card can be enriched without forcing a new GitHub run.
- Old reports without `preview_image_url` remain valid. No video download,
  new paid scraper, or new API token is needed by Monitor.

**Producer requirement:** save the preview in the approved card's
`preview_image_url` field in `networks_cards.jsonl`. JPGs stored only as
unreferenced ZIP sidecars are not imported. The bundled JSONL SHA-256
manifest remains authoritative for the import.
