-- Corrected and applied after the initial review-lane migration.
create or replace function public.tiktok_upsert_cards(p_cards jsonb)
returns integer
language plpgsql security invoker set search_path=''
as $body$
declare affected integer;
begin
  if jsonb_typeof(p_cards) <> 'array' or jsonb_array_length(p_cards)>100 then
    raise exception 'TIKTOK_CLOUD_INVALID_BATCH';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_cards) as x(v)
    where jsonb_typeof(v) <> 'object'
      or v->>'schema_version' <> 'networks.v1'
      or v->>'platform' <> 'tiktok'
      or coalesce(v->>'item_id','') !~ '^tiktok:[0-9]{10,25}$'
      or coalesce(v->>'source_url','') !~ '^https://(www\.)?tiktok\.com/@[^/]+/(video|photo)/[0-9]{10,25}/?$'
      or substring(v->>'item_id' from 8) <> substring(v->>'source_url' from '/([0-9]{10,25})/?')
      or octet_length(v::text)>65000
      or coalesce(v->>'category','') not in ('P1','P2','P3','G','S','REVIEW','REJECT')
      or not (
        (v->>'included_in_current_overview'='true'
         and coalesce(v->>'operator_review_lane','main')='main'
         and v->'publication'->>'eligible_for_daily'='true'
         and v->'publication'->>'date_status'='verified_original'
         and v->>'category'<>'REJECT'
         and v->>'operator_lane' in ('candidate','review'))
        or
        (v->>'operator_review_lane' in ('gemini_veto','triage')
         and v->>'included_in_current_overview'='false'
         and v->>'report_suppressed'='true'
         and coalesce(v->>'already_reported','false')='false'
         and coalesce(v->>'operator_review_seen_run','') ~ '^[0-9]{1,12}$'
         and (v->>'operator_review_lane'='triage'
           or v->>'operator_review_model_proposed' in ('P1','P2','P3','S')
           or v->>'operator_review_triage_lane'='gemini_positive_veto'))
        )
  ) then
    raise exception 'TIKTOK_CLOUD_INVALID_CARD';
  end if;

  insert into public.tiktok_network_cards(item_id,card)
    select v->>'item_id',v from jsonb_array_elements(p_cards) as x(v)
  on conflict (item_id) do update
    set card=case
      -- An operator-published main card outranks later unverified near misses.
      when public.tiktok_network_cards.card->>'included_in_current_overview'='true'
           and excluded.card->>'included_in_current_overview'='false'
        then case when nullif(public.tiktok_network_cards.card->>'preview_image_url','') is null
                       and nullif(excluded.card->>'preview_image_url','') is not null
          then public.tiktok_network_cards.card || jsonb_build_object(
            'preview_image_url',excluded.card->>'preview_image_url')
          else public.tiktok_network_cards.card end
      -- Newly published operator cards always outrank an older audit-only card.
      when excluded.card->>'included_in_current_overview'='true'
           and public.tiktok_network_cards.card->>'included_in_current_overview'='false'
        then case when nullif(excluded.card->>'preview_image_url','') is null
                       and nullif(public.tiktok_network_cards.card->>'preview_image_url','') is not null
          then excluded.card || jsonb_build_object(
            'preview_image_url',public.tiktok_network_cards.card->>'preview_image_url')
          else excluded.card end
      -- Otherwise prefer a newer operator run, with media-only enrichment safe.
      when (coalesce((excluded.card->>'operator_reported_run')::bigint,
                     (excluded.card->>'operator_review_seen_run')::bigint,0),
            coalesce(excluded.card->>'generated_at',''))
           >=
           (coalesce((public.tiktok_network_cards.card->>'operator_reported_run')::bigint,
                     (public.tiktok_network_cards.card->>'operator_review_seen_run')::bigint,0),
            coalesce(public.tiktok_network_cards.card->>'generated_at',''))
        then case when nullif(excluded.card->>'preview_image_url','') is null
                       and nullif(public.tiktok_network_cards.card->>'preview_image_url','') is not null
          then excluded.card || jsonb_build_object(
            'preview_image_url',public.tiktok_network_cards.card->>'preview_image_url')
          else excluded.card end
      else case when nullif(public.tiktok_network_cards.card->>'preview_image_url','') is null
                       and nullif(excluded.card->>'preview_image_url','') is not null
        then public.tiktok_network_cards.card || jsonb_build_object(
          'preview_image_url',excluded.card->>'preview_image_url')
        else public.tiktok_network_cards.card end
    end,
    updated_at=now()
    where public.tiktok_network_cards.card is distinct from
      (case
        when public.tiktok_network_cards.card->>'included_in_current_overview'='true'
          and excluded.card->>'included_in_current_overview'='false'
          then case when nullif(public.tiktok_network_cards.card->>'preview_image_url','') is null
                     and nullif(excluded.card->>'preview_image_url','') is not null
            then public.tiktok_network_cards.card || jsonb_build_object(
              'preview_image_url',excluded.card->>'preview_image_url')
            else public.tiktok_network_cards.card end
        when excluded.card->>'included_in_current_overview'='true'
          and public.tiktok_network_cards.card->>'included_in_current_overview'='false'
          then case when nullif(excluded.card->>'preview_image_url','') is null
                     and nullif(public.tiktok_network_cards.card->>'preview_image_url','') is not null
            then excluded.card || jsonb_build_object('preview_image_url',
              public.tiktok_network_cards.card->>'preview_image_url')
            else excluded.card end
        when (coalesce((excluded.card->>'operator_reported_run')::bigint,
                       (excluded.card->>'operator_review_seen_run')::bigint,0),
              coalesce(excluded.card->>'generated_at',''))
             >= (coalesce((public.tiktok_network_cards.card->>'operator_reported_run')::bigint,
                        (public.tiktok_network_cards.card->>'operator_review_seen_run')::bigint,0),
                 coalesce(public.tiktok_network_cards.card->>'generated_at',''))
          then case when nullif(excluded.card->>'preview_image_url','') is null
                     and nullif(public.tiktok_network_cards.card->>'preview_image_url','') is not null
            then excluded.card || jsonb_build_object('preview_image_url',
              public.tiktok_network_cards.card->>'preview_image_url')
            else excluded.card end
        else case when nullif(public.tiktok_network_cards.card->>'preview_image_url','') is null
                     and nullif(excluded.card->>'preview_image_url','') is not null
          then public.tiktok_network_cards.card || jsonb_build_object('preview_image_url',
            excluded.card->>'preview_image_url')
          else public.tiktok_network_cards.card end
      end);
  get diagnostics affected=row_count;
  return affected;
end;
$body$;
