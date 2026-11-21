-- Independent L-Monitor API pilot. All writes and reads go through the authenticated
-- Edge Function; cron/worker credentials are never returned to clients.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;
create schema if not exists l_news_private;
revoke all on schema l_news_private from public, anon, authenticated;

create sequence if not exists public.l_news_revision_seq;
create table public.l_news_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  lookback_hours integer not null default 26 check (lookback_hours between 1 and 168),
  local_time text not null default '15:07', timezone text not null default 'Europe/Minsk',
  countries text[] not null default array['RU','UA','PL','LT','LV','SE','FI','DE','AT','CZ','RS','BG','CH','IT','ES','FR','GB','TR','US','CA','BR','MX','CN','JP','VN','IN','PK','IR','QA','IL','AM','GE','AZ','KZ','BE'],
  perigon_monthly_limit integer not null default 150 check (perigon_monthly_limit between 0 and 150),
  perigon_per_run integer not null default 4 check (perigon_per_run between 0 and 4),
  perigon_reserve integer not null default 10 check (perigon_reserve >= 0),
  newscatcher_per_run integer not null default 16 check (newscatcher_per_run between 0 and 40),
  gdelt_per_run integer not null default 4 check (gdelt_per_run between 0 and 10),
  paid_extractions_per_run integer not null default 4 check (paid_extractions_per_run between 0 and 10),
  candidate_limit integer not null default 1200 check (candidate_limit between 10 and 3000),
  catalog_version text not null default 'pilot-2026-11-19',
  updated_at timestamptz not null default now()
);
insert into public.l_news_settings(id) values(true);

