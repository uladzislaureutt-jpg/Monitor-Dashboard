-- Helper 1 reads the saved Minsk time, like helper 2. Keep its current 15:07.
alter table public.l_news_settings
 add constraint l_news_settings_local_time_check check(local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
create or replace function l_news_private.daily() returns void
language plpgsql security invoker set search_path='' as $$begin
 if exists(select 1 from public.l_news_settings where id=true and enabled
  and local_time=to_char(now() at time zone 'Europe/Minsk','HH24:MI')) then
  perform public.l_news_enqueue_run('scheduled');
  perform l_news_private.wake();
 end if;
end$$;
revoke all on function l_news_private.daily() from public,anon,authenticated;
select cron.schedule('l-news-pilot-daily','* * * * *','select l_news_private.daily();');
