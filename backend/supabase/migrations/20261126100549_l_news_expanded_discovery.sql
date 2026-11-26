-- Broaden daily discovery without changing either assistant's search window or shared admission rules.
alter table public.l_news_assistant2_settings
 drop constraint l_news_assistant2_settings_currents_per_run_check,
 add constraint l_news_assistant2_settings_currents_per_run_check check(currents_per_run between 0 and 150),
 add column currents_pages_per_query integer not null default 5 check(currents_pages_per_query between 1 and 10),
 add column thenews_enabled boolean not null default true,
 add column thenews_per_run integer not null default 40 check(thenews_per_run between 0 and 100),
 add column thenews_daily_requests integer not null default 80 check(thenews_daily_requests between 0 and 100),
 add column thenews_monthly_requests integer not null default 2400 check(thenews_monthly_requests between 0 and 3000),
 add column thenews_reserve integer not null default 10 check(thenews_reserve between 0 and 100),
 add column thenews_pages_per_query integer not null default 3 check(thenews_pages_per_query between 1 and 10);
alter table public.l_news_assistant2_settings
 alter column currents_per_run set default 64,
 alter column currents_daily_requests set default 120,
 alter column currents_monthly_requests set default 3600,
 alter column currents_reserve set default 25,
 alter column currents_languages set default array['en','ru','uk','pl','de','fr','it','es','pt','tr','zh','ja','ko','ar','he','cs','ro','nl','sv','fi','hu','sr','lt','da','no','el','hi','ur','vi','ca','hr'];
update public.l_news_assistant2_settings set currents_per_run=64,currents_daily_requests=120,
 currents_monthly_requests=3600,currents_reserve=25,
 currents_languages=array['en','ru','uk','pl','de','fr','it','es','pt','tr','zh','ja','ko','ar','he','cs','ro','nl','sv','fi','hu','sr','lt','da','no','el','hi','ur','vi','ca','hr'],updated_at=now() where id;

-- Shared start-time slots protect provider limits across concurrent workers.
create table l_news_private.provider_rate_slots (
 provider text primary key check(provider in('currents','thenews')),
 next_start timestamptz not null default now()
);
alter table l_news_private.provider_rate_slots enable row level security;
revoke all on l_news_private.provider_rate_slots from public,anon,authenticated;
grant all on l_news_private.provider_rate_slots to service_role;
create policy service_only on l_news_private.provider_rate_slots for all to service_role using(true) with check(true);
create function public.l_news_provider_rate_slot(p_provider text) returns integer
language plpgsql security definer set search_path='' as $$
declare slot timestamptz;clock timestamptz:=clock_timestamp();spacing interval;
begin
 if p_provider not in('currents','thenews') then raise exception 'invalid_provider';end if;
 spacing:=case when p_provider='thenews' then interval '2200 milliseconds' else interval '1100 milliseconds' end;
 perform pg_advisory_xact_lock(hashtext('l-news-rate-'||p_provider));
 insert into l_news_private.provider_rate_slots(provider,next_start) values(p_provider,clock)
 on conflict(provider) do nothing;
 select greatest(next_start,clock) into slot from l_news_private.provider_rate_slots where provider=p_provider;
 update l_news_private.provider_rate_slots set next_start=slot+spacing where provider=p_provider;
 return greatest(0,ceil(extract(epoch from(slot-clock))*1000)::integer);
end$$;
revoke all on function public.l_news_provider_rate_slot(text) from public,anon,authenticated;
grant execute on function public.l_news_provider_rate_slot(text) to service_role;

-- Respect the provider reset timestamp when protecting the Currents reserve.
create or replace function public.l_news_reserve_assistant2_call(p_run uuid,p_job bigint,p_provider text,p_endpoint text,p_page integer)
returns bigint language plpgsql security invoker set search_path='' as $$
declare s jsonb;unit_cost integer;run_cap integer;day_cap integer;period_cap integer;id_value bigint;
 balance numeric;checked timestamptz;provider_reset timestamptz;reserved numeric;reserve_floor integer;
 day_start timestamptz:=((now() at time zone 'Europe/Minsk')::date::timestamp at time zone 'Europe/Minsk');
begin
 if p_provider not in('newscatcher','cloro','currents','thenews') then raise exception 'invalid_provider';end if;
 perform pg_advisory_xact_lock(hashtext('l-news-usage-'||p_provider));
 select settings into strict s from public.l_news_runs where id=p_run and assistant_id=2 and status<>'cancelled';
 if not exists(select 1 from public.l_news_jobs where id=p_job and run_id=p_run) then raise exception 'invalid_job';end if;
 if p_provider='cloro' then
  select id into id_value from public.l_news_usage where run_id=p_run and job_id=p_job and provider=p_provider and endpoint=p_endpoint and page=p_page order by id limit 1;
  if id_value is not null then return id_value;end if;
 end if;
 unit_cost:=case p_provider when 'newscatcher' then 5 when 'cloro' then 3 else 1 end;
 run_cap:=coalesce((s->>(p_provider||'_per_run'))::integer,0);
 day_cap:=coalesce((s->>(case when p_provider in('currents','thenews') then p_provider||'_daily_requests' else p_provider||'_daily_credits' end))::integer,0);
 period_cap:=coalesce((s->>(case when p_provider in('currents','thenews') then p_provider||'_monthly_requests' else p_provider||'_monthly_credits' end))::integer,0);
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
  select nullif(info#>>'{limits,remaining}','')::numeric,updated_at,
    case when info#>>'{limits,resetAt}' ~ '^20[0-9]{2}-' then (info#>>'{limits,resetAt}')::timestamptz
         else updated_at+interval '24 hours' end
    into balance,checked,provider_reset from public.l_news_provider_state where provider=p_provider;
  -- Account quota resets independently of our Minsk spending calendar.
  -- Keep a previous-day header valid until its actual service reset.
  if provider_reset<=now() then balance:=null;end if;
 end if;
 if balance is null and p_provider not in('currents','thenews') then return null;end if;
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


create or replace function public.l_news_assistant2_usage() returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_object_agg(p.provider,jsonb_build_object(
  'today_units',coalesce(x.today_units,0),'period_units',coalesce(x.period_units,0),
  'today_requests',coalesce(x.today_requests,0),'period_requests',coalesce(x.period_requests,0))),'{}'::jsonb)
 from (values('newscatcher',5),('cloro',3),('currents',1),('thenews',1)) p(provider,unit_cost)
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
  'catalog_sources',(select count(*) from public.l_news_sources where enabled)
 ) into c from public.l_news_run_items ri join public.l_news_items i on i.id=ri.item_id where ri.run_id=p_run;
 if pending>0 then st:='processing';elsif failures>0 or jsonb_array_length(w)>0 then st:='partial';else st:='completed';end if;
 update public.l_news_runs set counters=c,warnings=w,status=st,
  revision=case when counters is distinct from c or warnings is distinct from w or status<>st then nextval('public.l_news_revision_seq') else revision end,
  completed_at=case when pending=0 then coalesce(completed_at,now()) else null end,updated_at=now()
 where id=p_run and status<>'cancelled';
 return c;
end$function$;
