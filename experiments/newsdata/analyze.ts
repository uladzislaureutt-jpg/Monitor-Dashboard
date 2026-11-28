import {sourceFor,urlKey,publisherArticleKey,relevant,clean} from '../../backend/supabase/functions/l-news-collector/core.ts';
import {auditWindows,inWindow} from '../../backend/supabase/functions/l-newsdata-audit/plan.ts';
const data=JSON.parse(await Deno.readTextFile(Deno.args[0]));
const {baseline,rows}=data,windows=auditWindows(),cutoff='2026-11-27T16:07:00Z';
const identity=(url:string)=>{try{return [urlKey(url),publisherArticleKey(url)].filter(Boolean) as string[];}catch{return [];}};
const lookup=new Map<string,any[]>();
for(const r of [...baseline.known.map((r:any)=>({...r,record:'known'})),...baseline.items.map((r:any)=>({...r,record:'item'}))]){
 const urls=[r.canonical_url,...(r.aliases||[]),...(r.card_aliases||[])];
 for(const v of urls)for(const k of v.startsWith('edition:')?[v]:identity(v))lookup.set(k,[...(lookup.get(k)||[]),r]);
}
const raw=rows.filter((r:any)=>r.endpoint==='audit_newsdata_20261128'&&r.status===200).flatMap((r:any)=>r.details.response.results.map((a:any)=>({...a,query_index:r.details.index})));
const unique=new Map<string,any>();
for(const a of raw){const url=a.url||a.link,key=identity(url).at(-1)||url;
 if(unique.has(key)){unique.get(key).queries.push(a.query_index);continue;}
 const source=sourceFor(url,baseline.catalog),published_at=a.published_at||a.pubDate;
 const matches=identity(url).flatMap(k=>lookup.get(k)||[]),known=matches.filter(x=>x.record==='known'),items=matches.filter(x=>x.record==='item');
 const candidate={url,title:clean(a.title),lead:clean(a.meta_description||a.description),body:'',published_at,provider:'newsdata',provider_id:a.id,language:a.language,country:source?.country||'',domain:source?.domain||''};
 const classification=known.length||items.some(x=>x.state==='ready')?'known':items.length?'seen_unpublished':'unseen';
 unique.set(key,{...candidate,id:a.id,source_name:source?.name,in_catalog:!!source,requested:inWindow(published_at,windows.requested),mature:inWindow(published_at,windows.mature),after_helpers:Date.parse(published_at)>Date.parse(cutoff),classification,matches,queries:[a.query_index],initial_relevance:relevant(candidate),api_duplicate:a.duplicate,datatype:a.datatype});
}
const results=[...unique.values()],catalog=results.filter(x=>x.in_catalog&&(x.requested||x.mature));
const count=(xs:any[],key:string)=>Object.fromEntries([...new Set(xs.map(x=>x[key]))].sort().map(v=>[String(v),xs.filter(x=>x[key]===v).length]));
const summary={windows,cutoff,catalog_size:baseline.catalog.length,catalog_countries:new Set(baseline.catalog.map((s:any)=>s.country)).size,raw:raw.length,unique:results.length,outside_catalog:results.filter(x=>!x.in_catalog).length,outside_windows:results.filter(x=>x.in_catalog&&!x.requested&&!x.mature).length,catalog:catalog.length,domains:new Set(catalog.map(x=>x.domain)).size,countries:count(catalog,'country'),classification:count(catalog,'classification'),requested:count(catalog.filter(x=>x.requested),'classification'),mature:count(catalog.filter(x=>x.mature),'classification'),before_helpers:count(catalog.filter(x=>!x.after_helpers),'classification'),after_helpers:count(catalog.filter(x=>x.after_helpers),'classification'),by_query:rows.filter((r:any)=>r.endpoint==='audit_newsdata_20261128'&&r.status===200).reduce((acc:any,r:any)=>{const i=r.details.index;acc[i]??={query:r.details.query,pages:0,rows:0,total:r.details.summary.total};acc[i].pages++;acc[i].rows+=r.details.response.results.length;return acc;},{})};
const output={summary,candidates:catalog.filter(x=>x.classification!=='known'),catalog,results};
await Deno.writeTextFile(Deno.args[1]||'/workspace/scratch/a639f05d8cae/newsdata-analysis.json',JSON.stringify(output,null,2));
console.log(JSON.stringify(summary,null,2));
console.log(JSON.stringify(output.candidates.map(x=>({url:x.url,title:x.title,published:x.published_at,country:x.country,class:x.classification,late:x.after_helpers,relevance:x.initial_relevance,seen:x.matches.map((m:any)=>({state:m.state,reason:m.reason}))})),null,2));
