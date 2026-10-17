-- Applied to monitor-workroom Supabase on 2026-10-17. Reusable schema definition.
create table if not exists public.monitor_admin_notes (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Новая памятка' check (char_length(title) between 1 and 120),
  body text not null default '' check (char_length(body) <= 12000),
  image_paths jsonb not null default '[]'::jsonb
    check (jsonb_typeof(image_paths) = 'array' and jsonb_array_length(image_paths) <= 6),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.monitor_admin_notes enable row level security;
revoke all on public.monitor_admin_notes from anon, authenticated;
grant select, insert, update, delete on public.monitor_admin_notes to service_role;
create index if not exists monitor_admin_notes_updated_idx on public.monitor_admin_notes(updated_at desc);
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('monitor-admin-notes','monitor-admin-notes',false,3000000,
        array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set public=false,file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;
-- All operations use the admin-notebook Edge Function with server-side admin guard.
-- There are intentionally no public/authenticated SELECT/INSERT/UPDATE/DELETE policies.
