# Validation — Monitor 0.6.3.1 AI Compression Client Corrective

- Desktop measures the actual source/result reduction rather than trusting a server percentage.
- Light accepts only 3–14%; Standard accepts only 18–42%.
- The current server contract's `effective_mode`, `retried`, `fallback`, and token telemetry are displayed correctly.
- An Exact fallback is labelled, not presented as a successful AI rewrite.
- No SQLite migration, Supabase schema change, secret change, or Edge Function deployment is included.

The existing Windows GitHub Actions workflow is the authoritative TypeScript and Tauri build check.
