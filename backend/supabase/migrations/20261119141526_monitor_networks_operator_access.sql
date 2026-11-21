insert into public.monitor_access (monitor_key, enabled, maintenance_message_ru, maintenance_message_be)
values ('tiktok', true, 'Технические работы', 'Тэхнічныя работы')
on conflict (monitor_key) do nothing;

-- Both flags are read with the caller's RLS. The existing admin policies are
-- also evaluated, so global maintenance only closes the archive to operators.
create policy tiktok_cards_operator_select on public.tiktok_network_cards
  for select to authenticated
  using (
    (select private.monitor_is_active(auth.uid()))
    and (
      select exists (
        select 1
        from public.monitor_access as module
        join public.user_monitor_access as personal using (monitor_key)
        where module.monitor_key = 'tiktok'
          and module.enabled
          and personal.user_id = (select auth.uid())
          and personal.enabled
      )
    )
  );

create policy tiktok_moderation_operator_select on public.tiktok_network_moderation
  for select to authenticated
  using (
    (select private.monitor_is_active(auth.uid()))
    and (
      select exists (
        select 1
        from public.monitor_access as module
        join public.user_monitor_access as personal using (monitor_key)
        where module.monitor_key = 'tiktok'
          and module.enabled
          and personal.user_id = (select auth.uid())
          and personal.enabled
      )
    )
  );
