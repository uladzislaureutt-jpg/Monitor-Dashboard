-- Allow occasional manual collections after the scheduled collection.
-- Keep the rolling 30-day budget and account reserve unchanged.
alter table public.l_news_assistant2_settings
 alter column cloro_daily_credits set default 36;

update public.l_news_assistant2_settings
set cloro_daily_credits=36,updated_at=now()
where id=true and cloro_daily_credits=12;
