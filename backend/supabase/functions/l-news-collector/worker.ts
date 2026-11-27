import {Candidate,Source,batches,buildCard,contentLevel,containsName,domainOf,publisherArticleKey,relevant,samePublisherHeadlineKey,sha,sourceFor,urlKey,validDate} from './core.ts';
import {Job,Run,Runtime,must,newscatcherSubscription,perigonLimits,readPages,searchNewscatcher,searchPerigon} from './providers.ts';
import {searchGdelt} from './gdelt.ts';
import {recoverArticle} from './extraction.ts';
import {translateCard} from './translation.ts';
import {indexGithub} from './github.ts';
import {assistantId,cloroCountries,currentsPlans,probeAssistant2,submitCloro,pollCloro,searchCurrents} from './assistant2.ts';
import {thenewsPlans,searchTheNews,continueDiscovery,discoveryJobKey,thenewsSplitPlans} from './discovery.ts';

export async function enqueue(rt:Runtime,run:string|null,kind:string,payload:any,key:string,available?:string){
 const result=await rt.db.from('l_news_jobs').upsert({run_id:run,kind,payload,dedupe_key:key,...(available?{available_at:available}:{})},{onConflict:'dedupe_key',ignoreDuplicates:true});must(result);
}
async function sourcesFor(rt:Runtime):Promise<Source[]>{
 return readPages<Source>(rt.db.from('l_news_sources').select('*').eq('enabled',true).order('country').order('domain'));
}
async function setup(rt:Runtime,job:Job,run:Run){
 const warnings:string[]=[];
 const second=assistantId(run)===2;
 const sources=(await sourcesFor(rt)).filter(source=>run.settings.countries.includes(source.country));
 const disabled=await readPages<{domain:string}>(rt.db.from('l_news_sources').select('domain').eq('enabled',false).order('domain'));
 const scope={source_domains:run.settings.country_scope?sources.map(source=>source.domain):[],
  excluded_domains:disabled.map(source=>source.domain)};
 try{warnings.push(...(await indexGithub(rt)).warnings);}catch{warnings.push('GitHub-индекс временно недоступен; повторы дополнительно объединяются в приложении');}
 const secondQuota=second?await probeAssistant2(rt):null;
 if(secondQuota)warnings.push(...secondQuota.warnings);
 if(!second&&rt.perigonKey){try{const quota=await perigonLimits(rt);await enqueue(rt,run.id,'perigon',{page:0,quota,layer:'name',...scope},run.id+':perigon:name:0');
  // The optional role query fits in the same four-request daily allowance.
  await enqueue(rt,run.id,'perigon',{page:0,quota,layer:'role',...scope},run.id+':perigon:role:0');}catch{warnings.push('Perigon: не удалось подтвердить доступную квоту');}}
 else if(!second)warnings.push('Perigon: ключ отсутствует');
 if((!second||run.settings.newscatcher_enabled)&&rt.newscatcherKey){try{const account=secondQuota?.newscatcher||await newscatcherSubscription(rt);
  const pageSize=Math.min(100,Number((account.subscription as any).articles?.max_articles_per_page)||100);
  if(Number((account.subscription as any).credits_balance??1)<5)warnings.push('Newscatcher: недостаточно кредитов');
  else for(const [i,part] of batches(sources,100).entries())await enqueue(rt,run.id,'newscatcher',{page:1,page_size:pageSize,domains:part.map(s=>s.domain),family:account.family,group:i},run.id+':newscatcher:'+i+':1');
 }catch{warnings.push('Newscatcher: не удалось подтвердить подписку');}}
 else if(!second||run.settings.newscatcher_enabled)warnings.push('Newscatcher: ключ отсутствует');
 if(!second&&run.settings.gdelt_per_run>0)await enqueue(rt,run.id,'gdelt',{},run.id+':gdelt:root');
 if(second&&run.settings.cloro_enabled){
  if(rt.secret('CLORO_API_KEY'))for(const country of cloroCountries(run))await enqueue(rt,run.id,'cloro',{country},run.id+':cloro:'+country);
  else warnings.push('Cloro: ключ отсутствует');
 }
 if(second&&run.settings.currents_enabled){
  if(rt.secret('CURRENTSAPI_API_KEY'))for(const plan of currentsPlans(run))await enqueue(rt,run.id,'currents',plan,discoveryJobKey(run.id,'currents',plan));
  else warnings.push('Currents: ключ отсутствует');
 }
 if(second&&run.settings.thenews_enabled){
  if(rt.secret('THENEWSAPI_API_KEY','THE_NEWS_API_KEY'))for(const plan of thenewsPlans(run,sources))await enqueue(rt,run.id,'thenews',plan,discoveryJobKey(run.id,'thenews',plan));
  else warnings.push('The News API: ключ отсутствует');
 }
 return {catalog_sources:sources.length,warnings};
}

