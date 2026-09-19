# Monitor 0.6.1 — selected full-text corrective

Install this package over Monitor 0.6.1.

1. Copy package contents into the root of `Monitor-Dashboard` with replacement.
2. Commit the changed files.
3. Run `Build Monitor Dashboard Windows x64`.
4. Install the new Windows build over the existing application.

No SQLite migration is required. Existing runs, moderation, Workroom, Auto Sync and report drafts are preserved.

## What changes

- Report Workspace gets a deliberate second stage: **Confirm selection and get full texts**.
- Only selected report items without `full_text` are fetched (maximum 8 URLs).
- Existing Contract 0.2 full text is never fetched again.
- Successful on-demand text is cached in the existing `documents.full_text` fields in local SQLite.
- Public HTML retrieval uses JSON-LD `articleBody`, then `<article>`, `<main>`, then page paragraphs.
- Failures are reported per selection and do not block export or manual review.
- Editorial omission markers `[…]` / `[...]` are removed from report text.
- DOCX shows the literal publication URL after each item (still clickable), not the label “Ссылка на публикацию”.

This is a transitional fallback for older bundles. Contract 0.2 remains the primary full-text path.
