-- Publisher IDs survive headline/slug revisions. Preserve the earliest delivered
-- card and its moderation identity; use the existing merge/withdrawal protocol.
do $$
declare article record;owner uuid;affected uuid;affected_runs uuid[]:=array[]::uuid[];
begin
 for article in select id,ready_run_id,substring(canonical_url from '/art([0-9]{6,12})(?:-|$)') article_id
   from public.l_news_items where source_domain='rp.pl' and state='ready'
     and canonical_url ~ '/art[0-9]{6,12}(-|$)' order by ready_at nulls last,id
 loop
  owner:=public.l_news_claim_alias('edition:rp.pl:'||article.article_id,article.id);
  if owner<>article.id then
   affected_runs:=array_append(affected_runs,article.ready_run_id);
   select ready_run_id into affected from public.l_news_items where id=owner;
   affected_runs:=array_append(affected_runs,affected);
   perform public.l_news_merge_edition(owner,article.id);
  end if;
 end loop;
 foreach affected in array affected_runs loop perform public.l_news_refresh_run(affected);end loop;
end$$;
