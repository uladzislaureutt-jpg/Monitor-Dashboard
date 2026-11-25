import {Candidate,Source,batches,buildCard,contentLevel,containsName,domainOf,publisherArticleKey,relevant,sha,sourceFor,urlKey,validDate} from './core.ts';
import {Job,Run,Runtime,must,newscatcherSubscription,perigonLimits,readPages,searchNewscatcher,searchPerigon} from './providers.ts';
import {searchGdelt} from './gdelt.ts';
import {recoverArticle} from './extraction.ts';
import {translateCard} from './translation.ts';
import {indexGithub} from './github.ts';

export async function enqueue(rt:Runtime,run:string|null,kind:string,payload:any,key:string,available?:string){
 const result=await rt.db.from('l_news_jobs').upsert({run_id:run,kind,payload,dedupe_key:key,...(available?{available_at:available}:{})},{onConflict:'dedupe_key',ignoreDuplicates:true});must(result);
}
async function sourcesFor(rt:Runtime):Promise<Source[]>{
 return readPages<Source>(rt.db.from('l_news_sources').select('*').eq('enabled',true).order('country').order('domain'));
}
async function setup(rt:Runtime,job:Job,run:Run){
 const warnings:string[]=[];
 const sources=(await sourcesFor(rt)).filter(source=>run.settings.countries.includes(source.country));
 const disabled=await readPages<{domain:string}>(rt.db.from('l_news_sources').select('domain').eq('enabled',false).order('domain'));
 const scope={source_domains:run.settings.country_scope?sources.map(source=>source.domain):[],
  excluded_domains:disabled.map(source=>source.domain)};
 try{warnings.push(...(await indexGithub(rt)).warnings);}catch{warnings.push('GitHub-индекс временно недоступен; повторы дополнительно объединяются в приложении');}
 if(rt.perigonKey){try{const quota=await perigonLimits(rt);await enqueue(rt,run.id,'perigon',{page:0,quota,layer:'name',...scope},run.id+':perigon:name:0');
  // The optional role query fits in the same four-request daily allowance.
  await enqueue(rt,run.id,'perigon',{page:0,quota,layer:'role',...scope},run.id+':perigon:role:0');}catch{warnings.push('Perigon: не удалось подтвердить доступную квоту');}}
 else warnings.push('Perigon: ключ отсутствует');
 if(rt.newscatcherKey){try{const account=await newscatcherSubscription(rt);
  const pageSize=Math.min(100,Number((account.subscription as any).articles?.max_articles_per_page)||100);
  if(Number((account.subscription as any).credits_balance??1)<5)warnings.push('Newscatcher: недостаточно кредитов');
  else for(const [i,part] of batches(sources,100).entries())await enqueue(rt,run.id,'newscatcher',{page:1,page_size:pageSize,domains:part.map(s=>s.domain),family:account.family,group:i},run.id+':newscatcher:'+i+':1');
 }catch{warnings.push('Newscatcher: не удалось подтвердить подписку');}}
 else warnings.push('Newscatcher: ключ отсутствует');
 if(run.settings.gdelt_per_run>0)await enqueue(rt,run.id,'gdelt',{},run.id+':gdelt:root');
 return {catalog_sources:sources.length,warnings};
}

