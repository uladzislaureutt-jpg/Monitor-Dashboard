-- Consolidate confirmed editions of one publisher in the same transaction as publication.
create or replace function public.l_news_merge_edition(p_winner uuid, p_duplicate uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare
  winner public.l_news_items;
  duplicate public.l_news_items;
  urls jsonb;
  replaced jsonb;
begin
  select * into winner from public.l_news_items where id=p_winner for update;
  select * into duplicate from public.l_news_items where id=p_duplicate for update;
  if winner.id is null or duplicate.id is null or winner.id=duplicate.id
     or winner.state<>'ready' or winner.source_domain is distinct from duplicate.source_domain then
    raise exception 'invalid_publisher_edition_merge';
  end if;

  select jsonb_agg(value order by value) into urls from (
    select jsonb_array_elements_text(coalesce(winner.card#>'{provenance,url_aliases}','[]'))
    union select jsonb_array_elements_text(coalesce(duplicate.card#>'{provenance,url_aliases}','[]'))
    union select winner.canonical_url
    union select duplicate.canonical_url
  ) merged(value);
  replaced:=coalesce(winner.card#>'{provenance,superseded_document_ids}','[]');
  if duplicate.card is not null then
    select jsonb_agg(value order by value) into replaced from (
      select jsonb_array_elements_text(replaced)
      union select duplicate.document_uid
      union select jsonb_array_elements_text(coalesce(duplicate.card#>'{provenance,superseded_document_ids}','[]'))
    ) merged(value);
  end if;
  update public.l_news_items
  set card=case when replaced='[]'::jsonb then jsonb_set(winner.card,'{provenance,url_aliases}',urls)
                else jsonb_set(jsonb_set(winner.card,'{provenance,url_aliases}',urls),'{provenance,superseded_document_ids}',replaced) end,
      revision=nextval('public.l_news_revision_seq'),updated_at=now()
  where id=winner.id;

  update public.l_news_url_aliases set item_id=winner.id where item_id=duplicate.id;
  update public.l_news_observations set item_id=winner.id,disposition='canonical_duplicate' where item_id=duplicate.id;
  insert into public.l_news_run_items(run_id,item_id,role)
  select run_id,winner.id,case when run_id=winner.ready_run_id then 'new' when role='upgrade' then 'upgrade' else 'seen' end
  from public.l_news_run_items where item_id=duplicate.id on conflict (run_id,item_id) do nothing;
  delete from public.l_news_run_items where item_id=duplicate.id;
  update public.l_news_known_urls set document_uid=winner.document_uid
  where document_uid=duplicate.document_uid and origin='api_collector';
  update public.l_news_items set state='rejected',reason='canonical_duplicate',updated_at=now() where id=duplicate.id;
  update public.l_news_runs set revision=nextval('public.l_news_revision_seq'),updated_at=now() where id=winner.ready_run_id;
end;
$$;
revoke all on function public.l_news_merge_edition(uuid,uuid) from public,anon,authenticated;
grant execute on function public.l_news_merge_edition(uuid,uuid) to service_role;

create or replace function public.l_news_publish_edition(
  p_key text,p_item uuid,p_run uuid,p_canonical text,p_aliases text[],p_card jsonb,p_full_text jsonb,p_level text,p_published timestamptz
) returns boolean
language plpgsql security invoker set search_path='' as $$
declare
  owner uuid;
  alias text;
begin
  owner:=public.l_news_claim_alias(p_key,p_item);
  if owner<>p_item then
    perform public.l_news_merge_edition(owner,p_item);
    return false;
  end if;
  update public.l_news_items set state='ready',reason=null,card=p_card,full_text=p_full_text,content_level=p_level,
    published_at=p_published,ready_at=now(),ready_run_id=p_run,revision=nextval('public.l_news_revision_seq'),updated_at=now()
  where id=p_item and state not in ('ready','rejected');
  if not found then
    if exists(select 1 from public.l_news_items where id=p_item and state='ready') then return true; end if;
    raise exception 'edition_candidate_missing';
  end if;

  foreach alias in array p_aliases loop
    perform public.l_news_claim_alias(alias,p_item);
  end loop;
  insert into public.l_news_known_urls(canonical_url,document_uid,origin,content_level,aliases,observed_at)
  select p_canonical,document_uid,'api_collector',p_level,p_aliases,now()
  from public.l_news_items where id=p_item
  on conflict(canonical_url) do update set document_uid=excluded.document_uid,content_level=excluded.content_level,
    aliases=excluded.aliases,observed_at=excluded.observed_at
  where l_news_known_urls.origin='api_collector';
  return true;
end;
$$;
revoke all on function public.l_news_publish_edition(text,uuid,uuid,text,text[],jsonb,jsonb,text,timestamptz) from public,anon,authenticated;
grant execute on function public.l_news_publish_edition(text,uuid,uuid,text,text[],jsonb,jsonb,text,timestamptz) to service_role;

-- Restore the confirmed edition pairs already delivered in runs 1 and 3.
do $$
declare
  pair record;
  affected record;
  winner uuid;
  duplicate uuid;
  affected_runs uuid[]:=array[]::uuid[];
begin
  for pair in select * from (values
    ('edition:tsn.ua:3222839','tsn.ua','lapi_c31012d7b71ab3cdb8a69b233a0da804','lapi_586e05f8e645a030de67a30219a92611'),
    ('edition:tsn.ua:3222555','tsn.ua','lapi_25ecbb8c47ba0817b34f5693a75ee792','lapi_5c6808925b6101ba77d625c52839b684'),
    ('edition:pravda.com.ua:8063865','pravda.com.ua','lapi_93f10e60b1949938777f279a510c7533','lapi_1c81c245e3ebb1e78173a76c3e61a87d'),
    ('edition:https://rbc.ua/news/rf-pereveli-droni-molniya-optiku-video-znishchennya-1795089124.html','rbc.ua','lapi_dd8da13a2c1480846bd7e0a19834be9d','lapi_4242ead96fdedf7a90f52cea66e7a34a')
  ) pairs(edition_key,domain,primary_uid,duplicate_uid)
  loop
    select i.id,r.id as run_id into affected from public.l_news_items i join public.l_news_runs r on r.id=i.ready_run_id
    where i.document_uid=pair.primary_uid and i.source_domain=pair.domain and i.state='ready' and r.number in (1,3);
    winner:=affected.id;
    select id into duplicate from public.l_news_items where document_uid=pair.duplicate_uid and source_domain=pair.domain
      and state='ready' and ready_run_id=affected.run_id;
    if winner is not null and duplicate is not null then
      if public.l_news_claim_alias(pair.edition_key,winner)<>winner then raise exception 'backfill_edition_already_claimed'; end if;
      perform public.l_news_merge_edition(winner,duplicate);
      affected_runs:=array_append(affected_runs,affected.run_id);
    end if;
  end loop;
  for affected in select id,counters->'catalog_sources' as catalog_size from public.l_news_runs where id=any(affected_runs)
  loop
    perform public.l_news_refresh_run(affected.id);
    if affected.catalog_size is not null then
      update public.l_news_runs set counters=jsonb_set(counters,'{catalog_sources}',affected.catalog_size) where id=affected.id;
    end if;
  end loop;
end;
$$;

update public.l_news_sources set enabled=false where domain='rg.ru' and enabled;
