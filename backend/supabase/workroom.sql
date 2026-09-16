-- Monitor 0.5 — shared Workroom backend for Supabase/Postgres.
-- Run once in Supabase SQL Editor as the project owner.

create extension if not exists pgcrypto;

create table if not exists public.monitor_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Пользователь',
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.monitor_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.monitor_profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(coalesce(new.email, 'Пользователь'), '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_monitor on auth.users;
create trigger on_auth_user_created_monitor
after insert on auth.users
for each row execute procedure public.monitor_handle_new_user();

-- Backfill profiles for users created before this SQL was installed.
insert into public.monitor_profiles (id, display_name)
select id, coalesce(nullif(raw_user_meta_data ->> 'display_name', ''), split_part(coalesce(email, 'Пользователь'), '@', 1))
from auth.users
on conflict (id) do nothing;

create table if not exists public.workroom_messages (
  id uuid primary key default gen_random_uuid(),
  room_key text not null default 'sep-monitor',
  kind text not null check (kind in ('note', 'announcement')),
  author_id uuid not null default auth.uid() references public.monitor_profiles(id) on delete cascade,
  author_name text not null default '',
  text text not null check (char_length(text) between 1 and 4000),
  publication_title text,
  publication_url text,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workroom_publication_url_http check (
    publication_url is null or publication_url = '' or publication_url ~ '^https?://'
  )
);

create index if not exists workroom_messages_room_time_idx
  on public.workroom_messages (room_key, pinned desc, created_at desc);

create or replace function public.monitor_prepare_workroom_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  new.author_id := auth.uid();
  select display_name into profile_name from public.monitor_profiles where id = auth.uid();
  new.author_name := coalesce(nullif(profile_name, ''), 'Пользователь');
  new.pinned := (new.kind = 'announcement');
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := coalesce(new.created_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists before_workroom_message_write on public.workroom_messages;
create trigger before_workroom_message_write
before insert or update on public.workroom_messages
for each row execute procedure public.monitor_prepare_workroom_message();

alter table public.monitor_profiles enable row level security;
alter table public.workroom_messages enable row level security;

-- Every authenticated room member may see the small user directory.
drop policy if exists monitor_profiles_read_authenticated on public.monitor_profiles;
create policy monitor_profiles_read_authenticated
on public.monitor_profiles for select
to authenticated
using (true);

-- Users may read messages after authentication. The desktop client additionally
-- filters by room_key; this installation is intended for one trusted 5–7 person team.
drop policy if exists workroom_messages_read_authenticated on public.workroom_messages;
create policy workroom_messages_read_authenticated
on public.workroom_messages for select
to authenticated
using (true);

-- INSERT: trigger pins author_id to auth.uid().
drop policy if exists workroom_messages_insert_self on public.workroom_messages;
create policy workroom_messages_insert_self
on public.workroom_messages for insert
to authenticated
with check (author_id = auth.uid());

-- DELETE: own messages, or an administrator profile.
drop policy if exists workroom_messages_delete_self_or_admin on public.workroom_messages;
create policy workroom_messages_delete_self_or_admin
on public.workroom_messages for delete
to authenticated
using (
  author_id = auth.uid()
  or exists (
    select 1 from public.monitor_profiles p
    where p.id = auth.uid() and p.is_admin = true
  )
);

-- Updates are intentionally disabled in 0.5. Messages are immutable; delete and repost.
revoke update on public.workroom_messages from authenticated;

grant select on public.monitor_profiles to authenticated;
grant select, insert, delete on public.workroom_messages to authenticated;