async function ingest(rt:Runtime,job:Job,run:Run,candidates:Candidate[],sources:Source[]){
 const counts={returned:candidates.length,kept:0,duplicates:0,known:0,excluded:0,wrong_date:0,capped:false};
 const countResult=await rt.db.from('l_news_run_items').select('item_id',{count:'exact',head:true}).eq('run_id',run.id);if(countResult.error)throw countResult.error;
 let accepted=countResult.count||0;
 for(const c of candidates){
  const source=sourceFor(c.url,sources);if(!source||!run.settings.countries.includes(source.country)){counts.excluded++;continue;}
  let key:string;try{key=urlKey(c.url);}catch{counts.excluded++;continue;}
  c.country=source.country;c.domain=source.domain;c.title=String(c.title||'').slice(0,1500);c.lead=String(c.lead||'').slice(0,10000);c.body=String(c.body||'').slice(0,150000);
  if(c.published_at&&!validDate(c.published_at,run.from_at,run.to_at)){counts.wrong_date++;continue;}
  c.published_at=c.published_at?validDate(c.published_at,run.from_at,run.to_at):null;
  must(await rt.db.rpc('l_news_source_seen',{p_domain:source.domain,p_provider:c.provider,p_published:c.published_at}));
  const observation={run_id:run.id,provider:c.provider,provider_id:c.provider_id,url:c.url,content_level:contentLevel(c.body,!!c.paywall,!!c.content_truncated)};
  const already=must(await rt.db.from('l_news_observations').select('id').eq('run_id',run.id).eq('provider',c.provider).eq('provider_id',c.provider_id).maybeSingle());if(already){counts.duplicates++;continue;}
  const edition=publisherArticleKey(key);
  let alias=must(await rt.db.from('l_news_url_aliases').select('item_id').eq('alias',key).maybeSingle());
  if(!alias&&edition)alias=must(await rt.db.from('l_news_url_aliases').select('item_id').eq('alias',edition).maybeSingle());
  let item=alias?must(await rt.db.from('l_news_items').select('*').eq('id',alias.item_id).maybeSingle()):must(await rt.db.from('l_news_items').select('*').eq('canonical_url',key).maybeSingle());
  if(!item){
   const known=must(await rt.db.from('l_news_known_urls').select('*').eq('canonical_url',key).maybeSingle());
   if(known&&String(known.origin).startsWith('github')){
    const inserted=must(await rt.db.from('l_news_observations').upsert(
     {...observation,disposition:'already_reported_github'},
     {onConflict:'run_id,provider,provider_id',ignoreDuplicates:true}
    ).select('id'));
    if(!inserted.length){counts.duplicates++;continue;}
    counts.known++;continue;
   }
   if(accepted>=run.settings.candidate_limit){counts.capped=true;continue;}
   const uid=known?.document_uid||'lapi_'+(await sha(key)).slice(0,32);
   const result=await rt.db.from('l_news_items').insert({canonical_url:key,document_uid:uid,source_domain:source.domain,country:source.country,published_at:c.published_at,original:c,first_run_id:run.id}).select('*').single();
   if(result.error?.code==='23505')item=must(await rt.db.from('l_news_items').select('*').eq('canonical_url',key).single());else item=must(result);
   must(await rt.db.rpc('l_news_claim_alias',{p_alias:key,p_item:item.id}));accepted++;
  }
  const state=item.state==='ready'?'already_ready':'candidate';
  // Atomic uniqueness check: another search layer can ingest this provider ID
  // between our preflight SELECT and INSERT. Ignore the conflicting row safely.
  const inserted=must(await rt.db.from('l_news_observations').upsert(
   {...observation,item_id:item.id,disposition:state},
   {onConflict:'run_id,provider,provider_id',ignoreDuplicates:true}
  ).select('id'));
  if(!inserted.length){counts.duplicates++;continue;}
  must(await rt.db.from('l_news_items').update({last_seen_at:new Date().toISOString()}).eq('id',item.id));
  must(await rt.db.from('l_news_run_items').upsert({run_id:run.id,item_id:item.id,role:item.state==='ready'?'seen':'new'},{onConflict:'run_id,item_id',ignoreDuplicates:true}));
  if(item.state==='ready'){
   if(edition)must(await rt.db.rpc('l_news_claim_alias',{p_alias:key,p_item:item.id}));
   counts.duplicates++;continue;
  }
  if(item.state==='rejected'){counts.excluded++;continue;}
  if(c.body.length>String(item.original?.body||'').length){must(await rt.db.from('l_news_items').update({original:c,state:'pending'}).eq('id',item.id));}
  await enqueue(rt,run.id,'article',{item_id:item.id},run.id+':article:'+item.id);counts.kept++;
 }
 return counts;
}