create table public.l_news_sources (
 domain text primary key, name text not null, country text not null,
 language text, source_type text not null default 'media', priority text not null default 'B',
 enabled boolean not null default true, baseline boolean not null default false,
 coverage jsonb not null default '{}'::jsonb,
 check (domain ~ '^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$'), check (country ~ '^[A-Z]{2}$')
);
create table public.l_news_runs (
 id uuid primary key default gen_random_uuid(), number bigint generated always as identity unique,
 trigger_kind text not null check(trigger_kind in ('scheduled','manual','test')),
 daily_key text unique, status text not null default 'queued',
 from_at timestamptz not null, to_at timestamptz not null,
 settings jsonb not null, counters jsonb not null default '{}'::jsonb,
 warnings jsonb not null default '[]'::jsonb,
 revision bigint not null default nextval('public.l_news_revision_seq'),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 completed_at timestamptz, check(from_at<to_at),
 check(status in ('queued','discovering','processing','completed','partial','failed','cancelled'))
);
create table public.l_news_jobs (
 id bigint generated always as identity primary key,
 run_id uuid references public.l_news_runs(id), kind text not null,
 payload jsonb not null default '{}'::jsonb, dedupe_key text not null unique,
 state text not null default 'waiting' check(state in ('waiting','leased','done','failed')),
 attempts integer not null default 0, lease_until timestamptz,
 available_at timestamptz not null default now(), result jsonb, error text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index l_news_jobs_pending on public.l_news_jobs(available_at,id) where state in ('waiting','leased');
create index l_news_jobs_run on public.l_news_jobs(run_id,state);
create table public.l_news_items (
 id uuid primary key default gen_random_uuid(), canonical_url text not null unique,
 document_uid text not null unique, source_domain text references public.l_news_sources(domain),
 country text not null, published_at timestamptz,
 original jsonb not null, card jsonb, full_text jsonb,
 content_level text not null default 'METADATA',
 state text not null default 'pending' check(state in ('pending','ready','rejected','failed')),
 reason text, first_run_id uuid references public.l_news_runs(id),
 first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
 ready_at timestamptz, updated_at timestamptz not null default now(),
 revision bigint not null default nextval('public.l_news_revision_seq')
);
create table public.l_news_run_items (
 run_id uuid not null references public.l_news_runs(id), item_id uuid not null references public.l_news_items(id),
 role text not null default 'new' check(role in ('new','seen','upgrade')),
 primary key(run_id,item_id)
);
create table public.l_news_observations (
 id bigint generated always as identity primary key,
 run_id uuid references public.l_news_runs(id), item_id uuid references public.l_news_items(id),
 provider text not null, provider_id text not null, url text not null,
 content_level text not null default 'METADATA', created_at timestamptz not null default now(),
 unique(run_id,provider,provider_id)
);
create table public.l_news_known_urls (
 canonical_url text primary key, document_uid text not null,
 origin text not null, content_level text not null default 'METADATA',
 aliases text[] not null default '{}', observed_at timestamptz not null default now()
);
create index l_news_known_uid on public.l_news_known_urls(document_uid);
create table public.l_news_provider_state (
 provider text primary key, info jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now()
);
create table public.l_news_usage (
 id bigint generated always as identity primary key,
 run_id uuid references public.l_news_runs(id), job_id bigint references public.l_news_jobs(id),
 provider text not null, endpoint text not null, billable boolean not null default true,
 page integer, status integer, result_count integer, credits numeric,
 elapsed_ms integer, details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create index l_news_usage_provider_period on public.l_news_usage(provider,created_at);
create index l_news_usage_run on public.l_news_usage(run_id,provider);
create index l_news_items_ready on public.l_news_items(state,revision);
create index l_news_observations_item on public.l_news_observations(item_id);
create index l_news_run_items_item on public.l_news_run_items(item_id);
create index l_news_items_first_run on public.l_news_items(first_run_id);

do $$declare n text; begin
 foreach n in array array['l_news_settings','l_news_sources','l_news_runs','l_news_jobs','l_news_items','l_news_run_items','l_news_observations','l_news_known_urls','l_news_provider_state','l_news_usage'] loop
   execute format('alter table public.%I enable row level security',n);
   execute format('revoke all on public.%I from public, anon, authenticated',n);
   execute format('grant all on public.%I to service_role',n);
   execute format('create policy service_only on public.%I for all to service_role using (true) with check (true)',n);
 end loop;
end$$;
grant usage,select on sequence public.l_news_revision_seq,public.l_news_runs_number_seq,public.l_news_jobs_id_seq,public.l_news_observations_id_seq,public.l_news_usage_id_seq to service_role;

-- Private random bearer used only between Postgres and the worker. Not a provider key.
do $$begin
 if not exists(select 1 from vault.secrets where name='l_news_worker_token') then
  perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'l_news_worker_token','L-Monitor private cron worker');
 end if;
end$$;

create function public.l_news_verify_worker(p_token text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from vault.decrypted_secrets where name='l_news_worker_token'
  and extensions.digest(decrypted_secret,'sha256')=extensions.digest(p_token,'sha256'));
$$;
revoke all on function public.l_news_verify_worker(text) from public,anon,authenticated;
grant execute on function public.l_news_verify_worker(text) to service_role;

create function public.l_news_claim_jobs(p_limit integer default 1) returns setof public.l_news_jobs
language sql volatile security invoker set search_path='' as $$
 update public.l_news_jobs j set state='leased',attempts=j.attempts+1,
  lease_until=now()+interval '4 minutes',updated_at=now()
 where j.id in (select id from public.l_news_jobs
  where (state='waiting' or (state='leased' and lease_until<now())) and available_at<=now() and attempts<4
  order by id for update skip locked limit least(greatest(p_limit,1),3)) returning j.*;
$$;
revoke all on function public.l_news_claim_jobs(integer) from public,anon,authenticated;
grant execute on function public.l_news_claim_jobs(integer) to service_role;

create function public.l_news_reserve_call(p_run uuid,p_job bigint,p_provider text,p_endpoint text,p_page integer,p_run_limit integer,p_month_limit integer)
returns bigint language plpgsql security invoker set search_path='' as $$
declare k bigint; begin
 perform pg_advisory_xact_lock(hashtext('l-news-usage-'||p_provider));
 if p_run is not null and (select count(*) from public.l_news_usage where run_id=p_run and provider=p_provider and billable)>=p_run_limit then return null; end if;
 if (select count(*) from public.l_news_usage where provider=p_provider and billable and created_at>=date_trunc('month',now()))>=p_month_limit then return null; end if;
 insert into public.l_news_usage(run_id,job_id,provider,endpoint,page) values(p_run,p_job,p_provider,p_endpoint,p_page) returning id into k;
 return k;
end$$;
revoke all on function public.l_news_reserve_call(uuid,bigint,text,text,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.l_news_reserve_call(uuid,bigint,text,text,integer,integer,integer) to service_role;

create function public.l_news_new_revision() returns bigint language sql volatile security invoker set search_path='' as $$select nextval('public.l_news_revision_seq');$$;
revoke all on function public.l_news_new_revision() from public,anon,authenticated;
grant execute on function public.l_news_new_revision() to service_role;

create function public.l_news_enqueue_run(p_trigger text default 'manual') returns uuid
language plpgsql security invoker set search_path='' as $$
declare r uuid;s public.l_news_settings;finish timestamptz:=date_trunc('minute',now());dkey text;begin
 perform pg_advisory_xact_lock(hashtext('l-news-enqueue'));
 select * into s from public.l_news_settings where id=true;
 if p_trigger='scheduled' and not s.enabled then return null;end if;
 select id into r from public.l_news_runs where status in ('queued','discovering','processing') order by created_at limit 1;
 if r is not null then return r;end if;
 if p_trigger='scheduled' then dkey:=(finish at time zone 'Europe/Minsk')::date::text;end if;
 insert into public.l_news_runs(trigger_kind,daily_key,from_at,to_at,settings)
 values(p_trigger,dkey,finish-make_interval(hours=>s.lookback_hours),finish,to_jsonb(s))
 on conflict(daily_key) do nothing returning id into r;
 if r is not null then insert into public.l_news_jobs(run_id,kind,dedupe_key) values(r,'setup',r::text||':setup');end if;
 return r;
end$$;
revoke all on function public.l_news_enqueue_run(text) from public,anon,authenticated;
grant execute on function public.l_news_enqueue_run(text) to service_role;

create function l_news_private.wake() returns bigint
language plpgsql security invoker set search_path='' as $$
declare secret_value text;r bigint;begin
 if not exists(select 1 from public.l_news_jobs where (state='waiting' or (state='leased' and lease_until<now())) and available_at<=now() and attempts<4) then return null;end if;
 select decrypted_secret into secret_value from vault.decrypted_secrets where name='l_news_worker_token';
 select net.http_post(url:='https://kcmmnngcjfmyjzzczvko.supabase.co/functions/v1/l-news-collector',
  headers:=jsonb_build_object('content-type','application/json','x-l-news-worker',secret_value),
  body:='{"action":"worker"}'::jsonb,timeout_milliseconds:=120000) into r;
 return r;
end$$;
revoke all on function l_news_private.wake() from public,anon,authenticated;

-- Called by service_role only to wake a queue already populated by an authorized request.
create function public.l_news_wake() returns bigint
language sql volatile security definer set search_path='' as $$select l_news_private.wake();$$;
revoke all on function public.l_news_wake() from public,anon,authenticated;
grant execute on function public.l_news_wake() to service_role;

create function l_news_private.daily() returns void
language plpgsql security invoker set search_path='' as $$begin
 perform public.l_news_enqueue_run('scheduled');perform l_news_private.wake();
end$$;
revoke all on function l_news_private.daily() from public,anon,authenticated;

-- A heartbeat only performs an HTTP call while queue work is pending. Daily collection
-- is installed AFTER the pilot is verified: 7 12 * * * == 15:07 Europe/Minsk.
comment on table public.l_news_usage is 'Conservative request reservations, statuses, result counts and measured provider usage. No API keys or credential-bearing URLs.';
comment on table public.l_news_known_urls is 'Common L-Monitor canonical URL index; preserves historical GitHub document IDs and delivery state.';

