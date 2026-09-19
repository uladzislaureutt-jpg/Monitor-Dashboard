# Validation — 0.6.1 network/badge corrective

- reqwest remains the primary fetch route; Windows curl is fallback only for transport/TLS and selected retryable HTTP statuses.
- Initial URL retains public http/https validation.
- Download remains capped to 2.5 MB for parsing.
- Report state now persists `revision` and `exportedRevision`; legacy drafts migrate automatically.
- Successful DOCX export calls `markExported()`; report content is not cleared.
- Any report mutation increments revision and restores the pending badge.
