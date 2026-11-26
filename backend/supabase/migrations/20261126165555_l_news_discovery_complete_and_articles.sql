-- Broader independent directions; the provider account reserves still apply.
alter table public.l_news_assistant2_settings
 alter column currents_per_run set default 120,
 alter column currents_daily_requests set default 200,
 alter column currents_monthly_requests set default 6000,
 alter column thenews_per_run set default 70,
 alter column thenews_daily_requests set default 90,
 alter column thenews_monthly_requests set default 2700,
 alter column thenews_pages_per_query set default 8;

-- Upgrade the previously delivered defaults while preserving custom budgets.
update public.l_news_assistant2_settings set
 currents_per_run=case when currents_per_run=64 then 120 else currents_per_run end,
 currents_daily_requests=case when currents_daily_requests=120 then 200 else currents_daily_requests end,
 currents_monthly_requests=case when currents_monthly_requests=3600 then 6000 else currents_monthly_requests end,
 thenews_per_run=case when thenews_per_run=40 then 70 else thenews_per_run end,
 thenews_daily_requests=case when thenews_daily_requests=80 then 90 else thenews_daily_requests end,
 thenews_monthly_requests=case when thenews_monthly_requests=2400 then 2700 else thenews_monthly_requests end,
 thenews_pages_per_query=case when thenews_pages_per_query=3 then 8 else thenews_pages_per_query end,
 updated_at=now()
where id=true;
