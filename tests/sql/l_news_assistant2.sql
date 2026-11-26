-- Run after the migration. No API calls and no retained rows/settings.
begin;
do $$
declare a uuid;b uuid;j bigint;k bigint;u bigint;again bigint;
begin
 if has_table_privilege('anon','public.l_news_assistant2_settings','SELECT') or has_table_privilege('authenticated','public.l_news_assistant2_settings','UPDATE') then raise exception 'settings grants are not service-only';end if;
 if has_function_privilege('authenticated','public.l_news_enqueue_assistant2_run(text,text[])','EXECUTE') then raise exception 'enqueue is exposed';end if;
 if not exists(select 1 from public.l_news_sources where domain='quotidiano.net' and country='IT' and enabled and language='it') then raise exception 'QN missing';end if;
 a:=public.l_news_enqueue_assistant2_run('test',array['IT','DE']);
 b:=public.l_news_enqueue_scoped_run('manual',null);
 if a is null or b is null or a=b then raise exception 'assistants block one another';end if;
 if not exists(select 1 from public.l_news_runs where id=a and assistant_id=2) or not exists(select 1 from public.l_news_runs where id=b and assistant_id=1) then raise exception 'wrong assistant routing';end if;
 select id into j from public.l_news_jobs where run_id=a and kind='setup';
 update public.l_news_runs set settings=settings||'{"cloro_per_run":10,"cloro_daily_credits":3,"cloro_monthly_credits":100,"cloro_reserve":0}' where id=a;
 insert into public.l_news_provider_state(provider,info,updated_at) values('cloro','{"balance":{"remaining":1000}}',now()) on conflict(provider) do update set info=excluded.info,updated_at=excluded.updated_at;
 u:=public.l_news_reserve_assistant2_call(a,j,'cloro','test_async',1);
 again:=public.l_news_reserve_assistant2_call(a,j,'cloro','test_async',1);
 if u is null or u<>again then raise exception 'Cloro retry charged twice';end if;
 insert into public.l_news_jobs(run_id,kind,dedupe_key) values(a,'cloro',a||':budget-test') returning id into k;
 if public.l_news_reserve_assistant2_call(a,k,'cloro','test_async',1) is not null then raise exception 'daily cap failed';end if;
 update public.l_news_runs set settings=settings||'{"cloro_daily_credits":100,"cloro_monthly_credits":3}' where id=a;
 if public.l_news_reserve_assistant2_call(a,k,'cloro','test_async',1) is not null then raise exception '30-day cap failed';end if;
 update public.l_news_runs set settings=settings||'{"cloro_daily_credits":100,"cloro_monthly_credits":100,"cloro_per_run":1}' where id=a;
 if public.l_news_reserve_assistant2_call(a,k,'cloro','test_async',1) is not null then raise exception 'run cap failed';end if;
 update public.l_news_runs set settings=settings||'{"cloro_per_run":10,"cloro_reserve":999}' where id=a;
 if public.l_news_reserve_assistant2_call(a,k,'cloro','test_async',1) is not null then raise exception 'shared balance floor failed';end if;
 if (public.l_news_assistant2_usage()#>>'{cloro,today_units}')::integer<>3 then raise exception 'usage summary mismatch';end if;
 update public.l_news_runs set settings=settings||'{"currents_enabled":false}' where id=a;
 if public.l_news_reserve_assistant2_call(a,k,'currents','test',1) is not null then raise exception 'disabled provider spent quota';end if;
end$$;
rollback;