async function ingest(rt:Runtime,job:Job,run:Run,candidates:Candidate[],sources:Source[]){
 const counts={returned:candidates.length,new_to_index:0,kept:0,duplicates:0,known:0,excluded:0,wrong_date:0,capped:false};
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
   if(result.error?.code==='23505')item=must(await rt.db.from('l_news_items').select('*').eq('canonical_url',key).single());else {item=must(result);counts.new_to_index++;}
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
  else if(!item.original?.published_at&&c.published_at){
   must(await rt.db.from('l_news_items').update({original:{...item.original,published_at:c.published_at,lead:item.original?.lead||c.lead},published_at:c.published_at}).eq('id',item.id));
  }
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
 const publicationEdition=edition||await samePublisherHeadlineKey(source.domain,translated.title,published);
 const card=buildCard(c,source,uid,translated.title,translated.lead,level,translated.evidence??rel.evidence,run.id);
 (card.provenance as any).translation_provider=translated.route;(card.provenance as any).extraction_strategy=strategy;
 (card.provenance as any).relevance_reason=rel.review?'context_confirmed':rel.reason;
 const full=c.body.length>=350?{schema_version:'0.3',monitor_key:'lukashenko',document_id:uid,text:c.body,text_sha256:await sha(c.body),text_length:c.body.length,quality:level,extraction_strategy:strategy,transport:c.provider}:null;
 if(publicationEdition){
  const result=must(await rt.db.rpc('l_news_publish_edition',{
   p_key:publicationEdition,p_item:item.id,p_run:run.id,p_canonical:canonical,
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
 if(job.kind==='cloro'){
  const submitted=await submitCloro(rt,job,run);
  if(submitted.capped)return {capped:true,provider:'cloro'};
  await enqueue(rt,run.id,'cloro_poll',submitted,run.id+':cloro_poll:'+job.id,new Date(Date.now()+2000).toISOString());
  return {submitted:true,country:job.payload.country};
 }
 if(job.kind==='article')return article(rt,job,run,sources);
 if(['perigon','newscatcher','gdelt','currents','thenews','cloro_poll'].includes(job.kind)){
  if(['currents','thenews'].includes(job.kind)){const cap=await rt.db.from('l_news_run_items').select('item_id',{count:'exact',head:true}).eq('run_id',run.id);if(cap.error)throw cap.error;if((cap.count||0)>=run.settings.candidate_limit)return {warnings:['Достигнут лимит кандидатов на сбор; дальнейшие поисковые обращения остановлены.']};}
  const found:any=job.kind==='cloro_poll'?await pollCloro(rt,job):job.kind==='thenews'?await searchTheNews(rt,job,run):job.kind==='currents'?await searchCurrents(rt,job,run):job.kind==='perigon'?await searchPerigon(rt,job,run):job.kind==='newscatcher'?await searchNewscatcher(rt,job,run):await searchGdelt(rt,job,run);
  if(found.capped)return {capped:true,provider:job.kind};
  if(found.retry_at||(job.kind==='gdelt'&&found.warnings))return found;
  const result=await ingest(rt,job,run,found.candidates,sources);
  let extend=found.next&&!result.capped;
  let room=true;
  let split=false;
  if(['currents','thenews'].includes(job.kind)){
   const planned=await rt.db.from('l_news_jobs').select('id',{count:'exact',head:true}).eq('run_id',run.id).eq('kind',job.kind);
   if(planned.error)throw planned.error;
   room=(planned.count||0)<Number(run.settings[job.kind+'_per_run']);
   if(job.kind==='thenews'&&extend&&room){
    const parts=thenewsSplitPlans(run,job.payload,found,sources);
    // Split only when all child directions fit; otherwise retain parent paging.
    if(parts.length&&parts.length<=Number(run.settings.thenews_per_run)-(planned.count||0)){
     for(const plan of parts)await enqueue(rt,run.id,'thenews',plan,discoveryJobKey(run.id,'thenews',plan));
     split=true;
    }
   }
   extend=extend&&room&&!split&&continueDiscovery(job.kind,Number(found.page),Number(found.max_pages),true,result.new_to_index+result.kept);
  }
  if(extend){const next=Number(found.page)+1,plan={...job.payload,page:next,quota:found.quota||job.payload.quota};
   const key=job.kind==='currents'||job.kind==='thenews'?discoveryJobKey(run.id,job.kind,plan):run.id+':'+job.kind+':'+(job.payload.layer??job.payload.group)+':'+next;
   await enqueue(rt,run.id,job.kind,plan,key);
  }
  if(found.split){const middle=new Date(Math.floor((Date.parse(found.from)+Date.parse(found.to))/2)).toISOString();for(const [from,to] of [[found.from,middle],[middle,found.to]])await enqueue(rt,run.id,'gdelt',{from,to},run.id+':gdelt:'+from+':'+to);}
  const discovery=['currents','thenews'].includes(job.kind)?{page:found.page,...(job.kind==='currents'?{language:job.payload.language,type:found.type,variant:found.variant}:{total_hits:found.total_hits,partition:job.payload.partition??null,split})}:{};
  return found.warnings?.length?{...result,...discovery,warnings:found.warnings}:{...result,...discovery};
 }
 throw new Error('unknown_job_kind');
}
