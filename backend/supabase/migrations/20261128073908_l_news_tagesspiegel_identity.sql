-- Search shared GitHub identities without depending on headline/slug equality.
create index if not exists l_news_known_github_publisher_aliases
on public.l_news_known_urls using gin(aliases) where origin='github_bundle';

update public.l_news_known_urls
set aliases=array_append(aliases,'edition:tagesspiegel.de:'||substring(canonical_url from '-([0-9]{6,12})\.html(?:[?#]|$)'))
where canonical_url ~ '^https://tagesspiegel[.]de/.*-[0-9]{6,12}[.]html([?#]|$)'
 and canonical_url !~ '/liveblog/'
 and not ('edition:tagesspiegel.de:'||substring(canonical_url from '-([0-9]{6,12})\.html(?:[?#]|$)')=any(aliases));

-- Preserve the earliest delivered identity, its operator links and run history.
-- Only confirmed numeric IDs of ordinary Tagesspiegel articles are merged.
do $$
declare article record;owner uuid;target public.l_news_items;prior public.l_news_items;
 affected uuid;affected_runs uuid[]:=array[]::uuid[];
begin
 for article in select id,ready_run_id,substring(canonical_url from '-([0-9]{6,12})\.html(?:[?#]|$)') article_id
  from public.l_news_items where source_domain='tagesspiegel.de' and state='ready'
   and canonical_url ~ '-[0-9]{6,12}[.]html([?#]|$)' and canonical_url !~ '/liveblog/'
  order by ready_at nulls last,id
 loop
  owner:=public.l_news_claim_alias('edition:tagesspiegel.de:'||article.article_id,article.id);
  if owner<>article.id then
   select * into strict target from public.l_news_items where id=owner;
   select * into strict prior from public.l_news_items where id=article.id;
   insert into public.publication_flags(room_key,monitor_key,document_uid,user_id,user_name,created_at)
    select room_key,monitor_key,target.document_uid,user_id,user_name,created_at from public.publication_flags
    where monitor_key='lukashenko' and document_uid=prior.document_uid on conflict do nothing;
   insert into public.publication_exclusions(room_key,monitor_key,document_uid,excluded_by,excluded_by_name,created_at)
    select room_key,monitor_key,target.document_uid,excluded_by,excluded_by_name,created_at from public.publication_exclusions
    where monitor_key='lukashenko' and document_uid=prior.document_uid on conflict do nothing;
   affected_runs:=array_append(affected_runs,article.ready_run_id);
   affected_runs:=array_append(affected_runs,target.ready_run_id);
   perform public.l_news_merge_edition(owner,article.id);
  end if;
 end loop;
 foreach affected in array affected_runs loop perform public.l_news_refresh_run(affected);end loop;
end$$;
