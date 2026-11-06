-- Deployed in Supabase migration 20261106132700 (2026-11-06).
-- TikTok / Networks: shared archive and immutable deletion tombstones.
-- Only active Monitor administrators can read or mutate these records.
create table if not exists public.tiktok_network_cards (
  item_id text primary key check (item_id ~ '^tiktok:[0-9]{10,25}$'),
  card jsonb not null check (jsonb_typeof(card)='object'
    and card->>'platform'='tiktok' and card->>'schema_version'='networks.v1'
    and card->>'item_id'=item_id and octet_length(card::text)<=40000),
  updated_at timestamptz not null default now()
);
alter table public.tiktok_network_cards enable row level security;
drop policy if exists tiktok_cards_admin_select on public.tiktok_network_cards;
create policy tiktok_cards_admin_select on public.tiktok_network_cards
  for select to authenticated using (private.monitor_is_admin((select auth.uid())));
drop policy if exists tiktok_cards_admin_insert on public.tiktok_network_cards;
create policy tiktok_cards_admin_insert on public.tiktok_network_cards
  for insert to authenticated with check (private.monitor_is_admin((select auth.uid())));
drop policy if exists tiktok_cards_admin_update on public.tiktok_network_cards;
create policy tiktok_cards_admin_update on public.tiktok_network_cards
  for update to authenticated using (private.monitor_is_admin((select auth.uid())))
  with check (private.monitor_is_admin((select auth.uid())));
revoke all on public.tiktok_network_cards from anon, authenticated;
grant select,insert,update on public.tiktok_network_cards to authenticated;
grant select,insert,update,delete on public.tiktok_network_cards to service_role;

