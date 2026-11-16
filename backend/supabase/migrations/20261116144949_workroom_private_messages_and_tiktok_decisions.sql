-- Personal correspondence is only accessible to the sender and recipient.
-- Keep the existing shared feed available to older clients.
create table public.workroom_private_messages (
  id uuid primary key default gen_random_uuid(),
  room_key text not null check (char_length(room_key) between 1 and 120),
  author_id uuid not null default auth.uid() references public.monitor_profiles(id) on delete cascade,
  recipient_id uuid not null references public.monitor_profiles(id) on delete cascade,
  text text not null check (char_length(btrim(text)) between 1 and 4000),
  created_at timestamptz not null default clock_timestamp(),
  read_at timestamptz,
  check (author_id <> recipient_id)
);

create index workroom_private_incoming_idx on public.workroom_private_messages
  (recipient_id, room_key, author_id, created_at desc);
create index workroom_private_outgoing_idx on public.workroom_private_messages
  (author_id, room_key, recipient_id, created_at desc);
create index workroom_private_unread_idx on public.workroom_private_messages
  (recipient_id, room_key, author_id) where read_at is null;

alter table public.workroom_private_messages enable row level security;
revoke all on public.workroom_private_messages from public, anon, authenticated;
grant select on public.workroom_private_messages to authenticated;
grant insert (room_key, recipient_id, text) on public.workroom_private_messages to authenticated;
grant update (read_at) on public.workroom_private_messages to authenticated;

create policy workroom_private_read_participants on public.workroom_private_messages
  for select to authenticated
  using (private.monitor_is_active((select auth.uid()))
         and (author_id = (select auth.uid()) or recipient_id = (select auth.uid())));

create policy workroom_private_send_as_self on public.workroom_private_messages
  for insert to authenticated
  with check (author_id = (select auth.uid())
              and private.monitor_is_active((select auth.uid()))
              and private.monitor_is_active(recipient_id));

create policy workroom_private_mark_read_as_recipient on public.workroom_private_messages
  for update to authenticated
  using (recipient_id = (select auth.uid()) and private.monitor_is_active((select auth.uid()))
         and read_at is null)
  with check (recipient_id = (select auth.uid()) and private.monitor_is_active((select auth.uid()))
              and read_at is not null);

-- Expose names and IDs of eligible contacts without widening access to profile records.
-- Include inactive former contacts only if the caller has a private conversation with them.
create function private.workroom_contacts_for_caller(p_room_key text)
returns table (id uuid, display_name text, can_receive boolean)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.display_name, p.status = 'active'
  from public.monitor_profiles p
  where private.monitor_is_active((select auth.uid()))
    and p.id <> (select auth.uid())
    and (p.status = 'active' or exists (
      select 1 from public.workroom_private_messages m
      where m.room_key = p_room_key and (
        (m.author_id = (select auth.uid()) and m.recipient_id = p.id)
        or (m.recipient_id = (select auth.uid()) and m.author_id = p.id)
      )
    ))
  order by p.display_name, p.id;
$$;

create function public.workroom_list_contacts(p_room_key text)
returns table (id uuid, display_name text, can_receive boolean)
language sql stable security invoker set search_path = ''
as $$
  select * from private.workroom_contacts_for_caller(p_room_key);
$$;

create function public.workroom_unread_counts(p_room_key text, p_public_since timestamptz)
returns table (author_id uuid, unread_count bigint)
language sql stable security invoker set search_path = ''
as $$
  select m.author_id, count(*)
  from public.workroom_private_messages m
  where m.room_key = p_room_key and m.recipient_id = (select auth.uid()) and m.read_at is null
  group by m.author_id
  union all
  select null::uuid, count(*)
  from public.workroom_messages m
  where m.room_key = p_room_key and m.author_id <> (select auth.uid())
    and (p_public_since is null or m.created_at > p_public_since);
$$;

revoke all on function private.workroom_contacts_for_caller(text) from public, anon, authenticated;
revoke all on function public.workroom_list_contacts(text) from public, anon, authenticated;
revoke all on function public.workroom_unread_counts(text, timestamptz) from public, anon, authenticated;
grant execute on function private.workroom_contacts_for_caller(text) to authenticated;
grant execute on function public.workroom_list_contacts(text) to authenticated;
grant execute on function public.workroom_unread_counts(text, timestamptz) to authenticated;

-- An editorial move is shared across devices and independent of producer data.
alter table public.tiktok_network_moderation
  add column operator_section text
    check (operator_section in ('appeals', 'complaints'));

create function public.tiktok_move_review_card(p_item_id text, p_section text)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare result jsonb;
begin
  if not private.monitor_is_admin((select auth.uid())) then
    raise exception 'TIKTOK_CLOUD_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_item_id is null or p_item_id !~ '^tiktok:[0-9]{10,25}$'
      or (p_section is not null and p_section not in ('appeals', 'complaints')) then
    raise exception 'TIKTOK_CLOUD_INVALID_MOVE';
  end if;
  if not exists (
      select 1 from public.tiktok_network_cards n where n.item_id = p_item_id
        and (n.card->>'operator_review_lane' in ('triage', 'gemini_veto')
             or (n.card->>'operator_lane' = 'review' and n.card->>'category' = 'REVIEW'))
  ) then
    raise exception 'TIKTOK_CLOUD_REVIEW_CARD_REQUIRED';
  end if;

  insert into public.tiktok_network_moderation as m (item_id, operator_section, updated_by)
  values (p_item_id, p_section, (select auth.uid()))
  on conflict (item_id) do update
    set operator_section = excluded.operator_section, updated_at = now(), updated_by = excluded.updated_by
    where not m.deleted
  returning jsonb_build_object('item_id', item_id, 'operator_section', operator_section)
  into result;

  if result is null then
    raise exception 'TIKTOK_CLOUD_CARD_DELETED';
  end if;
  return result;
end;
$$;

revoke all on function public.tiktok_move_review_card(text, text) from public, anon, authenticated;
grant execute on function public.tiktok_move_review_card(text, text) to authenticated;
