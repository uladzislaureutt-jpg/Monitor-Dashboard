import {createClient} from 'npm:@supabase/supabase-js@2.98.0';
import {AUDIT,auditQueries,auditWindows} from './plan.ts';
import {readPages,must,Runtime} from '../l-news-collector/providers.ts';
import {sourceFor,relevant,sha} from '../l-news-collector/core.ts';
import {indexGithub} from '../l-news-collector/github.ts';
import {fetchPage,extractPage} from '../l-news-collector/extraction.ts';
const env=Deno.env.toObject();
const secret=(...names:string[])=>{for(const name of names){const v=env[Object.keys(env).find(k=>k.toLowerCase()===name.toLowerCase())||''];if(v)return v;}return '';};
const db=createClient(secret('SUPABASE_URL'),secret('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}});
const rt:Runtime={db,secret,perigonKey:'',newscatcherKey:''};
const json=(body:unknown,status=200)=>Response.json(body,{status});
const rows=()=>readPages<any>(db.from('l_news_usage').select('id,endpoint,status,result_count,credits,billable,details,created_at').eq('provider','newsdata').order('id'));
Deno.serve(async req=>{try{
 if(req.method!=='POST')return json({error:'method_not_allowed'},405);
 const auth=await db.rpc('l_news_verify_worker',{p_token:req.headers.get('x-l-news-worker')||''});if(auth.error||auth.data!==true)return json({error:'unauthorized'},401);
 const control=must(await db.from('l_news_provider_state').select('info').eq('provider','newsdata_audit_control').maybeSingle());if(control?.info.closed)return json({error:'audit_closed'},410);
 const body=await req.json(),action=String(body.action||'status');
 if(action==='close'){must(await db.from('l_news_provider_state').upsert({provider:'newsdata_audit_control',info:{closed:true,audit_id:AUDIT},updated_at:new Date().toISOString()}));return json({closed:true});}
 if(action==='refresh_github')return json(await indexGithub(rt));
 if(action==='status')return json({windows:auditWindows(),queries:auditQueries(),pages:(await rows()).map(r=>({id:r.id,endpoint:r.endpoint,status:r.status,count:r.result_count,credits:r.credits,summary:r.details.summary}))});
 if(action==='extract'){
  const all=await rows(),existing=all.find(r=>r.endpoint==='audit_article_20261128'&&r.details.url===body.url);if(existing&&!(body.retry===true&&String(body.url).startsWith('https://tass.ru/')))return json({cached:true,id:existing.id});
  const hit=all.flatMap(r=>r.details.response?.results||[]).find((a:any)=>(a.url||a.link)===body.url);
  if(!hit)return json({error:'article_not_from_audit'},400);
  const catalog=await readPages<any>(db.from('l_news_sources').select('*').eq('enabled',true).order('domain')),source=sourceFor(body.url,catalog);if(!source)return json({error:'outside_catalog'},400);
  const record=must(await db.from('l_news_usage').insert({provider:'newsdata',endpoint:'audit_article_20261128',billable:false,credits:0,details:{audit_id:AUDIT,url:body.url}}).select('id').single());
  let details:any={audit_id:AUDIT,url:body.url};
  try{let page=await fetchPage(body.url),x=page.status===200?extractPage(page.html,page.url):null;
   if(source.domain==='tass.ru'&&(!x?.articlePage||!x.body)){const u=new URL(body.url);if(/^\/mezhdunarodnaya-panorama\/[0-9]+$/.test(u.pathname)){u.pathname=u.pathname.replace('/mezhdunarodnaya-panorama/','/mezhdunarodnaya-panorama/amp/');const alternate=await fetchPage(u.href),parsed=alternate.status===200?extractPage(alternate.html,alternate.url):null;if(parsed?.articlePage&&parsed.body){page=alternate;x=parsed;}}}
   const c:any={url:body.url,title:x?.title||hit.title,lead:x?.lead||hit.meta_description||hit.description||'',body:x?.body||'',published_at:x?.published||hit.published_at,language:hit.language,provider:'newsdata',provider_id:hit.id,country:source.country,domain:source.domain};
   details={...details,status:page.status,final_url:page.url,candidate:c,article_page:x?.articlePage,paywall:x?.paywall,relevance:relevant(c),body_sha:await sha(c.body)};
  }catch{details={...details,status:0,error:'publisher_transport_or_extraction_failed'};}
  must(await db.from('l_news_usage').update({status:details.status,details}).eq('id',record.id));return json({id:record.id,status:details.status,body_chars:details.candidate?.body.length,relevance:details.relevance});
 }
 if(action!=='page')return json({error:'unknown_action'},400);
 const key=secret('NEWSDATA_API_KEY');if(!key)return json({error:'newsdata_key_missing'},503);
 const query=auditQueries()[Number(body.query_index)];if(!query)return json({error:'invalid_query'},400);
 const page=body.page==null?'':String(body.page);if(page.length>200||page&&!/^[a-zA-Z0-9_=.-]+$/.test(page))return json({error:'invalid_cursor'},400);
 const mode=body.mode==='undated'?'undated':'dated',requestKey=await sha(AUDIT+':mature-v2:'+body.query_index+':'+mode+':'+page),all=await rows();
 const prior=all.find(r=>r.details.request_key===requestKey&&r.status===200);if(prior)return json({cached:true,id:prior.id,status:prior.status,count:prior.result_count,...prior.details.summary});
 const calls=all.filter(r=>r.billable),last=calls.filter(r=>r.details.response_headers).at(-1)?.details.response_headers||{};
 const limit=Number(last['x-ratelimit-limit']||30),remaining=Number(last['x-api-limit-remaining']||last.x_api_limit_remaining||200);
 if(calls.length>=180||remaining<=15)return json({error:'audit_budget_exhausted'},429);
 const reset=Number(last['x-ratelimit-reset']||0)*1000,rateRemaining=Number(last['x-ratelimit-remaining']||limit);
 if(reset>Date.now()&&rateRemaining<=5)return json({error:'local_rate_pause',retry_at:new Date(reset+2000).toISOString()},429);
 const usage=must(await db.rpc('l_news_reserve_call',{p_run:null,p_job:null,p_provider:'newsdata',p_endpoint:'audit_newsdata_20261128',p_page:1,p_run_limit:180,p_month_limit:180}));if(!usage)return json({error:'audit_budget_exhausted'},429);
 must(await db.from('l_news_usage').update({credits:1,details:{audit_id:AUDIT,request_key:requestKey,index:body.query_index,query:query.q,mode,page}}).eq('id',usage));
 const params=new URLSearchParams({apikey:key,q:query.q,size:'10'}),windows=auditWindows();
 if(mode==='dated'){params.set('from_date',windows.union.from.slice(0,19).replace('T',' '));params.set('to_date',windows.mature.to.slice(0,19).replace('T',' '));}
 if(page)params.set('page',page);
 const start=Date.now();let status=0,data:any={},headers:Record<string,string>={};
 try{const response=await fetch('https://newsdata.io/api/2/news?'+params,{signal:AbortSignal.timeout(45000)});status=response.status;data=JSON.parse(JSON.stringify(await response.json()).replaceAll(key,'[REDACTED]'));headers=Object.fromEntries([...response.headers].filter(([n])=>/limit|credit|usage|retry|date/i.test(n)));}catch{data={error:'transport_or_parse_error'};}
 const articles=Array.isArray(data.results)?data.results:[],summary={next:data.next_page??data.nextPage??null,total:data.total_results??data.totalResults??null,error:data.status==='error'?data.results??data.error:undefined,min_date:articles.map((a:any)=>a.published_at??a.pubDate).filter(Boolean).sort()[0]??null};
 const after=Number(headers['x-api-limit-remaining']||headers.x_api_limit_remaining),before=Number(last['x-api-limit-remaining']||last.x_api_limit_remaining),credits=Number.isFinite(after)&&Number.isFinite(before)?Math.min(1,Math.max(0,before-after)):status>=400?0:1;
 must(await db.from('l_news_usage').update({status,credits,result_count:articles.length,elapsed_ms:Date.now()-start,details:{audit_id:AUDIT,request_key:requestKey,index:body.query_index,kind:query.kind,query:query.q,mode,page,response_headers:headers,summary,response:data}}).eq('id',usage));
 return json({id:usage,status,count:articles.length,...summary,headers});
}catch{return json({error:'audit_failure'},500);}});
