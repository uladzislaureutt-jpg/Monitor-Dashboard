# Validation — Monitor 0.6.2

- Version markers updated to 0.6.2.
- DOCX generator terminates every quoted publication block with `».` before the URL paragraph.
- Exact Compression is deterministic and local; it never invents text and never inserts omission markers.
- Auto mode keeps short items nearly intact and targets ~20–40% reduction for longer items.
- AI Compression is restricted to full-text items and calls the authenticated Supabase Edge Function only on explicit user action.
- Edge Function uses `openai/gpt-oss-120b` with strict JSON Schema and server-side integrity checks for numeric tokens, person-like names and direct quotes.
- Failed AI validation does not replace the editor text.
- Report export/badge behavior and SQLite schema 6 are unchanged.
