# Monitor 0.6.3 — AI Compression Corrective

Install over Monitor 0.6.2.

1. Upload the update package contents to the root of `Monitor-Dashboard`, replacing files with the same paths.
2. Commit the changes.
3. In Supabase Dashboard → `monitor-workroom` → Edge Functions, deploy the included replacement for `editorial-compress` with `verify_jwt=true`.
4. Run `Build Monitor Dashboard Windows x64` in GitHub Actions and install the resulting Windows build over the current application.

No SQLite migration is required. Existing archive, Workroom session, Auto Sync settings and unfinished report basket are retained.

## Expected result

- **Auto** uses Light for a short text and Standard for a longer text.
- Light accepts only 3–14% reduction; Standard accepts only 18–42%.
- A result such as 0.1% is never applied. The function makes one corrective retry, then leaves the current editor text untouched and reports an error.
- The success notice shows the effective mode, actual reduction, attempts and total tokens, for example: `AI · Стандарт · сокращение 31.4% · 1 попытка · 2 143 токена`.

`GROQ_API_KEY` stays only in the existing Supabase secret. It is not added to the desktop application or repository.
