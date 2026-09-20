# Monitor 0.6.4 — Editorial export and AI guard

Install over the working client corrective `0.6.3.1` by replacing files with the same paths in the root of `Monitor-Dashboard`.

Then commit the changes, run `Build Monitor Dashboard Windows x64`, and install the generated build over the current application.

## Included

- DOCX export produces one closing period after the generated closing quote: `…в дальнейшем».`.
- All export quotation marks are normalized to `«…»`.
- Long dashes are normalized to `–`; hyphens inside words remain `-`.
- `Максимальная 40–60%` is available for both Exact and AI compression.
- AI compression is persistently limited to two outgoing requests per publication. A failed request is counted because it may already have consumed tokens.

## Important

The Supabase Edge Function `editorial-compress` has already been updated to v6 and now validates Maximum strictly within 40–60%. This package does not contain secrets or require any further Supabase deployment.

No database migration, secret update or SE-monitor change is required.