create table if not exists public.tiktok_network_moderation (
  item_id text primary key check (item_id ~ '^tiktok:[0-9]{10,25}$'),
  flagged boolean not null default false,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.tiktok_network_moderation enable row level security;
drop policy if exists tiktok_moderation_admin_select on public.tiktok_network_moderation;
create policy tiktok_moderation_admin_select on public.tiktok_network_moderation
  for select to authenticated using (private.monitor_is_admin((select auth.uid())));
drop policy if exists tiktok_moderation_admin_insert on public.tiktok_network_moderation;
create policy tiktok_moderation_admin_insert on public.tiktok_network_moderation
  for insert to authenticated with check (private.monitor_is_admin((select auth.uid())));
drop policy if exists tiktok_moderation_admin_update on public.tiktok_network_moderation;
create policy tiktok_moderation_admin_update on public.tiktok_network_moderation
  for update to authenticated using (private.monitor_is_admin((select auth.uid())))
  with check (private.monitor_is_admin((select auth.uid())));
revoke all on public.tiktok_network_moderation from anon,authenticated;
grant select,insert,update on public.tiktok_network_moderation to authenticated;
grant select,insert,update,delete on public.tiktok_network_moderation to service_role;

create or replace function public.tiktok_upsert_cards(p_cards jsonb)
returns integer
language plpgsql security invoker set search_path=''
as $body$
declare affected integer;
begin
  if jsonb_typeof(p_cards) <> 'array' or jsonb_array_length(p_cards) > 100 then
    raise exception 'TIKTOK_CLOUD_INVALID_BATCH';
  end if;
  if exists (select 1 from jsonb_array_elements(p_cards) as x(v) where
    jsonb_typeof(v) <> 'object'
    or v->>'schema_version' <> 'networks.v1' or v->>'platform' <> 'tiktok'
    or coalesce(v->>'item_id','') !~ '^tiktok:[0-9]{10,25}$'
    or coalesce(octet_length(v::text),0) > 40000
    or v->>'included_in_current_overview' is distinct from 'true'
    or (v->'publication'->>'eligible_for_daily') is distinct from 'true'
    or (v->'publication'->>'date_status') is distinct from 'verified_original'
    or coalesce(v->>'category','') = 'REJECT'
    or coalesce(v->>'operator_lane','') not in ('candidate','review')
  ) then
    raise exception 'TIKTOK_CLOUD_INVALID_CARD';
  end if;
  insert into public.tiktok_network_cards(item_id,card)
    select v->>'item_id',v
    from jsonb_array_elements(p_cards) as x(v)
  on conflict(item_id) do update
    set card=excluded.card,updated_at=now()
    where (public.tiktok_network_cards.card->>'included_in_current_overview' is distinct from 'true')
      or coalesce((excluded.card->>'operator_reported_run')::bigint,0)
        > coalesce((public.tiktok_network_cards.card->>'operator_reported_run')::bigint,0)
      or (coalesce((excluded.card->>'operator_reported_run')::bigint,0)
        = coalesce((public.tiktok_network_cards.card->>'operator_reported_run')::bigint,0)
        and coalesce(excluded.card->>'generated_at','') > coalesce(public.tiktok_network_cards.card->>'generated_at',''));
  get diagnostics affected=row_count;
  return affected;
end;
$body$;
revoke all on function public.tiktok_upsert_cards(jsonb) from public, anon;
grant execute on function public.tiktok_upsert_cards(jsonb) to authenticated;

create or replace function public.tiktok_apply_moderation(
  p_item_id text, p_flagged boolean default null, p_delete boolean default false
) returns jsonb
language plpgsql security invoker set search_path=''
as $body$
declare result jsonb;
begin
  if p_item_id !~ '^tiktok:[0-9]{10,25}$' then
    raise exception 'TIKTOK_CLOUD_INVALID_ITEM_ID';
  end if;
  insert into public.tiktok_network_moderation (item_id,flagged,deleted,updated_by)
  values(p_item_id,coalesce(p_flagged,false),coalesce(p_delete,false),(select auth.uid()))
  on conflict(item_id) do update set
    flagged=coalesce(p_flagged,public.tiktok_network_moderation.flagged),
    deleted=public.tiktok_network_moderation.deleted or excluded.deleted,
    updated_at=now(),updated_by=(select auth.uid());
  select jsonb_build_object('item_id',item_id,'flagged',flagged,'deleted',deleted)
    into result from public.tiktok_network_moderation where item_id=p_item_id;
  return result;
end;
$body$;
revoke all on function public.tiktok_apply_moderation(text,boolean,boolean) from public, anon;
grant execute on function public.tiktok_apply_moderation(text,boolean,boolean) to authenticated;

create or replace function public.tiktok_migrate_moderation(p_deleted text[],p_flagged text[])
returns integer
language plpgsql security invoker set search_path=''
as $body$
declare affected integer;
begin
  if coalesce(cardinality(p_deleted),0)+coalesce(cardinality(p_flagged),0) > 20000 then
    raise exception 'TIKTOK_CLOUD_MIGRATION_TOO_LARGE';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_deleted,array[]::text[]) || coalesce(p_flagged,array[]::text[])) x
    where x !~ '^tiktok:[0-9]{10,25}$'
  ) then raise exception 'TIKTOK_CLOUD_MIGRATION_INVALID_ID'; end if;
  insert into public.tiktok_network_moderation(item_id,deleted,flagged,updated_by)
  select x, x=any(coalesce(p_deleted,array[]::text[])), x=any(coalesce(p_flagged,array[]::text[])),(select auth.uid())
  from (
    select distinct y as x
    from unnest(coalesce(p_deleted,array[]::text[]) || coalesce(p_flagged,array[]::text[])) y
  ) u
  on conflict (item_id) do update set
    deleted=public.tiktok_network_moderation.deleted or excluded.deleted,
    flagged=public.tiktok_network_moderation.flagged or excluded.flagged,
    updated_at=case when (not public.tiktok_network_moderation.deleted and excluded.deleted)
        or (not public.tiktok_network_moderation.flagged and excluded.flagged)
      then now() else public.tiktok_network_moderation.updated_at end;
  get diagnostics affected=row_count;
  return affected;
end;
$body$;
revoke all on function public.tiktok_migrate_moderation(text[],text[]) from public, anon;
grant execute on function public.tiktok_migrate_moderation(text[],text[]) to authenticated;

comment on table public.tiktok_network_cards is 'Shared administrator-only final TikTok cards; clients preserve the original GitHub artifact schema.';
comment on table public.tiktok_network_moderation is 'Shared administrator-only red flags and monotonic deletion tombstones; independent of device.';
