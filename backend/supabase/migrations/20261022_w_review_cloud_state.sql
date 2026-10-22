-- Account-owned W-Review snapshot for three workspaces and shared style.
-- A single atomic payload preserves Evidence, author samples and review drafts.
-- revision enables compare-and-swap to prevent an offline PC overwriting a
-- more recently synchronized PC.
create table if not exists public.w_review_cloud_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1 check(revision>=1),
  payload jsonb not null check(jsonb_typeof(payload)='object'),
  updated_at timestamptz not null default now(),
  constraint w_review_cloud_state_max_bytes check(octet_length(payload::text)<=4800000)
);
alter table public.w_review_cloud_state enable row level security;

drop policy if exists w_review_cloud_select_own on public.w_review_cloud_state;
create policy w_review_cloud_select_own on public.w_review_cloud_state
for select to authenticated using (user_id=(select auth.uid()));

drop policy if exists w_review_cloud_insert_own on public.w_review_cloud_state;
create policy w_review_cloud_insert_own on public.w_review_cloud_state
for insert to authenticated with check(user_id=(select auth.uid()));

drop policy if exists w_review_cloud_update_own on public.w_review_cloud_state;
create policy w_review_cloud_update_own on public.w_review_cloud_state
for update to authenticated using(user_id=(select auth.uid()))
with check(user_id=(select auth.uid()));

revoke all on public.w_review_cloud_state from anon;
grant select,insert,update on public.w_review_cloud_state to authenticated;
grant select,insert,update,delete on public.w_review_cloud_state to service_role;
comment on table public.w_review_cloud_state is 'Private cross-device W-Review workspaces + shared editorial style; per-user CAS revision, no anonymous access.';
