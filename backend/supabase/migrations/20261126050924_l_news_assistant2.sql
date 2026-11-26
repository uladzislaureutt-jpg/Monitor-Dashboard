-- Two independently controlled assistants, one source catalog and publication index.
create table public.l_news_assistant2_settings (
 id boolean primary key default true check(id),
 enabled boolean not null default true,
 lookback_hours integer not null default 26 check(lookback_hours between 1 and 168),
 local_time text not null default '03:07' check(local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 timezone text not null default 'Europe/Minsk' check(timezone='Europe/Minsk'),
 countries text[] not null,
 newscatcher_enabled boolean not null default true,
 newscatcher_per_run integer not null default 32 check(newscatcher_per_run between 0 and 100),
 newscatcher_daily_credits integer not null default 200 check(newscatcher_daily_credits between 0 and 2000),
 newscatcher_monthly_credits integer not null default 3500 check(newscatcher_monthly_credits between 0 and 20000),
 newscatcher_reserve integer not null default 500 check(newscatcher_reserve between 0 and 10000),
 cloro_enabled boolean not null default true,
 cloro_per_run integer not null default 4 check(cloro_per_run between 0 and 20),
 cloro_daily_credits integer not null default 12 check(cloro_daily_credits between 0 and 300),
 cloro_monthly_credits integer not null default 360 check(cloro_monthly_credits between 0 and 10000),
 cloro_reserve integer not null default 20 check(cloro_reserve between 0 and 500),
 cloro_countries text[] not null default array['PL','UA','RU','DE','FR','US','IT'],
 currents_enabled boolean not null default true,
 currents_languages text[] not null default array['de'],
 currents_per_run integer not null default 4 check(currents_per_run between 0 and 30),
 currents_daily_requests integer not null default 20 check(currents_daily_requests between 0 and 250),
 currents_monthly_requests integer not null default 600 check(currents_monthly_requests between 0 and 7500),
 currents_reserve integer not null default 10 check(currents_reserve between 0 and 100),
 paid_extractions_per_run integer not null default 4 check(paid_extractions_per_run between 0 and 10),
 candidate_limit integer not null default 1200 check(candidate_limit between 10 and 3000),
 catalog_version text not null default 'shared-with-assistant1',
 updated_at timestamptz not null default now()
);
insert into public.l_news_assistant2_settings(id,countries,lookback_hours)
 select true,countries,lookback_hours from public.l_news_settings where id=true;
alter table public.l_news_assistant2_settings enable row level security;
revoke all on public.l_news_assistant2_settings from public,anon,authenticated;
grant all on public.l_news_assistant2_settings to service_role;
create policy service_only on public.l_news_assistant2_settings for all to service_role using(true) with check(true);

alter table public.l_news_runs add column assistant_id smallint not null default 1 check(assistant_id in(1,2));
alter table public.l_news_runs add column assistant_number bigint;
update public.l_news_runs set assistant_number=number;
alter table public.l_news_runs alter column assistant_number set not null;
create unique index l_news_assistant_number on public.l_news_runs(assistant_id,assistant_number);
create index l_news_assistant_recent on public.l_news_runs(assistant_id,created_at desc);
create function l_news_private.number_assistant_run() returns trigger
language plpgsql security invoker set search_path='' as $$begin
 if new.assistant_number is null then
  perform pg_advisory_xact_lock(hashtext('l-news-number-'||new.assistant_id));
  select coalesce(max(assistant_number),0)+1 into new.assistant_number from public.l_news_runs where assistant_id=new.assistant_id;
 end if;
 return new;
end$$;
revoke all on function l_news_private.number_assistant_run() from public,anon,authenticated;
create trigger l_news_number_assistant before insert on public.l_news_runs
 for each row execute function l_news_private.number_assistant_run();

create function public.l_news_enqueue_assistant2_run(p_trigger text default 'manual',p_countries text[] default null)
returns uuid language plpgsql security invoker set search_path='' as $$
declare r uuid;s public.l_news_assistant2_settings;snapshot jsonb;finish timestamptz:=date_trunc('minute',now());dkey text;
begin
 perform pg_advisory_xact_lock(hashtext('l-news-enqueue-2'));
 select * into strict s from public.l_news_assistant2_settings where id=true;
 if p_trigger='scheduled' and not s.enabled then return null;end if;
 if p_trigger not in('manual','scheduled','test') then raise exception 'invalid_trigger' using errcode='22023';end if;
 snapshot:=to_jsonb(s)||jsonb_build_object('assistant_id',2,'perigon_per_run',0,'gdelt_per_run',0);
 if p_countries is not null then
  if p_trigger='scheduled' or cardinality(p_countries)=0 or array_position(p_countries,null) is not null or not(p_countries<@s.countries)
    or exists(select 1 from unnest(p_countries) c where not exists(select 1 from public.l_news_sources where country=c and enabled)) then
   raise exception 'invalid_countries' using errcode='22023';
  end if;
  snapshot:=snapshot||jsonb_build_object('countries',p_countries,'country_scope',p_countries);
 end if;
 select id into r from public.l_news_runs where assistant_id=2 and status in('queued','discovering','processing') order by created_at limit 1;
 if r is not null then return r;end if;
 if p_trigger='scheduled' then dkey:='assistant2:'||(finish at time zone 'Europe/Minsk')::date::text;end if;
 insert into public.l_news_runs(assistant_id,trigger_kind,daily_key,from_at,to_at,settings)
 values(2,p_trigger,dkey,finish-make_interval(hours=>s.lookback_hours),finish,snapshot)
 on conflict(daily_key) do nothing returning id into r;
 if r is not null then insert into public.l_news_jobs(run_id,kind,dedupe_key) values(r,'setup',r::text||':setup');end if;
 return r;
end$$;
revoke all on function public.l_news_enqueue_assistant2_run(text,text[]) from public,anon,authenticated;
grant execute on function public.l_news_enqueue_assistant2_run(text,text[]) to service_role;

-- Reserve charges before requests, under a shared provider lock. Unknown outcomes
-- remain charged conservatively. Async Cloro retries reuse one reservation/key.
create function public.l_news_reserve_assistant2_call(p_run uuid,p_job bigint,p_provider text,p_endpoint text,p_page integer)
returns bigint language plpgsql security invoker set search_path='' as $$
declare s jsonb;unit_cost integer;run_cap integer;day_cap integer;period_cap integer;id_value bigint;
 balance numeric;checked timestamptz;reserved numeric;reserve_floor integer;
 day_start timestamptz:=((now() at time zone 'Europe/Minsk')::date::timestamp at time zone 'Europe/Minsk');
begin
 if p_provider not in('newscatcher','cloro','currents') then raise exception 'invalid_provider';end if;
 perform pg_advisory_xact_lock(hashtext('l-news-usage-'||p_provider));
 select settings into strict s from public.l_news_runs where id=p_run and assistant_id=2 and status<>'cancelled';
 if not exists(select 1 from public.l_news_jobs where id=p_job and run_id=p_run) then raise exception 'invalid_job';end if;
 if p_provider='cloro' then
  select id into id_value from public.l_news_usage where run_id=p_run and job_id=p_job and provider=p_provider and endpoint=p_endpoint and page=p_page order by id limit 1;
  if id_value is not null then return id_value;end if;
 end if;
 unit_cost:=case p_provider when 'newscatcher' then 5 when 'cloro' then 3 else 1 end;
 run_cap:=coalesce((s->>(p_provider||'_per_run'))::integer,0);
 day_cap:=coalesce((s->>(case when p_provider='currents' then 'currents_daily_requests' else p_provider||'_daily_credits' end))::integer,0);
 period_cap:=coalesce((s->>(case when p_provider='currents' then 'currents_monthly_requests' else p_provider||'_monthly_credits' end))::integer,0);
 reserve_floor:=coalesce((s->>(p_provider||'_reserve'))::integer,0);
 if not coalesce((s->>(p_provider||'_enabled'))::boolean,false) then return null;end if;
 if (select count(*) from public.l_news_usage where run_id=p_run and provider=p_provider and billable)>=run_cap then return null;end if;
 if (select coalesce(sum(coalesce(u.credits,unit_cost)),0) from public.l_news_usage u join public.l_news_runs r on r.id=u.run_id
     where r.assistant_id=2 and u.provider=p_provider and u.billable and u.created_at>=day_start)+unit_cost>day_cap then return null;end if;
 if (select coalesce(sum(coalesce(u.credits,unit_cost)),0) from public.l_news_usage u join public.l_news_runs r on r.id=u.run_id
     where r.assistant_id=2 and u.provider=p_provider and u.billable and u.created_at>=now()-interval '30 days')+unit_cost>period_cap then return null;end if;
 if p_provider='newscatcher' then
  select nullif(info#>>'{subscription,credits_balance}','')::numeric,updated_at into balance,checked from public.l_news_provider_state where provider=p_provider;
 elsif p_provider='cloro' then
  select nullif(info#>>'{balance,remaining}','')::numeric,updated_at into balance,checked from public.l_news_provider_state where provider=p_provider;
 else
  select nullif(info#>>'{limits,remaining}','')::numeric,updated_at into balance,checked from public.l_news_provider_state where provider=p_provider;
  if checked<day_start then balance:=null;end if;
 end if;
 if balance is null and p_provider<>'currents' then return null;end if;
 if balance is not null then
  select coalesce(sum(coalesce(credits,unit_cost)),0) into reserved from public.l_news_usage where provider=p_provider and billable and created_at>=checked;
  if balance-reserved-unit_cost<reserve_floor then return null;end if;
 end if;
 insert into public.l_news_usage(run_id,job_id,provider,endpoint,page,credits,details)
 values(p_run,p_job,p_provider,p_endpoint,p_page,unit_cost,jsonb_build_object('assistant_id',2,'reserved_units',unit_cost)) returning id into id_value;
 return id_value;
end$$;
revoke all on function public.l_news_reserve_assistant2_call(uuid,bigint,text,text,integer) from public,anon,authenticated;
grant execute on function public.l_news_reserve_assistant2_call(uuid,bigint,text,text,integer) to service_role;

create function public.l_news_assistant2_usage() returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_object_agg(p.provider,jsonb_build_object(
  'today_units',coalesce(x.today_units,0),'period_units',coalesce(x.period_units,0),
  'today_requests',coalesce(x.today_requests,0),'period_requests',coalesce(x.period_requests,0))),'{}'::jsonb)
 from (values('newscatcher',5),('cloro',3),('currents',1)) p(provider,unit_cost)
 left join lateral (
  select sum(coalesce(u.credits,p.unit_cost)) filter(where u.created_at>=((now() at time zone 'Europe/Minsk')::date::timestamp at time zone 'Europe/Minsk')) today_units,
   sum(coalesce(u.credits,p.unit_cost)) period_units,
   count(*) filter(where u.created_at>=((now() at time zone 'Europe/Minsk')::date::timestamp at time zone 'Europe/Minsk')) today_requests,
   count(*) period_requests
  from public.l_news_usage u join public.l_news_runs r on r.id=u.run_id
  where r.assistant_id=2 and u.provider=p.provider and u.billable and u.created_at>=now()-interval '30 days'
 ) x on true;
$$;
revoke all on function public.l_news_assistant2_usage() from public,anon,authenticated;
grant execute on function public.l_news_assistant2_usage() to service_role;

create function l_news_private.daily_assistant2() returns void
language plpgsql security definer set search_path='' as $$begin
 if exists(select 1 from public.l_news_assistant2_settings where id=true and enabled
  and local_time=to_char(now() at time zone 'Europe/Minsk','HH24:MI')) then
  perform public.l_news_enqueue_assistant2_run('scheduled',null);perform l_news_private.wake();
 end if;
end$$;
revoke all on function l_news_private.daily_assistant2() from public,anon,authenticated;
select cron.schedule('l-news-assistant2-daily','* * * * *','select l_news_private.daily_assistant2();');

-- Shared catalog: idempotently ensure the requested Italian publisher remains enabled.
insert into public.l_news_sources(domain,name,country,language,priority,enabled,coverage)
values('quotidiano.net','Quotidiano Nazionale','IT','it','B',true,'{}')
on conflict(domain) do update set name=excluded.name,country='IT',language=coalesce(public.l_news_sources.language,'it'),enabled=true;
CREATE OR REPLACE FUNCTION public.l_news_enqueue_scoped_run(p_trigger text, p_countries text[])
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
 select id into r from public.l_news_runs where assistant_id=1 and status in ('queued','discovering','processing') order by created_at limit 1;
 if r is not null then return r; end if;
 if p_trigger='scheduled' then dkey:=(finish at time zone 'Europe/Minsk')::date::text; end if;
 insert into public.l_news_runs(trigger_kind,daily_key,from_at,to_at,settings)
 values(p_trigger,dkey,finish-make_interval(hours=>s.lookback_hours),finish,snapshot)
 on conflict(daily_key) do nothing returning id into r;
 if r is not null then insert into public.l_news_jobs(run_id,kind,dedupe_key) values(r,'setup',r::text||':setup'); end if;
 return r;
end$function$;

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
  'catalog_sources',(select count(*) from public.l_news_sources where enabled)
 ) into c from public.l_news_run_items ri join public.l_news_items i on i.id=ri.item_id where ri.run_id=p_run;
 if pending>0 then st:='processing';elsif failures>0 or jsonb_array_length(w)>0 then st:='partial';else st:='completed';end if;
 update public.l_news_runs set counters=c,warnings=w,status=st,
  revision=case when counters is distinct from c or warnings is distinct from w or status<>st then nextval('public.l_news_revision_seq') else revision end,
  completed_at=case when pending=0 then coalesce(completed_at,now()) else null end,updated_at=now()
 where id=p_run and status<>'cancelled';
 return c;
end$function$;
