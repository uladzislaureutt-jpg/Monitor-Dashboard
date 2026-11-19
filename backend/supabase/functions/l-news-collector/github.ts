import {unzipSync,strFromU8} from 'npm:fflate@0.8.2';
import {urlKey} from './core.ts';
import {Runtime,must,saveState} from './providers.ts';

export function githubPublications(bytes:Uint8Array){
 const outer=unzipSync(bytes,{filter:file=>file.originalSize<12000000&&(/(^|\/)publications\.jsonl$/.test(file.name)||/dashboard.*\.zip$/i.test(file.name))});
 let file=Object.entries(outer).find(([name])=>/(^|\/)publications\.jsonl$/.test(name))?.[1];
 if(!file){const nested=Object.entries(outer).filter(([name])=>/dashboard.*\.zip$/i.test(name));if(nested.length!==1)throw new Error('ambiguous_bundle_wrapper');
  const files=unzipSync(nested[0][1],{filter:f=>/(^|\/)publications\.jsonl$/.test(f.name)&&f.originalSize<8000000});file=Object.values(files)[0];}
 if(!file)throw new Error('publications_missing');
 return strFromU8(file).split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
export async function registerKnown(rt:Runtime,rows:any[],origin='github_client'){
 const safe=[];for(const row of rows.slice(0,1000)){try{
  const url=urlKey(String(row.url||row.canonical_url||''));const uid=String(row.document_uid||row.document_id||'');
  if(!uid||uid.length>160)continue;
  safe.push({canonical_url:url,document_uid:uid,origin,content_level:String(row.content_level||'METADATA').slice(0,24),aliases:[],observed_at:new Date().toISOString()});
 }catch{/* skip malformed URL */}}
 if(!safe.length)return 0;
 // Preserve the identity first recorded centrally; all raw GitHub identities are
 // also mapped by canonical URL in the local importer.
 const unique=[...new Map(safe.map(r=>[r.canonical_url,r])).values()];
 const existing=must(await rt.db.from('l_news_known_urls').select('canonical_url,document_uid').in('canonical_url',unique.map(r=>r.canonical_url)));
 const map=new Map(existing.map((x:any)=>[x.canonical_url,x.document_uid]));
 must(await rt.db.from('l_news_known_urls').upsert(unique.map(r=>({...r,document_uid:map.get(r.canonical_url)||r.document_uid})),{onConflict:'canonical_url'}));return unique.length;
}
export async function indexGithub(rt:Runtime){
 const token=rt.secret('GITHUB_L_MONITOR_TOKEN');if(!token)return {warnings:['GitHub-индекс: ключ недоступен'],indexed:0};
 const headers={authorization:'Bearer '+token,accept:'application/vnd.github+json','user-agent':'Monitor-L-News-Pilot'};
 const previous=must(await rt.db.from('l_news_provider_state').select('info').eq('provider','github_index').maybeSingle())?.info||{};
 const seen=new Set<number>(previous.artifacts||[]);
 const response=await fetch('https://api.github.com/repos/vladreuth-cmd/M-Trouble/actions/artifacts?per_page=100',{headers,signal:AbortSignal.timeout(15000)});
 if(!response.ok)return {warnings:['GitHub-индекс: HTTP '+response.status],indexed:0};
 const list=(await response.json()).artifacts||[];
 const artifacts=list.filter((a:any)=>!a.expired&&/^dashboard-bundle-l-monitor-\d+$/.test(a.name)).sort((a:any,b:any)=>b.id-a.id).slice(0,3);
 let indexed=0;const warnings=[];
 for(const a of artifacts){if(seen.has(a.id))continue;try{
  if(a.size_in_bytes>12000000)throw new Error('archive_size_limit');
  const r=await fetch(a.archive_download_url,{headers,signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error('download_'+r.status);
  const bytes=new Uint8Array(await r.arrayBuffer());if(bytes.length>12000000)throw new Error('archive_size_limit');
  const rows=githubPublications(bytes);
  if(rows.some(r=>r.monitor_key!=='lukashenko'))throw new Error('unexpected_monitor');
  for(let i=0;i<rows.length;i+=200)indexed+=await registerKnown(rt,rows.slice(i,i+200).map(r=>({url:r.publication.url,document_id:r.document_id,content_level:r.provenance?.content_level||'METADATA'})),'github_bundle');
  seen.add(a.id);
 }catch(error){warnings.push('GitHub-индекс: '+a.name+' ('+(error instanceof Error?error.message.slice(0,100):'error')+')');}}
 await saveState(rt,'github_index',{artifacts:[...seen].slice(-200),indexed_last:indexed});return {indexed,warnings};
}
