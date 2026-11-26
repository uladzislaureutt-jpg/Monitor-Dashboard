-- No HTTP calls, no retained test run or changes.
begin;
do $$ declare r uuid;s jsonb;
begin
 select to_jsonb(x) into s from public.l_news_assistant2_settings x;
 if s->'cloro_countries'<>'["US","DE","PL","FR","IT","UA","GB","ES","TR","LT","LV","EE"]'::jsonb then raise exception 'wrong_cloro_countries';end if;
 if (s->>'cloro_per_run')::int<>4 or (s->>'cloro_daily_credits')::int<>36 or (s->>'cloro_monthly_credits')::int<>360 then raise exception 'budget_changed';end if;
 if (s->>'cloro_rotation_start')::bigint<1 then raise exception 'rotation_anchor_missing';end if;
 r:=public.l_news_enqueue_assistant2_run('test',null);
 if (select settings->>'cloro_rotation_start' from public.l_news_runs where id=r)<>s->>'cloro_rotation_start' then raise exception 'run_snapshot_lost_anchor';end if;
 if (select settings->'cloro_countries' from public.l_news_runs where id=r)<>s->'cloro_countries' then raise exception 'run_snapshot_lost_countries';end if;
 if has_table_privilege('authenticated','public.l_news_assistant2_settings','UPDATE') then raise exception 'settings_exposed';end if;
end$$;
rollback;
