import {COUNTRY_NAMES,VERSION} from './core.ts';
import {Runtime,must,readPages} from './providers.ts';
import {groupStoryCards} from './story.ts';

export async function bundleForRun(rt:Runtime,id:string){
 const run=must(await rt.db.from('l_news_runs').select('*').eq('id',id).single());
 const links=await readPages<{role:string;item_id:string}>(rt.db.from('l_news_run_items').select('role,item_id').eq('run_id',id).order('item_id'));
 const ids=links.map(link=>link.item_id);const rows:any[]=[];
 for(let i=0;i<ids.length;i+=150)rows.push(...must(await rt.db.from('l_news_items').select('*').in('id',ids.slice(i,i+150))));
 const upgrade=new Set(links.filter((r:any)=>r.role==='upgrade').map((r:any)=>r.item_id));
 const ready=rows.filter(r=>r.state==='ready'&&(r.ready_run_id===id||upgrade.has(r.id))&&r.card);
 // Reconcile formerly imported cards even if publisher-edition merge detached
 // their run links. The desktop importer will withdraw old duplicates safely.
 const revoked=await readPages<{document_uid:string}>(rt.db.from('l_news_items').select('document_uid').eq('ready_run_id',id).eq('state','rejected').order('document_uid'));
 const withdrawn=[...new Set(revoked.map(row=>row.document_uid))];
 const observed=new Set(rows.map(row=>row.source_domain));
 const catalog=await readPages<{
  domain:string;enabled?:boolean;country:string;name:string;source_type:string;priority:string;coverage:unknown
 }>(rt.db.from('l_news_sources').select('*').order('domain'));
 const sources=catalog.filter(source=>observed.has(source.domain)||
  (source.enabled!==false&&(!run.settings.countries||run.settings.countries.includes(source.country))));
 const source_metrics=sources.map((s:any)=>{
  const candidates=rows.filter(r=>r.source_domain===s.domain),included=ready.filter(r=>r.source_domain===s.domain);
  return {schema_version:'0.3',monitor_key:'lukashenko',source:s.name,domain:s.domain,source_type:s.source_type,source_region:COUNTRY_NAMES[s.country]||s.country,source_locality:null,priority:s.priority,
   selected_candidates:candidates.length,processed:candidates.filter(r=>r.state!=='pending').length,fetch_ok:null,relevance_passed:included.length,relevance_rejected:candidates.filter(r=>r.state==='rejected').length,included:included.length,results:included.length,
   access_status:included.some(r=>r.content_level==='FULL_TEXT')?'api_full_text':included.length?'api_public_preview':'api_no_thematic_result',admission_status:included.length?'included':'no_result',pipeline_kind:'api_topic_only',provider_coverage:s.coverage};
 });
 return {manifest:{dashboard_contract_version:'0.3',monitor:{key:'lukashenko',display_name:'L-Monitor'},run:{run_number:null,github_run_id:null,github_sha:null,collector:'api_assistant',collector_run_id:id,assistant_id:run.assistant_id??1,collector_number:run.assistant_number??run.number,started_at:run.to_at,lookback_hours:run.settings.lookback_hours,dry_run:false},
   files:{publications:'publications.jsonl',source_metrics:'source_metrics.jsonl',run_metrics:'run_metrics.json',entities:null,full_texts:'full_texts.jsonl'},capabilities:{source_country_geography:true,full_text_integrity:true,collector:VERSION}},
  publications:groupStoryCards(ready.map(r=>r.card)),source_metrics,run_metrics:{schema_version:'0.3',monitor_key:'lukashenko',run_number:null,dry_run:false,final_publications:ready.length,collector:'api_assistant',collector_run_id:id,status:run.status,...run.counters,withdrawn_document_ids:withdrawn},
  full_texts:ready.filter(r=>r.full_text).map(r=>r.full_text),entities:[],revision:run.revision};
}
