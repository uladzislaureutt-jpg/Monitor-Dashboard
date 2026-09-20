# Validation — Monitor 0.6.3 AI Compression Corrective

- The Edge Function now rejects an insufficient reduction, not only an excessive one.
- Bounds are enforced twice: by the Edge Function and independently by Desktop before the editor text is replaced.
- A failed first Groq answer triggers exactly one retry; token counters aggregate both attempts.
- Failure preserves the existing editor text.
- The Desktop success state uses the measured source/result length, rather than trusting the server-supplied percentage.
- No SQLite migrations, changes to SE-monitor, or changes to the Groq secret flow are included.

The existing Windows GitHub Actions workflow remains the authoritative TypeScript and Tauri build check.
