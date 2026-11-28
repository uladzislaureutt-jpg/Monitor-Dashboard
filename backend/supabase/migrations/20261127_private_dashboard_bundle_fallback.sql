-- Private, server-mediated backup for Dashboard Contract ZIPs.
-- Access goes only through monitor-sync Edge Function after authorization.
-- Do not grant RLS policies on storage.objects to anon/authenticated.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'monitor-dashboard-fallback',
  'monitor-dashboard-fallback',
  false,
  8388608,
  ARRAY['application/zip']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
