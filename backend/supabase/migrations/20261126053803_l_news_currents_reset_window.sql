-- Respect the provider reset timestamp when protecting the Currents reserve.
create or replace function public.l_news_reserve_assistant2_call(p_run uuid,p_job bigint,p_provider text,p_endpoint text,p_page integer)
returns bigint language plpgsql security invoker set search_path='' as $$
declare s jsonb;unit_cost integer;run_cap integer;day_cap integer;period_cap integer;id_value bigint;
 balance numeric;checked timestamptz;provider_reset timestamptz;reserved numeric;reserve_floor integer;
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
  select nullif(info#>>'{limits,remaining}','')::numeric,updated_at,
    case when info#>>'{limits,resetAt}' ~ '^20[0-9]{2}-' then (info#>>'{limits,resetAt}')::timestamptz
         else updated_at+interval '24 hours' end
    into balance,checked,provider_reset from public.l_news_provider_state where provider=p_provider;
  -- Account quota resets independently of our Minsk spending calendar.
  -- Keep a previous-day header valid until its actual service reset.
  if provider_reset<=now() then balance:=null;end if;
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

