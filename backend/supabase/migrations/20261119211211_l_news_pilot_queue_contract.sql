alter table public.l_news_observations add column disposition text not null default 'candidate';
alter table public.l_news_items add column ready_run_id uuid references public.l_news_runs(id);
create table public.l_news_url_aliases(alias text primary key,item_id uuid not null references public.l_news_items(id));
create index l_news_alias_item on public.l_news_url_aliases(item_id);
alter table public.l_news_url_aliases enable row level security;
revoke all on public.l_news_url_aliases from public,anon,authenticated;
grant all on public.l_news_url_aliases to service_role;
create policy service_only on public.l_news_url_aliases for all to service_role using(true) with check(true);

create function public.l_news_claim_alias(p_alias text,p_item uuid) returns uuid
language sql volatile security invoker set search_path='' as $$
 insert into public.l_news_url_aliases(alias,item_id) values(p_alias,p_item)
 on conflict(alias) do update set alias=excluded.alias returning item_id;
$$;
revoke all on function public.l_news_claim_alias(text,uuid) from public,anon,authenticated;
grant execute on function public.l_news_claim_alias(text,uuid) to service_role;

create function public.l_news_source_seen(p_domain text,p_provider text,p_published timestamptz) returns void
language sql volatile security invoker set search_path='' as $$
 update public.l_news_sources set coverage=jsonb_set(coverage,array[p_provider],jsonb_build_object('status','indexed_article_seen','observed_at',now(),'published_at',p_published)) where domain=p_domain;
$$;
revoke all on function public.l_news_source_seen(text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.l_news_source_seen(text,text,timestamptz) to service_role;

create function public.l_news_refresh_run(p_run uuid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare c jsonb;w jsonb;pending bigint;failures bigint;st text;begin
 select count(*) filter(where state in ('waiting','leased')),count(*) filter(where state='failed') into pending,failures from public.l_news_jobs where run_id=p_run;
 select coalesce(jsonb_agg(distinct message),'[]') into w from (
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
end$$;
revoke all on function public.l_news_refresh_run(uuid) from public,anon,authenticated;
grant execute on function public.l_news_refresh_run(uuid) to service_role;

create or replace function l_news_private.wake() returns bigint
language plpgsql security invoker set search_path='' as $$
declare secret_value text;r bigint;run_row record;begin
 update public.l_news_jobs set state='failed',error='worker_lease_exhausted',updated_at=now()
 where state='leased' and lease_until<now() and attempts>=4;
 for run_row in select id from public.l_news_runs where status in ('queued','discovering','processing') loop
  perform public.l_news_refresh_run(run_row.id);
 end loop;
 if not exists(select 1 from public.l_news_jobs where (state='waiting' or (state='leased' and lease_until<now())) and available_at<=now() and attempts<4) then return null;end if;
 select decrypted_secret into secret_value from vault.decrypted_secrets where name='l_news_worker_token';
 select net.http_post(url:='https://kcmmnngcjfmyjzzczvko.supabase.co/functions/v1/l-news-collector',
  headers:=jsonb_build_object('content-type','application/json','x-l-news-worker',secret_value),
  body:='{"action":"worker"}'::jsonb,timeout_milliseconds:=120000) into r;
 return r;
end$$;
revoke all on function l_news_private.wake() from public,anon,authenticated;

