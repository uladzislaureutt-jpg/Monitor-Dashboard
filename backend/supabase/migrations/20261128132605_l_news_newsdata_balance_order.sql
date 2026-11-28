-- Serialize measured balances; a late response must not raise today's balance.
create or replace function public.l_news_finish_newsdata_call(p_usage bigint,p_status integer,p_credits integer,p_count integer,p_elapsed integer,p_details jsonb,p_limits jsonb,p_retry_at timestamptz)
returns void language plpgsql security invoker set search_path='' as $$
declare previous public.l_news_provider_state;remaining numeric;rate_remaining numeric;utc_start timestamptz:=((now() at time zone 'UTC')::date::timestamp at time zone 'UTC');
begin
 perform pg_advisory_xact_lock(hashtext('l-news-usage-newsdata'));
 update public.l_news_usage set status=p_status,credits=p_credits,result_count=p_count,elapsed_ms=p_elapsed,details=p_details where id=p_usage and provider='newsdata';
 if p_limits is null then return;end if;
 select * into previous from public.l_news_provider_state where provider='newsdata';
 if nullif(previous.info->>'retry_at','')::timestamptz>now() then p_retry_at:=greatest(p_retry_at,(previous.info->>'retry_at')::timestamptz);end if;
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
