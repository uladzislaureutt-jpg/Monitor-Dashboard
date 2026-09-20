# Editorial AI 0.6.2

`editorial-compress` is a Supabase Edge Function used by Monitor Report Workspace.
It is separate from SE-monitor's daily Groq semantic gate: no daily-run token budget is shared or changed.

## One-time secret

The function expects a server-side secret named `GROQ_API_KEY`.
In Supabase Dashboard open the `monitor-workroom` project → Edge Functions → Secrets and add `GROQ_API_KEY` using the same Groq API key already used by SE-monitor (or a separate Groq key if preferred).

Do **not** place this key in the desktop repository or application settings.

## Security / behavior

- Function requires a valid Supabase user JWT (`verify_jwt=true`).
- Only the selected article's full text is sent to Groq when the user explicitly presses AI compression.
- Model: `openai/gpt-oss-120b`, low reasoning effort, strict JSON Schema response.
- Server rejects outputs that introduce new numeric tokens, alter direct quotes, introduce new person-like names, or fall outside conservative length bounds.
- Exact Compression is local and never calls this function.