async function article(rt:Runtime,job:Job,run:Run,sources:Source[]){
 const item=must(await rt.db.from('l_news_items').select('*').eq('id',job.payload.item_id).single());
 if(item.state==='ready'||item.reason==='canonical_duplicate')return {duplicate:true};
 const source=sources.find(s=>s.domain===item.source_domain);if(!source)throw new Error('source_not_in_catalog');
 let c=item.original as Candidate;let level=item.content_level,strategy='provider',attempts:any[]=[];
 // Persist extraction independently of translation, so retries reuse its bytes.
 if(!item.original.extraction_done){const recovered=await recoverArticle(rt,job,run,c,source,sources);c=recovered.candidate;level=recovered.level;strategy=recovered.strategy;attempts=recovered.attempts;
  must(await rt.db.from('l_news_items').update({original:{...c,extraction_done:true,extraction_strategy:strategy,extraction_attempts:attempts},content_level:level}).eq('id',item.id));
 }else strategy=item.original.extraction_strategy||'cached_original';
 const published=validDate(c.published_at,run.from_at,run.to_at);
 const rel=relevant(c);
 if(!published||!rel.pass){const reason=!published?'unconfirmed_or_outside_publication_window':rel.reason;must(await rt.db.from('l_news_items').update({state:'rejected',reason,updated_at:new Date().toISOString()}).eq('id',item.id));return {rejected:true,reason};}
 c.published_at=published;
 const canonical=urlKey(c.identity_url||c.canonical||c.url);
 const edition=publisherArticleKey(c.url)??(c.identity_url?`edition:${canonical}`:null);
 const owner=edition?item.id:must(await rt.db.rpc('l_news_claim_alias',{p_alias:canonical,p_item:item.id}));
 if(owner!==item.id){
  must(await rt.db.from('l_news_url_aliases').update({item_id:owner}).eq('item_id',item.id));
  must(await rt.db.from('l_news_observations').update({item_id:owner,disposition:'canonical_duplicate'}).eq('item_id',item.id));
  must(await rt.db.from('l_news_run_items').upsert({run_id:run.id,item_id:owner,role:'seen'},{onConflict:'run_id,item_id',ignoreDuplicates:true}));
  must(await rt.db.from('l_news_run_items').delete().eq('run_id',run.id).eq('item_id',item.id));
  must(await rt.db.from('l_news_items').update({state:'rejected',reason:'canonical_duplicate'}).eq('id',item.id));
  await enqueue(rt,run.id,'article',{item_id:owner},run.id+':article:'+owner);return {duplicate:true};
 }
 if(!edition)for(const alias of c.aliases??[])await rt.db.rpc('l_news_claim_alias',{p_alias:urlKey(alias),p_item:item.id}).then(must);
 if(source.domain==='fontanka.ru'&&/\/comments\/?$/.test(new URL(c.url).pathname))c={...c,url:urlKey(c.url)};
 const known=must(await rt.db.from('l_news_known_urls').select('*').eq('canonical_url',canonical).maybeSingle());
 if(known&&String(known.origin).startsWith('github')){
  must(await rt.db.from('l_news_items').update({state:'rejected',reason:'already_reported_github'}).eq('id',item.id));return {already_reported_github:true};
 }
 if(edition){
  const registered=must(await rt.db.from('l_news_url_aliases').select('item_id').eq('alias',edition).maybeSingle());
  if(registered&&registered.item_id!==item.id){
   must(await rt.db.rpc('l_news_merge_edition',{p_winner:registered.item_id,p_duplicate:item.id}));
   return {duplicate:true};
  }
 }
 const excerpt=rel.review?rel.evidence:(c.lead||c.body.slice(0,800));
 const translated=await translateCard(rt,job,run,c,source,excerpt,rel.review);
 if(!translated.accepted){
  must(await rt.db.from('l_news_items').update({state:'rejected',reason:translated.reason,updated_at:new Date().toISOString()}).eq('id',item.id));
  return {rejected:true,reason:translated.reason};
 }
 const uid=item.document_uid;
 const card=buildCard(c,source,uid,translated.title,translated.lead,level,translated.evidence??rel.evidence,run.id);
 (card.provenance as any).translation_provider=translated.route;(card.provenance as any).extraction_strategy=strategy;
 (card.provenance as any).relevance_reason=rel.review?'context_confirmed':rel.reason;
 const full=c.body.length>=350?{schema_version:'0.3',monitor_key:'lukashenko',document_id:uid,text:c.body,text_sha256:await sha(c.body),text_length:c.body.length,quality:level,extraction_strategy:strategy,transport:c.provider}:null;
 if(edition){
  const result=must(await rt.db.rpc('l_news_publish_edition',{
   p_key:edition,p_item:item.id,p_run:run.id,p_canonical:canonical,
   p_aliases:[...new Set([canonical,item.canonical_url,...(c.aliases??[]).map(urlKey)])],
   p_card:card,p_full_text:full,p_level:level,p_published:published,
  }));
  return result?{ready:true,level,translation:translated.route,extraction:strategy}:{duplicate:true};
 }
 const revision=must(await rt.db.rpc('l_news_new_revision'));
 must(await rt.db.from('l_news_items').update({state:'ready',reason:null,card,full_text:full,content_level:level,published_at:published,ready_at:new Date().toISOString(),ready_run_id:run.id,revision,updated_at:new Date().toISOString()}).eq('id',item.id));
 must(await rt.db.from('l_news_known_urls').upsert({canonical_url:canonical,document_uid:uid,origin:'api_collector',content_level:level,aliases:[item.canonical_url],observed_at:new Date().toISOString()},{onConflict:'canonical_url'}));
 return {ready:true,level,translation:translated.route,extraction:strategy};
}

