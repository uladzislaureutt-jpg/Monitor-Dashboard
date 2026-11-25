-- Deployed as Supabase migration 20261125142700.
-- Raw job.error stays unchanged for machine retries and diagnostics.
CREATE OR REPLACE FUNCTION public.l_news_refresh_run(p_run uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare c jsonb;w jsonb;pending bigint;failures bigint;st text;begin
 select count(*) filter(where state in ('waiting','leased')),count(*) filter(where state='failed') into pending,failures from public.l_news_jobs where run_id=p_run;
 select coalesce(jsonb_agg(distinct public.l_news_warning_ru(message)),'[]') into w from (
  select error as message from public.l_news_jobs where run_id=p_run and state='failed' and error is not null
  union all select 'Достигнут лимит запросов: '||kind from public.l_news_jobs where run_id=p_run and result->>'capped'='true'
  union all select jsonb_array_elements_text(result->'warnings') from public.l_news_jobs where run_id=p_run and jsonb_typeof(result->'warnings')='array'
 ) t;
 select jsonb_build_object(
  'found',(select count(*) from public.l_news_observations where run_id=p_run),
  'already_known',(select count(*) from public.l_news_observations where run_id=p_run and disposition in ('already_reported_github','already_ready')),
  'unique_candidates',count(*),
  'ready',count(*) filter(where i.state='ready' and (i.ready_run_id=p_run or ri.role='upgrade')),
  'new_articles',count(*) filter(where i.state='ready' and i.ready_run_id=p_run),
  'full_texts',count(*) filter(where i.state='ready' and i.content_level='FULL_TEXT' and (i.ready_run_id=p_run or ri.role='upgrade')),
  'previews',count(*) filter(where i.state='ready' and i.content_level<>'FULL_TEXT' and (i.ready_run_id=p_run or ri.role='upgrade')),
  'pending',count(*) filter(where i.state='pending'),
  'rejected',count(*) filter(where i.state='rejected'),
  'failed_articles',count(*) filter(where i.state='failed'),
  'jobs_pending',pending,'jobs_failed',failures,'content_revision',coalesce(max(i.revision),0),
  'perigon_requests',(select count(*) from public.l_news_usage where run_id=p_run and provider='perigon' and billable),
  'newscatcher_requests',(select count(*) from public.l_news_usage where run_id=p_run and provider='newscatcher' and billable),
  'newscatcher_credits',(select coalesce(sum(credits),0) from public.l_news_usage where run_id=p_run and provider='newscatcher'),
  'gdelt_requests',(select count(*) from public.l_news_usage where run_id=p_run and provider='gdelt'),
  'paid_extractions',(select count(*) from public.l_news_usage where run_id=p_run and provider='webscrapingai'),
  'catalog_sources',(select count(*) from public.l_news_sources where enabled)
 ) into c from public.l_news_run_items ri join public.l_news_items i on i.id=ri.item_id where ri.run_id=p_run;
 if pending>0 then st:='processing';elsif failures>0 or jsonb_array_length(w)>0 then st:='partial';else st:='completed';end if;
 update public.l_news_runs set counters=c,warnings=w,status=st,
  revision=case when counters is distinct from c or warnings is distinct from w or status<>st then nextval('public.l_news_revision_seq') else revision end,
  completed_at=case when pending=0 then coalesce(completed_at,now()) else null end,updated_at=now()
 where id=p_run and status<>'cancelled';
 return c;
end$function$
;

CREATE OR REPLACE FUNCTION public.l_news_warning_ru(p_message text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE STRICT
 SET search_path TO ''
AS $function$
 select case
 when lower(p_message) like '%duplicate key value violates unique constraint%'
   then 'Повторная находка уже есть в журнале. Одно поисковое задание завершилось с ошибкой записи.'
 when lower(p_message) like '%relevance_review_unavailable%'
   then 'Семантическая проверка не завершена: модели ИИ не вернули пригодный ответ.'
 when lower(p_message) like '%translation_unavailable%'
   then 'Не удалось перевести публикацию: сервисы перевода не вернули пригодный ответ.'
 when lower(p_message) like 'github-индекс:%' and
    (lower(p_message) like '%typeerror%' or lower(p_message) like '%timeout%' or lower(p_message) like '%error sending request%')
   then 'GitHub-индекс: временная ошибка соединения при загрузке или записи архива.'
 when lower(p_message) like 'github-индекс:%'
   then 'GitHub-индекс: не удалось обработать один из архивов. Подробности сохранены в журнале.'
 when lower(p_message) like 'достигнут лимит запросов: newscatcher%'
   then 'Достигнут разовый лимит запросов Newscatcher.'
 when lower(p_message) like 'достигнут лимит запросов: perigon%'
   then 'Достигнут разовый лимит запросов Perigon.'
 when lower(p_message) like 'достигнут лимит запросов: gdelt%'
   then 'Достигнут разовый лимит запросов GDELT.'
 when lower(p_message) like '%newscatcher_search_429%'
   then 'Newscatcher: сервис ограничил частоту запросов (HTTP 429).'
 when lower(p_message) like '%perigon_search_429%'
   then 'Perigon: сервис ограничил частоту запросов (HTTP 429).'
 when lower(p_message) like '%transport%' or lower(p_message) like '%timeout%' or lower(p_message) like '%connection%'
   then 'Сетевая ошибка либо превышено время ожидания ответа.'
 when p_message ~ '[А-Яа-яЁё]' and p_message !~* 'typeerror|violates unique|error sending request|unknown|traceback'
   then p_message
 else 'Ошибка обработки задания. Технические сведения сохранены в журнале диагностики.'
 end;
$function$
;