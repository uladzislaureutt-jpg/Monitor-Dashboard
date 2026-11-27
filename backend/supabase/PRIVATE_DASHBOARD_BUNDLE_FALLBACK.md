# Supabase private fallback for SE-Monitor dashboard bundles

## Purpose

The normal producer remains `SE-monitor/.github/workflows/dashboard-export.yml`
(GitHub Actions artifact `dashboard-bundle-social-<run>`). If GitHub Actions
cannot start the exporter because of a billing quota, the original
`social-report-<run>` may still be present. Rebuild the Dashboard Contract 0.2
ZIP outside Actions, then publish it **once** into private Supabase Storage.
Existing Monitor desktop clients can sync it automatically using the same
`monitor-sync` API and existing JWT login; no client upgrade is required
for **reading** the fallback.

This is a delivery fallback, **not an automatic report-rebuilding service**.
The administrator must provide a valid finished ZIP (or upload it via the
Supabase project dashboard).

## Backend

Project: `monitor-workroom` / `kcmmnngcjfmyjzzczvko`.
Private bucket: `monitor-dashboard-fallback`. File size limit 8 MiB;
ZIP MIME only; `storage.objects` has no anon/authenticated RLS policies.

Only active, authorized Monitor users can invoke `monitor-sync` to list or
download. Only users with `monitor_profiles.is_admin=true` can use
`action:"publish"`. The Edge Function uses the service key server-side,
never sends it to clients, and checks the final ZIP before publishing.

Object path: `social_economic/dashboard-bundle-social-<run>.zip`.
A new upload for an existing run number is rejected if its SHA-256 differs;
an identical upload is idempotent. No overwrite/delete endpoint is exposed.

New server operations:
- `list`: combine GitHub artifacts with private storage; prefer GitHub
  when both exist for the same run, but continue from Supabase alone if the
  GitHub API is unavailable. The response is compatible with pre-existing
  native `ServerArtifact` (`u64 id`, `name`, `run_number`).
- `download`: normal GitHub IDs are unchanged. Reserved positive IDs
  `1_000_000_000_000 + run_number` load a verified private ZIP.
- `publish`: admin-only, social_economic only, accepts
  `zip_base64` and optional `run_number`; validates contract 0.2,
  source key, production mode, run identity, files, publication IDs and counts.

## Administrator upload

In an updated Monitor desktop build, open **SE-Monitor → Данные →
Резервная доставка через Supabase → Опубликовать ZIP**, select the
**direct** `dashboard_bundle_social_223.zip` (not the outer GitHub artifact
ZIP), and check the resulting run number and publication count.

As a temporary fallback before the updated desktop build is available,
a Supabase project administrator can upload the ZIP manually in
**Supabase Dashboard → Storage → monitor-dashboard-fallback →
social_economic**. Rename it to `dashboard-bundle-social-223.zip`
before uploading (adjust the run number). The server still revalidates the
downloaded ZIP before serving it to clients. Manual Storage upload bypasses
the stricter admin-publish validation, so only use a verified, genuine
bundle ZIP. Do **not** make the bucket public.

## Client import and troubleshooting

The desktop app calls `monitor-sync` with `action:"list"` and `action:"download"`,
not direct Storage endpoints. On the next normal sync it receives missing
runs, imports them with its existing ZIP importer, and preserves the
original run number. No duplicate import is expected for an already
present identical run.

Verify the new upload is present by listing Storage objects in the private
bucket; app's next sync should show it as a new run. The existing
`SocialDashboardExporter` from SE-Monitor remains the canonical builder.
Do not rerun paid monitoring to recover an export failure.

Keep retention/size under control; no automatic Storage clean-up is
configured. Never publish credentials, article HTML, or tokens in logs.

## Test plan and constraints

`deno test backend/supabase/functions/monitor-sync/bundle-fallback.test.ts`
checks id mapping, ZIP validation, base64, and checksum.
`npm run check` validates the React/TypeScript upload view once
GitHub Actions billing becomes available. Deployment was performed from
`backend/supabase/functions/monitor-sync` at function version 31;
runtime auth and private-bucket metadata were separately verified.

No live authenticated publish/download smoke test was performed automatically
because ChatGPT is not holding an operator's Supabase Auth session. Full
delivery is verified when the first administrator upload is followed by
a sync from a separate authorized client.
