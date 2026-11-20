create function public.l_news_enqueue_scoped_run(p_trigger text, p_countries text[])
returns uuid language plpgsql security invoker set search_path='' as $$
declare r uuid; s public.l_news_settings; snapshot jsonb; finish timestamptz:=date_trunc('minute',now()); dkey text;
begin
 perform pg_advisory_xact_lock(hashtext('l-news-enqueue'));
 select * into s from public.l_news_settings where id=true;
 if p_trigger='scheduled' and not s.enabled then return null; end if;
 snapshot:=to_jsonb(s);
 if p_countries is not null then
  if p_trigger<>'manual' or coalesce(cardinality(p_countries),0)=0 or array_position(p_countries,null) is not null
     or not (p_countries <@ s.countries)
     or exists(select 1 from unnest(p_countries) code where not exists(
       select 1 from public.l_news_sources where country=code and enabled
     )) then
   raise exception 'invalid_countries' using errcode='22023';
  end if;
  snapshot:=snapshot || jsonb_build_object('countries',p_countries,'country_scope',p_countries);
 end if;
 select id into r from public.l_news_runs where status in ('queued','discovering','processing') order by created_at limit 1;
 if r is not null then return r; end if;
 if p_trigger='scheduled' then dkey:=(finish at time zone 'Europe/Minsk')::date::text; end if;
 insert into public.l_news_runs(trigger_kind,daily_key,from_at,to_at,settings)
 values(p_trigger,dkey,finish-make_interval(hours=>s.lookback_hours),finish,snapshot)
 on conflict(daily_key) do nothing returning id into r;
 if r is not null then insert into public.l_news_jobs(run_id,kind,dedupe_key) values(r,'setup',r::text||':setup'); end if;
 return r;
end$$;
revoke all on function public.l_news_enqueue_scoped_run(text,text[]) from public,anon,authenticated;
grant execute on function public.l_news_enqueue_scoped_run(text,text[]) to service_role;

create or replace function public.l_news_enqueue_run(p_trigger text default 'manual')
returns uuid language sql security invoker set search_path='' as $$
 select public.l_news_enqueue_scoped_run(p_trigger,null);
$$;

-- Preserve all catalog rows and measured coverage, while reducing active Russian discovery.
update public.l_news_sources set enabled=false
where country='RU' and domain not in ('1tv.ru','aif.ru','fontanka.ru','interfax.ru','iz.ru','kommersant.ru','kp.ru','meduza.io','mk.ru','novayagazeta.eu','ntv.ru','pnp.ru','rbc.ru','rg.ru','ria.ru','rtvi.com','russian.rt.com','svoboda.org','tass.ru','theins.ru','themoscowtimes.com','vedomosti.ru','vesti.ru');

-- Publisher-confirmed equivalences in the already delivered control package.
do $$
declare g record; winner uuid; duplicate_ids uuid[]; revised_run uuid; all_aliases jsonb;
begin
 for g in select * from (values
   ('lapi_1619b37fc284803e388b5c345573b3cf', array['lapi_9d5be608e54a3cce34296933c1180af5']),
   ('lapi_e2483694d5649b76f88588d9709391f8', array['lapi_27c1f5541dbb28a8a458cee03afe065d','lapi_0a3296f5c14d224dd1463cd95405cb51']),
   ('lapi_1300047e3f59ab7c93899ecf2afea0f8', array['lapi_124a3a6387ab974c5ada011bd43e9dcd'])
 ) as groups(primary_uid,duplicate_uids)
 loop
   select id,ready_run_id into winner,revised_run from public.l_news_items where document_uid=g.primary_uid and state='ready';
   if winner is null then continue; end if;
   select array_agg(id) into duplicate_ids from public.l_news_items
   where document_uid=any(g.duplicate_uids) and state='ready' and ready_run_id=revised_run
     and source_domain=(select source_domain from public.l_news_items where id=winner);
   if duplicate_ids is null then continue; end if;
   select jsonb_agg(distinct url) into all_aliases from (
     select canonical_url as url from public.l_news_items where id=winner or id=any(duplicate_ids)
     union select card#>>'{publication,url}' from public.l_news_items where id=winner or id=any(duplicate_ids)
   ) aliases where url is not null;
   update public.l_news_items
   set card=jsonb_set(jsonb_set(card,'{provenance,url_aliases}',all_aliases),
                      '{provenance,superseded_document_ids}',to_jsonb(g.duplicate_uids)),
       revision=nextval('public.l_news_revision_seq')
   where id=winner;
   update public.l_news_url_aliases set item_id=winner where item_id=any(duplicate_ids);
   update public.l_news_observations set item_id=winner,disposition='canonical_duplicate' where item_id=any(duplicate_ids);
   update public.l_news_known_urls set document_uid=g.primary_uid
     where document_uid=any(g.duplicate_uids) and origin='api_collector';
   delete from public.l_news_run_items where run_id=revised_run and item_id=any(duplicate_ids);
   update public.l_news_items set state='rejected',reason='canonical_duplicate' where id=any(duplicate_ids);
   perform public.l_news_refresh_run(revised_run);
 end loop;
end$$;
