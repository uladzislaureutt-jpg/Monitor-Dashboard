-- The transaction rolls back queued pg_net requests before they can be sent.
-- Run while helper 1 is idle. No collected cards, settings or runs are retained.
begin;
do $$
declare before_runs bigint;after_runs bigint;r uuid;local_clock text;
begin
 if exists(select 1 from public.l_news_runs where assistant_id=1 and status in('queued','discovering','processing')) then raise exception 'helper1_must_be_idle_for_test';end if;
 if not exists(select 1 from cron.job where jobname='l-news-pilot-daily' and schedule='* * * * *' and active and command='select l_news_private.daily();') then raise exception 'scheduler_not_dynamic';end if;
 if has_function_privilege('authenticated','l_news_private.daily()','EXECUTE') then raise exception 'scheduler_exposed';end if;
 select count(*) into before_runs from public.l_news_runs;
 local_clock:=to_char(now() at time zone 'Europe/Minsk','HH24:MI');
 update public.l_news_settings set enabled=false,local_time=local_clock where id;
 perform l_news_private.daily();
 if (select count(*) from public.l_news_runs)<>before_runs then raise exception 'disabled_schedule_started';end if;
 update public.l_news_settings set enabled=true,local_time=to_char((now() at time zone 'Europe/Minsk')+interval '1 minute','HH24:MI') where id;
 perform l_news_private.daily();
 if (select count(*) from public.l_news_runs)<>before_runs then raise exception 'wrong_time_started';end if;
 -- Make today's key available only inside this rollback-only transaction.
 update public.l_news_runs set daily_key=null where assistant_id=1 and daily_key=(now() at time zone 'Europe/Minsk')::date::text;
 update public.l_news_settings set local_time=local_clock where id;
 perform l_news_private.daily();
 select count(*) into after_runs from public.l_news_runs;
 if after_runs<>before_runs+1 then raise exception 'saved_time_not_applied';end if;
 select id into r from public.l_news_runs where assistant_id=1 and daily_key=(now() at time zone 'Europe/Minsk')::date::text;
 if r is null or (select settings->>'local_time' from public.l_news_runs where id=r)<>local_clock then raise exception 'snapshot_time_missing';end if;
 if not exists(select 1 from public.l_news_jobs where run_id=r and kind='setup') then raise exception 'setup_not_enqueued';end if;
 perform l_news_private.daily();
 if (select count(*) from public.l_news_runs)<>after_runs then raise exception 'duplicate_scheduled_run';end if;
 begin
  update public.l_news_settings set local_time='25:00' where id;
  raise exception 'invalid_time_accepted';
 exception when check_violation then null;
 end;
end$$;
rollback;
