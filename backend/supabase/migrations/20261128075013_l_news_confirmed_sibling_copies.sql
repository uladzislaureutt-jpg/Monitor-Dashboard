-- Only the two confirmed sibling-edition families. Require substantial complete
-- text, an identical normalized body and the same UTC publication minute.
do $$
declare article record;owner uuid;target public.l_news_items;prior public.l_news_items;
 affected uuid;affected_runs uuid[]:=array[]::uuid[];
begin
 for article in
  select id,ready_run_id,'edition:copy:'||source_domain||':'||to_char(published_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI')||':'||
   encode(sha256(convert_to(trim(regexp_replace(normalize(original->>'body',NFKC),'\s+',' ','g')),'UTF8')),'hex') copy_key
  from public.l_news_items
  where state='ready' and source_domain in('news.yahoo.com','novosti.rs') and content_level='FULL_TEXT'
   and published_at is not null and length(trim(regexp_replace(normalize(original->>'body',NFKC),'\s+',' ','g')))>=1500
  order by ready_at nulls last,id
 loop
  owner:=public.l_news_claim_alias(article.copy_key,article.id);
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
