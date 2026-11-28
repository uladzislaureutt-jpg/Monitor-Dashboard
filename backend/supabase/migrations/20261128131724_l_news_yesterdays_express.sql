-- Independent delayed NewsData stream; shared catalog, aliases and cards.
create table public.l_news_newsdata_settings (
 id boolean primary key default true check(id), enabled boolean not null default true,
 lookback_hours integer not null default 26 check(lookback_hours between 1 and 168),
 local_time text not null default '12:17' check(local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 timezone text not null default 'Europe/Minsk' check(timezone='Europe/Minsk'),
 countries text[] not null,
 newsdata_per_run integer not null default 80 check(newsdata_per_run between 0 and 180),
 newsdata_daily_credits integer not null default 80 check(newsdata_daily_credits between 0 and 200),
 newsdata_monthly_credits integer not null default 2400 check(newsdata_monthly_credits between 0 and 6000),
 newsdata_reserve integer not null default 40 check(newsdata_reserve between 0 and 199),
 candidate_limit integer not null default 1200 check(candidate_limit between 10 and 3000),
 rechecks_per_run integer not null default 20 check(rechecks_per_run between 0 and 50),
 paid_extractions_per_run integer not null default 0 check(paid_extractions_per_run=0),
 catalog_version text not null default 'shared-with-assistants', updated_at timestamptz not null default now()
);
insert into public.l_news_newsdata_settings(id,countries) select true,array_agg(distinct country order by country) from public.l_news_sources where enabled;
alter table public.l_news_newsdata_settings enable row level security;
revoke all on public.l_news_newsdata_settings from public,anon,authenticated;
grant all on public.l_news_newsdata_settings to service_role;
create policy service_only on public.l_news_newsdata_settings for all to service_role using(true) with check(true);
alter table public.l_news_runs drop constraint l_news_runs_assistant_id_check;
alter table public.l_news_runs add constraint l_news_runs_assistant_id_check check(assistant_id in(1,2,3));

create function public.l_news_enqueue_newsdata_run(p_trigger text default 'manual',p_countries text[] default null)
returns uuid language plpgsql security invoker set search_path='' as $$
declare r uuid;s public.l_news_newsdata_settings;snapshot jsonb;
 collected timestamptz:=date_trunc('minute',now());finish timestamptz;dkey text;
begin
 perform pg_advisory_xact_lock(hashtext('l-news-enqueue-3'));
 select * into strict s from public.l_news_newsdata_settings where id=true;
 if p_trigger not in('manual','scheduled','test') then raise exception 'invalid_trigger' using errcode='22023';end if;
 if p_trigger='scheduled' and not s.enabled then return null;end if;
 finish:=collected-interval '12 hours 1 minute';
 snapshot:=to_jsonb(s)||jsonb_build_object('assistant_id',3,'availability_delay_hours',12,'collection_started_at',collected,'perigon_per_run',0,'newscatcher_per_run',0,'gdelt_per_run',0);
 if p_countries is not null then
  if p_trigger='scheduled' or coalesce(cardinality(p_countries),0)=0 or array_position(p_countries,null) is not null or not(p_countries<@s.countries)
   or exists(select 1 from unnest(p_countries) c where not exists(select 1 from public.l_news_sources where country=c and enabled)) then
    raise exception 'invalid_countries' using errcode='22023';end if;
  snapshot:=snapshot||jsonb_build_object('countries',p_countries,'country_scope',p_countries);
 end if;
 select id into r from public.l_news_runs where assistant_id=3 and status in('queued','discovering','processing') order by created_at limit 1;
 if r is not null then return r;end if;
 if p_trigger='scheduled' then dkey:='newsdata:'||(collected at time zone 'Europe/Minsk')::date::text;end if;
 insert into public.l_news_runs(assistant_id,trigger_kind,daily_key,from_at,to_at,settings)
 values(3,p_trigger,dkey,finish-make_interval(hours=>s.lookback_hours),finish,snapshot)
 on conflict(daily_key) do nothing returning id into r;
 if r is not null then insert into public.l_news_jobs(run_id,kind,dedupe_key) values(r,'setup',r::text||':setup');end if;
 return r;
end$$;
revoke all on function public.l_news_enqueue_newsdata_run(text,text[]) from public,anon,authenticated;
grant execute on function public.l_news_enqueue_newsdata_run(text,text[]) to service_role;

create function public.l_news_newsdata_usage() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('newsdata',jsonb_build_object(
 'today_units',coalesce(sum(coalesce(u.credits,1)) filter(where u.created_at>=((now() at time zone 'Europe/Minsk')::date::timestamp at time zone 'Europe/Minsk')),0),
 'period_units',coalesce(sum(coalesce(u.credits,1)),0)))
 from public.l_news_usage u join public.l_news_runs r on r.id=u.run_id
 where r.assistant_id=3 and u.provider='newsdata' and u.billable and u.created_at>=now()-interval '30 days';
$$;
revoke all on function public.l_news_newsdata_usage() from public,anon,authenticated;
grant execute on function public.l_news_newsdata_usage() to service_role;

create function public.l_news_reserve_newsdata_call(p_run uuid,p_job bigint,p_page integer) returns bigint
language plpgsql security invoker set search_path='' as $$
declare s jsonb;id_value bigint;balance numeric;checked timestamptz;reserved numeric;
 day_start timestamptz:=((now() at time zone 'Europe/Minsk')::date::timestamp at time zone 'Europe/Minsk');
 utc_start timestamptz:=((now() at time zone 'UTC')::date::timestamp at time zone 'UTC');
begin
 perform pg_advisory_xact_lock(hashtext('l-news-usage-newsdata'));
 select settings into strict s from public.l_news_runs where id=p_run and assistant_id=3 and status<>'cancelled';
 if not exists(select 1 from public.l_news_jobs where id=p_job and run_id=p_run and kind='newsdata') then raise exception 'invalid_job';end if;
 if (select count(*) from public.l_news_usage where run_id=p_run and provider='newsdata' and billable)>=(s->>'newsdata_per_run')::integer then return null;end if;
 if (select coalesce(sum(coalesce(u.credits,1)),0) from public.l_news_usage u join public.l_news_runs r on r.id=u.run_id where r.assistant_id=3 and u.provider='newsdata' and u.billable and u.created_at>=day_start)+1>(s->>'newsdata_daily_credits')::integer then return null;end if;
 if (select coalesce(sum(coalesce(u.credits,1)),0) from public.l_news_usage u join public.l_news_runs r on r.id=u.run_id where r.assistant_id=3 and u.provider='newsdata' and u.billable and u.created_at>=now()-interval '30 days')+1>(s->>'newsdata_monthly_credits')::integer then return null;end if;
 select nullif(info#>>'{limits,remaining}','')::numeric,updated_at into balance,checked from public.l_news_provider_state where provider='newsdata';
 if balance is null or checked<utc_start then
  balance:=200;checked:=utc_start;
 end if;
 select coalesce(sum(coalesce(credits,1)),0) into reserved from public.l_news_usage where provider='newsdata' and billable and (status is null or status=0 or created_at>checked);
 if balance-reserved-1<(s->>'newsdata_reserve')::integer then return null;end if;
 insert into public.l_news_usage(run_id,job_id,provider,endpoint,page,credits,details)
 values(p_run,p_job,'newsdata','newsdata_search',p_page,1,jsonb_build_object('assistant_id',3)) returning id into id_value;
 return id_value;
end$$;
revoke all on function public.l_news_reserve_newsdata_call(uuid,bigint,integer) from public,anon,authenticated;
grant execute on function public.l_news_reserve_newsdata_call(uuid,bigint,integer) to service_role;

-- Seed the already measured balance without another paid request.
insert into public.l_news_provider_state(provider,info,updated_at)
 select 'newsdata',jsonb_build_object('configured',true,'limits',jsonb_build_object('limit',200,'remaining',(details#>>'{response_headers,x-api-limit-remaining}')::integer)),created_at
 from public.l_news_usage where provider='newsdata' and details#>>'{response_headers,x-api-limit-remaining}' ~ '^[0-9]+$'
 order by id desc limit 1 on conflict(provider) do nothing;

create function l_news_private.daily_newsdata() returns void language plpgsql security invoker set search_path='' as $$begin
 if exists(select 1 from public.l_news_newsdata_settings where id=true and enabled and local_time=to_char(now() at time zone 'Europe/Minsk','HH24:MI')) then
  perform public.l_news_enqueue_newsdata_run('scheduled',null);perform l_news_private.wake();
 end if;
end$$;
revoke all on function l_news_private.daily_newsdata() from public,anon,authenticated;
select cron.schedule('l-news-newsdata-daily','* * * * *','select l_news_private.daily_newsdata();');

CREATE OR REPLACE FUNCTION public.l_news_refresh_run(p_run uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare c jsonb;w jsonb;pending bigint;failures bigint;st text;begin
 select count(*) filter(where state in ('waiting','leased')),count(*) filter(where state='failed') into pending,failures from public.l_news_jobs where run_id=p_run;
 select coalesce(jsonb_agg(distinct public.l_news_warning_ru(message)),'[]') into w from (
  select error as message from public.l_news_jobs where run_id=p_run and state='failed' and error is not null
  union all select 'Достигнут лимит запросов: '||kind from public.l_news_jobs where run_id=p_run and result->>'capped'='true'
  union all select jsonb_array_elements_text(result->'warnings') from public.l_news_jobs where run_id=p_run and jsonb_typeof(result->'warnings')='array'
 ) t;
 select jsonb_build_object(
  'found',(select count(*) from public.l_news_observations where run_id=p_run),
  'already_known',(select count(*) from public.l_news_observations where run_id=p_run and disposition in ('already_reported_github','already_ready')),
  'unique_candidates',count(*),
  'ready',count(*) filter(where i.state='ready' and (i.ready_run_id=p_run or ri.role='upgrade')),
  'new_articles',count(*) filter(where i.state='ready' and i.ready_run_id=p_run),
  'full_texts',count(*) filter(where i.state='ready' and i.content_level='FULL_TEXT' and (i.ready_run_id=p_run or ri.role='upgrade')),
  'previews',count(*) filter(where i.state='ready' and i.content_level<>'FULL_TEXT' and (i.ready_run_id=p_run or ri.role='upgrade')),
  'pending',count(*) filter(where i.state='pending'),
  'rejected',count(*) filter(where i.state='rejected'),
  'failed_articles',count(*) filter(where i.state='failed'),
  'jobs_pending',pending,'jobs_failed',failures,'content_revision',coalesce(max(i.revision),0),
  'perigon_requests',(select count(*) from public.l_news_usage where run_id=p_run and provider='perigon' and billable),
  'newscatcher_requests',(select count(*) from public.l_news_usage where run_id=p_run and provider='newscatcher' and billable),
  'newscatcher_credits',(select coalesce(sum(credits),0) from public.l_news_usage where run_id=p_run and provider='newscatcher'),
  'gdelt_requests',(select count(*) from public.l_news_usage where run_id=p_run and provider='gdelt'),
  'paid_extractions',(select count(*) from public.l_news_usage where run_id=p_run and provider='webscrapingai'),
  'cloro_requests',(select count(*) from public.l_news_usage where run_id=p_run and provider='cloro' and billable),
  'cloro_credits',(select coalesce(sum(credits),0) from public.l_news_usage where run_id=p_run and provider='cloro'),
  'currents_requests',(select count(*) from public.l_news_usage where run_id=p_run and provider='currents' and billable),
  'thenews_requests',(select count(*) from public.l_news_usage where run_id=p_run and provider='thenews' and billable),
  'newsdata_requests',(select count(*) from public.l_news_usage where run_id=p_run and provider='newsdata' and billable),
  'newsdata_credits',(select coalesce(sum(credits),0) from public.l_news_usage where run_id=p_run and provider='newsdata'),
  'catalog_sources',(select count(*) from public.l_news_sources where enabled)
 ) into c from public.l_news_run_items ri join public.l_news_items i on i.id=ri.item_id where ri.run_id=p_run;
 if pending>0 then st:='processing';elsif failures>0 or jsonb_array_length(w)>0 then st:='partial';else st:='completed';end if;
 update public.l_news_runs set counters=c,warnings=w,status=st,
  revision=case when counters is distinct from c or warnings is distinct from w or status<>st then nextval('public.l_news_revision_seq') else revision end,
  completed_at=case when pending=0 then coalesce(completed_at,now()) else null end,updated_at=now()
 where id=p_run and status<>'cancelled';
 return c;
end$function$;

-- Serialize measured balances; a late response must not raise today's balance.
create function public.l_news_finish_newsdata_call(p_usage bigint,p_status integer,p_credits integer,p_count integer,p_elapsed integer,p_details jsonb,p_limits jsonb,p_retry_at timestamptz)
returns void language plpgsql security invoker set search_path='' as $$
declare previous public.l_news_provider_state;remaining numeric;rate_remaining numeric;utc_start timestamptz:=((now() at time zone 'UTC')::date::timestamp at time zone 'UTC');
begin
 perform pg_advisory_xact_lock(hashtext('l-news-usage-newsdata'));
 update public.l_news_usage set status=p_status,credits=p_credits,result_count=p_count,elapsed_ms=p_elapsed,details=p_details where id=p_usage and provider='newsdata';
 if p_limits is null then return;end if;
 select * into previous from public.l_news_provider_state where provider='newsdata';
 if previous.updated_at>=utc_start then
  remaining:=least(nullif(previous.info#>>'{limits,remaining}','')::numeric,nullif(p_limits->>'remaining','')::numeric);
  if remaining is not null then p_limits:=jsonb_set(p_limits,'{remaining}',to_jsonb(remaining));end if;
  if previous.info#>>'{limits,rate_reset}'=p_limits->>'rate_reset' then
   rate_remaining:=least(nullif(previous.info#>>'{limits,rate_remaining}','')::numeric,nullif(p_limits->>'rate_remaining','')::numeric);
   if rate_remaining is not null then p_limits:=jsonb_set(p_limits,'{rate_remaining}',to_jsonb(rate_remaining));end if;
  end if;
 end if;
 insert into public.l_news_provider_state(provider,info,updated_at)
 values('newsdata',jsonb_build_object('configured',true,'limits',p_limits,'retry_at',p_retry_at,'last_usage_id',p_usage),now())
 on conflict(provider) do update set info=excluded.info,updated_at=excluded.updated_at;
end$$;
revoke all on function public.l_news_finish_newsdata_call(bigint,integer,integer,integer,integer,jsonb,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.l_news_finish_newsdata_call(bigint,integer,integer,integer,integer,jsonb,jsonb,timestamptz) to service_role;
