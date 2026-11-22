-- At most three workers; durable leases and budget reservations are serialized.
create or replace function public.l_news_claim_jobs(p_limit integer default 1) returns setof public.l_news_jobs
language plpgsql volatile security invoker set search_path='' as $$
declare leased integer;begin
 perform pg_advisory_xact_lock(hashtext('l-news-worker-leases'));
 select count(*) into leased from public.l_news_jobs where state='leased' and lease_until>now();
 if leased>=3 then return;end if;
 return query update public.l_news_jobs j set state='leased',attempts=j.attempts+1,
  lease_until=now()+interval '4 minutes',updated_at=now()
 where j.id in (select id from public.l_news_jobs
  where (state='waiting' or (state='leased' and lease_until<now())) and available_at<=now() and attempts<4
  order by id for update skip locked limit least(greatest(p_limit,1),3-leased)) returning j.*;
end$$;
revoke all on function public.l_news_claim_jobs(integer) from public,anon,authenticated;
grant execute on function public.l_news_claim_jobs(integer) to service_role;

create or replace function public.l_news_reserve_call(p_run uuid,p_job bigint,p_provider text,p_endpoint text,p_page integer,p_run_limit integer,p_month_limit integer)
returns bigint language plpgsql security invoker set search_path='' as $$
declare k bigint;period_start timestamptz:=date_trunc('month',now());begin
 perform pg_advisory_xact_lock(hashtext('l-news-usage-'||p_provider));
 if p_provider='perigon' then
  select coalesce(nullif(info#>>'{limits,since}','')::timestamptz,period_start) into period_start from public.l_news_provider_state where provider='perigon';
  period_start:=coalesce(period_start,date_trunc('month',now()));
  if p_endpoint not like '%probe%' and
   (select count(*) from public.l_news_usage where provider='perigon' and billable and endpoint not like '%probe%'
    and created_at>=((now() at time zone 'Europe/Minsk')::date::timestamp at time zone 'Europe/Minsk'))>=4 then return null;end if;
 end if;
 if p_run is not null and (select count(*) from public.l_news_usage where run_id=p_run and provider=p_provider and billable)>=p_run_limit then return null;end if;
 if (select count(*) from public.l_news_usage where provider=p_provider and billable and created_at>=period_start)>=p_month_limit then return null;end if;
 insert into public.l_news_usage(run_id,job_id,provider,endpoint,page) values(p_run,p_job,p_provider,p_endpoint,p_page) returning id into k;
 return k;
end$$;
revoke all on function public.l_news_reserve_call(uuid,bigint,text,text,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.l_news_reserve_call(uuid,bigint,text,text,integer,integer,integer) to service_role;

