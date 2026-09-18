-- Upgrade an existing Monitor 0.5 Workroom backend to 0.5.1.
alter table public.monitor_profiles
  add column if not exists name_confirmed boolean not null default false;

update public.monitor_profiles
set name_confirmed = true
where is_admin = true;

drop policy if exists monitor_profiles_update_own_name on public.monitor_profiles;
create policy monitor_profiles_update_own_name
on public.monitor_profiles
for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

revoke update on public.monitor_profiles from authenticated;
grant update(display_name, name_confirmed) on public.monitor_profiles to authenticated;

revoke all on function public.monitor_handle_new_user() from public, anon, authenticated;
revoke all on function public.monitor_prepare_workroom_message() from public, anon, authenticated;
