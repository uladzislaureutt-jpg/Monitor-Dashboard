create table public.monitor_event_runs (
  id uuid not null,
  owner_id uuid not null references public.monitor_profiles(id) on delete cascade,
  task text not null check (char_length(task) between 1 and 500),
  options jsonb not null,
  status text not null check (status in ('running', 'complete', 'partial', 'failed')),
  stage text not null check (stage in ('search', 'sources', 'reserve', 'summary', 'done')),
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id)
);

create index monitor_event_runs_owner_created_idx
  on public.monitor_event_runs (owner_id, created_at desc);

alter table public.monitor_event_runs enable row level security;
revoke all on public.monitor_event_runs from public, anon, authenticated;
grant select, insert, update on public.monitor_event_runs to service_role;

insert into public.monitor_access (monitor_key, enabled, maintenance_message_ru, maintenance_message_be)
values ('event_trace', true, 'Технические работы', 'Тэхнічныя работы')
on conflict (monitor_key) do nothing;
