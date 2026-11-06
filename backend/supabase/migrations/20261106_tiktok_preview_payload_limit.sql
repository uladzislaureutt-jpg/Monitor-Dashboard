-- Align the shared TikTok final-card payload size with source-side 40 KB JPEG previews.
-- Keep the same public API, security invoker / admin RLS, and operator provenance.
alter table public.tiktok_network_cards drop constraint if exists tiktok_network_cards_check;
alter table public.tiktok_network_cards add constraint tiktok_network_cards_check
  check (jsonb_typeof(card)='object' and card->>'platform'='tiktok'
     and card->>'schema_version'='networks.v1'
     and card->>'item_id'=item_id and octet_length(card::text)<=65000);

-- TikTok posters: allow late optional image enrichment in already synced final cards.
-- No schema or RLS change; older clients continue to use the same RPC.
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
    or coalesce(octet_length(v::text),0) > 65000
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
  on conflict(item_id) do update set
    card = case
      -- New operator content must win, but preserve an old thumbnail if
      -- a newer export omits optional preview metadata.
      when (public.tiktok_network_cards.card->>'included_in_current_overview' is distinct from 'true')
        or (coalesce((excluded.card->>'operator_reported_run')::bigint,0),
            coalesce(excluded.card->>'generated_at',''))
           > (coalesce((public.tiktok_network_cards.card->>'operator_reported_run')::bigint,0),
              coalesce(public.tiktok_network_cards.card->>'generated_at',''))
      then case when nullif(excluded.card->>'preview_image_url','') is null
                  and nullif(public.tiktok_network_cards.card->>'preview_image_url','') is not null
        then excluded.card || jsonb_build_object('preview_image_url',
          public.tiktok_network_cards.card->>'preview_image_url')
        else excluded.card end
      -- Late media enrichment must not revert a final operator verdict.
      else public.tiktok_network_cards.card || jsonb_build_object(
        'preview_image_url',excluded.card->>'preview_image_url')
    end,
    updated_at=now()
  where (public.tiktok_network_cards.card->>'included_in_current_overview' is distinct from 'true')
    or (coalesce((excluded.card->>'operator_reported_run')::bigint,0),
        coalesce(excluded.card->>'generated_at',''))
       > (coalesce((public.tiktok_network_cards.card->>'operator_reported_run')::bigint,0),
          coalesce(public.tiktok_network_cards.card->>'generated_at',''))
    or (nullif(public.tiktok_network_cards.card->>'preview_image_url','') is null
        and nullif(excluded.card->>'preview_image_url','') is not null);
  get diagnostics affected=row_count;
  return affected;
end;
$body$;

