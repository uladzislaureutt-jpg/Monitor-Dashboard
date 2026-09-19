# Validation — Monitor 0.6.1 selected full-text corrective

Validated in packaging environment:

- TypeScript/TSX syntax transpilation: OK for `reportWorkspace.tsx`, `ReportView.tsx`, `api.ts`, `types.ts`.
- Tauri command wiring: `hydrate_report_full_texts` is registered and limited to at most 8 document IDs.
- Existing full text returns `already_present`; only missing texts enter network retrieval.
- On successful retrieval the text is stored in the existing Contract 0.2 SQLite columns; no schema migration is required.
- Retrieval is restricted to HTTP/HTTPS and rejects direct localhost/private IP URLs.
- Extraction order: JSON-LD `articleBody` -> `<article>` paragraphs -> `<main>` paragraphs -> page paragraphs.
- `[…]` and `[...]` are removed in editor normalization and again defensively at DOCX export.
- DOCX visible hyperlink text is the publication URL itself.

Rust/Windows final compilation remains verified by the repository GitHub Actions Windows build.
