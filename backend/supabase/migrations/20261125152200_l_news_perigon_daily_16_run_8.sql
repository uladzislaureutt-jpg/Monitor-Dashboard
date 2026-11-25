-- Eight Perigon search calls per run; sixteen per Europe/Minsk calendar day.
-- Existing global provider quota and reserve are unchanged.
CREATE OR REPLACE FUNCTION public.l_news_reserve_call(p_run uuid, p_job bigint, p_provider text, p_endpoint text, p_page integer, p_run_limit integer, p_month_limit integer)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare k bigint;period_start timestamptz:=date_trunc('month',now());begin
 perform pg_advisory_xact_lock(hashtext('l-news-usage-'||p_provider));
 if p_provider='perigon' then
  select coalesce(nullif(info#>>'{limits,since}','')::timestamptz,period_start) into period_start from public.l_news_provider_state where provider='perigon';
  period_start:=coalesce(period_start,date_trunc('month',now()));
  -- 16 billable search requests in the Minsk local calendar day, across all
  -- scheduled and manual runs. Per-run limit (8) is checked independently.
  if p_endpoint not like '%probe%' and
    (select count(*) from public.l_news_usage
     where provider='perigon' and billable
       and endpoint not like '%probe%'
       and created_at >= ((now() at time zone 'Europe/Minsk')::date::timestamp at time zone 'Europe/Minsk')
       and created_at < (((now() at time zone 'Europe/Minsk')::date + 1)::timestamp at time zone 'Europe/Minsk')
    ) >= 16 then return null; end if;
 end if;
 if p_run is not null and (select count(*) from public.l_news_usage where run_id=p_run and provider=p_provider and billable)>=p_run_limit then return null;end if;
 if (select count(*) from public.l_news_usage where provider=p_provider and billable and created_at>=period_start)>=p_month_limit then return null;end if;
 insert into public.l_news_usage(run_id,job_id,provider,endpoint,page) values(p_run,p_job,p_provider,p_endpoint,p_page) returning id into k;
 return k;
end$function$
;