export async function workOne(rt:Runtime,job:Job){
 if(job.kind==='github_index')return await indexGithub(rt);
 const run=job.run_id?must(await rt.db.from('l_news_runs').select('*').eq('id',job.run_id).single()) as Run:null;
 if(!run)throw new Error('job_run_missing');if(run.status==='cancelled')return {cancelled:true};
 if(job.kind==='repair_card'){
  const item=must(await rt.db.from('l_news_items').select('*').eq('id',job.payload.item_id).single());
  if(item.state!=='ready'||containsName(item.card?.provenance?.evidence||''))return {unchanged:true};
  const rel=relevant(item.original);if(!rel.pass)return {unchanged:true};
  const source=(await sourcesFor(rt)).find(s=>s.domain===item.source_domain)!;
  const translated=await translateCard(rt,job,run,item.original,source,rel.evidence);
  if(!translated.accepted)return {unchanged:true};
  item.card.publication.excerpt=translated.lead;item.card.provenance.evidence=rel.evidence;
  const revision=must(await rt.db.rpc('l_news_new_revision'));
  must(await rt.db.from('l_news_items').update({card:item.card,revision,updated_at:new Date().toISOString()}).eq('id',item.id));return {repaired:true};
 }
 if(job.kind==='setup')return setup(rt,job,run);
 const sources=await sourcesFor(rt);
 if(job.kind==='article')return article(rt,job,run,sources);
 if(job.kind==='perigon'||job.kind==='newscatcher'||job.kind==='gdelt'){
  const found:any=job.kind==='perigon'?await searchPerigon(rt,job,run):job.kind==='newscatcher'?await searchNewscatcher(rt,job,run):await searchGdelt(rt,job,run);
  if(found.capped)return {capped:true,provider:job.kind};
  if(job.kind==='gdelt'&&(found.warnings||found.retry_at))return found;
  const result=await ingest(rt,job,run,found.candidates,sources);
  if(found.next){const next=Number(found.page)+1;await enqueue(rt,run.id,job.kind,{...job.payload,page:next,quota:found.quota||job.payload.quota},run.id+':'+job.kind+':'+(job.payload.layer||job.payload.group)+':'+next);}
  if(found.split){const middle=new Date(Math.floor((Date.parse(found.from)+Date.parse(found.to))/2)).toISOString();for(const [from,to] of [[found.from,middle],[middle,found.to]])await enqueue(rt,run.id,'gdelt',{from,to},run.id+':gdelt:'+from+':'+to);}
  return result;
 }
 throw new Error('unknown_job_kind');
}
