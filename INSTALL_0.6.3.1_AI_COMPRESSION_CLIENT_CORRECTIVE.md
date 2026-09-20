# Monitor 0.6.3.1 — AI Compression Client Corrective

Install over Monitor 0.6.2.

1. Upload the update package contents to the root of `Monitor-Dashboard`, replacing files with the same paths.
2. Commit the changes.
3. Run `Build Monitor Dashboard Windows x64` in GitHub Actions and install the resulting Windows build over the current application.

No SQLite migration is required. Existing archive, Workroom session, Auto Sync settings and unfinished report basket are retained.

## Important

Do **not** deploy an Edge Function from this package. The existing `monitor-workroom` function `editorial-compress` is already active as v5 and is stronger than the original 0.6.2 source: it enforces the valid range, retries an invalid AI answer, and can use its local Exact fallback.

This client corrective calculates the reduction independently from the returned text. It rejects 0.1% and any other out-of-range answer before it replaces the editor. The success message displays the effective mode, actual percentage, number of attempts, token total, and explicitly labels an Exact fallback.

`GROQ_API_KEY` remains unchanged and server-side only.
