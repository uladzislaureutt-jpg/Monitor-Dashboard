-- Monitor 0.5.3 — shared publication moderation for the Workroom.

create table if not exists public.publication_flags (
  room_key text not null default 'sep-monitor',
  monitor_key text not null default 'social_economic',
  document_uid text not null,
  user_id uuid not null default auth.uid() references public.monitor_profiles(id) on delete cascade,
  user_name text not null default '',
  created_at timestamptz not null default now(),
  primary key (room_key, monitor_key, document_uid, user_id)
);

create table if not exists public.publication_exclusions (
  room_key text not null default 'sep-monitor',
  monitor_key text not null default 'social_economic',
  document_uid text not null,
  excluded_by uuid not null default auth.uid() references public.monitor_profiles(id) on delete cascade,
  excluded_by_name text not null default '',
  created_at timestamptz not null default now(),
  primary key (room_key, monitor_key, document_uid)
);

create index if not exists publication_flags_document_idx
  on public.publication_flags(room_key, monitor_key, document_uid);
create index if not exists publication_flags_user_id_idx
  on public.publication_flags(user_id);
create index if not exists publication_exclusions_excluded_by_idx
  on public.publication_exclusions(excluded_by);

create or replace function public.monitor_prepare_publication_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare profile_name text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  new.user_id := auth.uid();
  select display_name into profile_name from public.monitor_profiles where id = auth.uid();
  new.user_name := coalesce(nullif(profile_name,''),'Пользователь');
  new.created_at := coalesce(new.created_at, now());
  return new;
end;
$$;

drop trigger if exists before_publication_flag_write on public.publication_flags;
create trigger before_publication_flag_write
before insert or update on public.publication_flags
for each row execute procedure public.monitor_prepare_publication_flag();

create or replace function public.monitor_prepare_publication_exclusion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare profile_name text; admin_value boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select display_name, is_admin into profile_name, admin_value from public.monitor_profiles where id = auth.uid();
  if coalesce(admin_value,false) is not true then raise exception 'Administrator required'; end if;
  new.excluded_by := auth.uid();
  new.excluded_by_name := coalesce(nullif(profile_name,''),'Администратор');
  new.created_at := coalesce(new.created_at, now());
  return new;
end;
$$;

drop trigger if exists before_publication_exclusion_write on public.publication_exclusions;
create trigger before_publication_exclusion_write
before insert or update on public.publication_exclusions
for each row execute procedure public.monitor_prepare_publication_exclusion();

alter table public.publication_flags enable row level security;
alter table public.publication_exclusions enable row level security;

drop policy if exists publication_flags_read_authenticated on public.publication_flags;
create policy publication_flags_read_authenticated on public.publication_flags
for select to authenticated using (true);

drop policy if exists publication_flags_insert_self on public.publication_flags;
create policy publication_flags_insert_self on public.publication_flags
for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists publication_flags_delete_self_or_admin on public.publication_flags;
create policy publication_flags_delete_self_or_admin on public.publication_flags
for delete to authenticated using (
  user_id = (select auth.uid())
  or exists(select 1 from public.monitor_profiles p where p.id=(select auth.uid()) and p.is_admin=true)
);

drop policy if exists publication_exclusions_read_authenticated on public.publication_exclusions;
create policy publication_exclusions_read_authenticated on public.publication_exclusions
for select to authenticated using (true);

drop policy if exists publication_exclusions_insert_admin on public.publication_exclusions;
create policy publication_exclusions_insert_admin on public.publication_exclusions
for insert to authenticated with check (
  exists(select 1 from public.monitor_profiles p where p.id=(select auth.uid()) and p.is_admin=true)
);

drop policy if exists publication_exclusions_delete_admin on public.publication_exclusions;
create policy publication_exclusions_delete_admin on public.publication_exclusions
for delete to authenticated using (
  exists(select 1 from public.monitor_profiles p where p.id=(select auth.uid()) and p.is_admin=true)
);

revoke update on public.publication_flags from authenticated;
revoke update on public.publication_exclusions from authenticated;
grant select, insert, delete on public.publication_flags to authenticated;
grant select, insert, delete on public.publication_exclusions to authenticated;

revoke all on function public.monitor_prepare_publication_flag() from public, anon, authenticated;
revoke all on function public.monitor_prepare_publication_exclusion() from public, anon, authenticated;
