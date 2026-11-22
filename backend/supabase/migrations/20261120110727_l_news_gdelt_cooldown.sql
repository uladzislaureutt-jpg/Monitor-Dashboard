create function public.l_news_reserve_gdelt(
  p_run uuid, p_job bigint, p_endpoint text, p_run_limit integer
) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare
  usage_id bigint;
  blocked_until timestamptz;
  retry_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('l-news-usage-gdelt'));

  -- A restarted diagnostic job must never issue a second HTTP request.
  if p_endpoint='doc_probe' and exists(
    select 1 from public.l_news_usage where provider='gdelt' and job_id=p_job
  ) then
    return jsonb_build_object('already_reserved',true);
  end if;

  select max((details->>'blocked_until')::timestamptz) into blocked_until
  from public.l_news_usage where provider='gdelt' and status=429 and details ? 'blocked_until';
  if blocked_until>now() then
    return jsonb_build_object('blocked_until',blocked_until);
  end if;

  -- The worker fetch has a 25-second deadline. Serialize calls even across worker instances.
  select max(created_at+case when status is null then interval '35 seconds' else interval '6 seconds' end)
  into retry_at from public.l_news_usage
  where provider='gdelt' and created_at>now()-interval '35 seconds';
  if retry_at>now() then
    return jsonb_build_object('retry_at',retry_at);
  end if;

  if p_endpoint='doc_probe' then
    insert into public.l_news_usage(job_id,provider,endpoint,page,billable)
    values(p_job,'gdelt',p_endpoint,0,false) returning id into usage_id;
  else
    usage_id:=public.l_news_reserve_call(p_run,p_job,'gdelt',p_endpoint,0,p_run_limit,10000);
  end if;
  return jsonb_build_object('usage_id',usage_id);
end
$$;

create function public.l_news_finish_gdelt(
  p_id bigint, p_status integer, p_result_count integer, p_elapsed_ms integer,
  p_details jsonb, p_retry_after_at timestamptz
) returns timestamptz
language plpgsql volatile security invoker set search_path='' as $$
declare
  local_now timestamp;
  next_local timestamp;
  local_schedule time;
  schedule_zone text;
  blocked_until timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('l-news-usage-gdelt'));
  if p_status=429 then
    select timezone,local_time::time into strict schedule_zone,local_schedule
    from public.l_news_settings where id=true;
    local_now:=now() at time zone schedule_zone;
    next_local:=local_now::date+local_schedule;
    if next_local<=local_now then
      next_local:=next_local+interval '1 day';
    end if;
    blocked_until:=greatest(next_local at time zone schedule_zone,p_retry_after_at);
    p_details:=p_details||jsonb_build_object('blocked_until',blocked_until);
  end if;

  update public.l_news_usage
  set status=p_status,result_count=p_result_count,elapsed_ms=p_elapsed_ms,credits=0,details=p_details
  where id=p_id and provider='gdelt' and status is null;
  return blocked_until;
end
$$;

revoke all on function public.l_news_reserve_gdelt(uuid,bigint,text,integer) from public,anon,authenticated;
revoke all on function public.l_news_finish_gdelt(bigint,integer,integer,integer,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.l_news_reserve_gdelt(uuid,bigint,text,integer) to service_role;
grant execute on function public.l_news_finish_gdelt(bigint,integer,integer,integer,jsonb,timestamptz) to service_role;
