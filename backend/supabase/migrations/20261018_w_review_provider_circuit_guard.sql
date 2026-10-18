-- Do not retry structurally invalid Gemini Evidence requests across adjacent batches.
-- Only service-role code may read and write suspension state.
create table if not exists public.w_review_provider_circuit (
  route text primary key,
  suspended_until timestamptz not null,
  reason_code text not null,
  http_status integer not null,
  updated_at timestamptz not null default now(),
  constraint w_review_provider_circuit_route_length check(length(route) between 1 and 100)
);
alter table public.w_review_provider_circuit enable row level security;
revoke all on public.w_review_provider_circuit from anon, authenticated;
grant select,insert,update,delete on public.w_review_provider_circuit to service_role;
comment on table public.w_review_provider_circuit is
  'W-Review transient provider failure circuit; service-only, no user data.';
