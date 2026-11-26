-- Transactional regression: no paid API calls and no persisted changes.
begin;
do $$
declare r uuid;j bigint;u bigint;day_used integer;period_used integer;wait_a integer;wait_b integer;
begin
 if has_function_privilege('authenticated','public.l_news_provider_rate_slot(text)','EXECUTE') then raise exception 'rate slots exposed';end if;
 if has_table_privilege('anon','l_news_private.provider_rate_slots','SELECT') then raise exception 'rate table exposed';end if;
 day_used:=(public.l_news_assistant2_usage()#>>'{thenews,today_units}')::integer;
 period_used:=(public.l_news_assistant2_usage()#>>'{thenews,period_units}')::integer;
 r:=public.l_news_enqueue_assistant2_run('test',array['DE']);
 select id into j from public.l_news_jobs where run_id=r and kind='setup';
 update public.l_news_runs set settings=settings||jsonb_build_object('thenews_enabled',true,'thenews_per_run',3,'thenews_daily_requests',day_used+1,'thenews_monthly_requests',period_used+2,'thenews_reserve',10) where id=r;
 insert into public.l_news_provider_state(provider,info,updated_at)
 values('thenews',jsonb_build_object('limits',jsonb_build_object('remaining',100,'resetAt',now()+interval '1 hour')),now())
 on conflict(provider) do update set info=excluded.info,updated_at=excluded.updated_at;
 u:=public.l_news_reserve_assistant2_call(r,j,'thenews','test',1);
 if u is null then raise exception 'The News not reserved';end if;
 if public.l_news_reserve_assistant2_call(r,j,'thenews','test',2) is not null then raise exception 'daily cap failed';end if;
 update public.l_news_runs set settings=settings||jsonb_build_object('thenews_daily_requests',day_used+10,'thenews_monthly_requests',period_used+1) where id=r;
 if public.l_news_reserve_assistant2_call(r,j,'thenews','test',2) is not null then raise exception 'rolling cap failed';end if;
 update public.l_news_runs set settings=settings||jsonb_build_object('thenews_monthly_requests',period_used+10,'thenews_per_run',1) where id=r;
 if public.l_news_reserve_assistant2_call(r,j,'thenews','test',2) is not null then raise exception 'run cap failed';end if;
 update public.l_news_runs set settings=settings||'{"thenews_per_run":3,"thenews_reserve":100}' where id=r;
 if public.l_news_reserve_assistant2_call(r,j,'thenews','test',2) is not null then raise exception 'reserve floor failed';end if;
 update public.l_news_runs set settings=settings||'{"thenews_reserve":0,"thenews_enabled":false}' where id=r;
 if public.l_news_reserve_assistant2_call(r,j,'thenews','test',2) is not null then raise exception 'disabled provider spent';end if;
 if (public.l_news_assistant2_usage()#>>'{thenews,today_units}')::integer<>day_used+1 then raise exception 'usage missing';end if;
 if (public.l_news_refresh_run(r)->>'thenews_requests')::integer<>1 then raise exception 'run counters missing';end if;
 wait_a:=public.l_news_provider_rate_slot('thenews');wait_b:=public.l_news_provider_rate_slot('thenews');
 if wait_b-wait_a<2000 then raise exception 'shared rate spacing failed';end if;
end$$;
rollback;
