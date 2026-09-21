# Monitor 0.6.5 — Quote hotfix

Install over `0.6.4` by replacing the files from this archive in the root of `Monitor-Dashboard`, commit the changes, then run `Build Monitor Dashboard Windows x64`.

The DOCX exporter now preserves correctly oriented `«` and `»`. It converts only straight and non-Russian curly quotes, so a name such as `«Дикие животные»` remains in that order.

This is a local export-only fix. Supabase `editorial-compress` remains active as v6; AI modes and the two-run per-publication limit are unchanged.
