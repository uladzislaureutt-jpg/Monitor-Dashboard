# Monitor 0.6.2 — Editorial Compression

Install over the latest Monitor 0.6.1 Report Workspace UX corrective.

1. Upload the update package contents to the root of `Monitor-Dashboard`, replacing files.
2. Commit the changes.
3. Run `Build Monitor Dashboard Windows x64` in GitHub Actions.
4. Install the new Windows build over the current application.

No SQLite migration is required. Existing archive, moderation, Workroom session, Auto Sync settings and unfinished report basket are retained.

## AI prerequisite

Exact Compression works immediately and locally.
AI Compression requires one server-side Supabase secret: `GROQ_API_KEY` in the existing `monitor-workroom` project. The key must never be embedded into the desktop application.
