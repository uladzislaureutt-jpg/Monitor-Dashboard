import {continueDiscovery,currentsPlans,searchCurrents,searchTheNews,thenewsPlans,thenewsSplitPlans,discoveryJobKey,CURRENTS_TERMS} from './discovery.ts';
import {containsName} from './core.ts';
import type {Job,Run,Runtime} from './providers.ts';
const equal=(a:unknown,b:unknown)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);};
const run={id:'r',assistant_id:2,assistant_number:1,from_at:'2026-11-25T00:00:00+00:00',to_at:'2026-11-26T02:00:00+00:00',settings:{countries:['CN','IN','JP','DE'],currents_languages:['en','zh','hi','ja','de','fr'],currents_per_run:64,currents_pages_per_query:5,thenews_per_run:40,thenews_pages_per_query:3}} as Run;
Deno.test('multilingual discovery covers matching scripts and keeps manual country scope',()=>{
 equal([...new Set(currentsPlans(run).map(p=>p.language))],['en','zh','hi','ja','de']);
 equal([...new Set(currentsPlans({...run,settings:{...run.settings,countries:['JP']}}).map(p=>p.language))],['en','ja']);
 for(const name of ['루카셴코','लुकाशेंको','لوکاشینکو','Lukasjenko'])equal(containsName(name),true);
});
Deno.test('The News batches the whole catalog and rotates when the budget cannot cover every group',()=>{
 const sources=Array.from({length:105},(_,i)=>({domain:`s${i}.test`})) as any;
 equal(thenewsPlans(run,sources).map(p=>p.domains.length),[40,40,25]);
 const one={...run,settings:{...run.settings,thenews_per_run:1}};
 equal(thenewsPlans(one,sources)[0].domains[0],'s0.test');
 equal(thenewsPlans({...one,assistant_number:2},sources)[0].domains[0],'s40.test');
 equal(thenewsPlans({...one,assistant_number:3},sources)[0].domains[0],'s80.test');
});
Deno.test('The News reaches the tail after known pages while both providers obey finite page limits',()=>{
 equal(continueDiscovery('currents',1,5,true,0),true);equal(continueDiscovery('currents',2,5,true,0),false);
 equal(continueDiscovery('currents',2,5,true,1),true);equal(continueDiscovery('currents',5,5,true,5),false);
 equal(continueDiscovery('thenews',2,8,true,0),true);equal(continueDiscovery('thenews',5,8,true,0),true);
 equal(continueDiscovery('thenews',8,8,true,1),false);equal(continueDiscovery('thenews',1,8,false,0),false);
});
Deno.test('provider requests use local spellings, valid UTC dates and daily headers without leaking credentials',async()=>{
 const original=globalThis.fetch;const states:any[]=[];const records:any[]=[];const urls:URL[]=[];
 const rt={secret:()=> 'fixture-secret',db:{rpc:(name:string)=>({data:name.includes('rate_slot')?0:17}),from:()=>({update:(v:any)=>({eq:()=>{records.push(v);return {data:null};}}),upsert:(v:any)=>{states.push(v);return {data:null};}})}} as Runtime;
 globalThis.fetch=async url=>{const u=new URL(String(url));urls.push(u);return u.hostname.includes('currents')?Response.json({news:[{title:'卢卡申科',url:'https://test.cn/a',published:'2026-11-25T12:00:00Z'}]},{headers:{'x-ratelimit-remaining':'229','x-ratelimit-limit':'250','x-ratelimit-reset-time':'2026-11-27T00:00:00Z'}}):Response.json({meta:{found:8,limit:3},data:Array.from({length:3},(_,i)=>({uuid:'u'+i,title:'Lukashenko',url:'https://test.de/'+i,published_at:'2026-11-25T12:00:00Z'}))},{headers:{'x-usagelimit-remaining':'81','x-usagelimit-limit':'100'}});};
 try{
 const a=await searchCurrents(rt,{id:1,payload:{language:'zh',page:1}} as Job,run);
 const b=await searchTheNews(rt,{id:2,payload:{group:0,domains:['test.de'],page:1}} as Job,run);
 equal(urls[0].searchParams.has('query'),false);equal(urls[0].searchParams.get('keywords'),'卢卡申科');equal(a.type,1);
 equal(urls[1].searchParams.get('published_after'),'2026-11-25T00:00:00');equal(urls[1].searchParams.get('domains'),'test.de');
 equal(urls[1].searchParams.get('search')!.includes(' | '),true);equal(b.next,true);equal(a.candidates[0].provider,'currents');
 equal(states.map(s=>[s.provider,s.info.limits.remaining]),[['currents',229],['thenews',81]]);
 equal(records.map(r=>r.credits),[1,1]);equal(JSON.stringify(records).includes('fixture-secret'),false);
 }finally{globalThis.fetch=original;}
});
Deno.test('independent spellings and articles share the run budget with collision-free page keys',()=>{
 const scoped={...run,settings:{...run.settings,countries:['PL','QA','LT'],currents_languages:['en','pl','ar','lt'],currents_per_run:120}};
 const plans=currentsPlans(scoped),keys=plans.map(plan=>discoveryJobKey(run.id,'currents',plan));
 equal(new Set(keys).size,plans.length);
 for(const language of ['en','pl','ar','lt'])equal(plans.filter(plan=>plan.type===1&&plan.language===language).length,CURRENTS_TERMS[language].length);
 equal(plans.some(plan=>plan.type===2&&plan.language==='pl'),true);
 equal(plans.some(plan=>plan.type===2&&plan.language==='ar'),false);
 for(const name of ['Łukaszenko','لوكاشنكو','Lukašenką'])equal(containsName(name),true);
 equal(currentsPlans({...scoped,settings:{...scoped.settings,currents_per_run:3}}).length,3);
 equal(currentsPlans({...scoped,settings:{...scoped.settings,currents_per_run:0}}),[]);
 const en=plans.find(plan=>plan.type===1&&plan.language==='en')!;
 equal(discoveryJobKey(run.id,'currents',en)===discoveryJobKey(run.id,'currents',{...en,type:2}),false);
 equal(discoveryJobKey(run.id,'currents',en)===discoveryJobKey(run.id,'currents',{...en,page:2}),false);
});
Deno.test('only oversized The News groups split; small 16-hit groups retain complete paging',()=>{
 const sources=Array.from({length:40},(_,i)=>({domain:`s${i}.test`,country:i<20?'RU':i<30?'DE':'PL'})) as any;
 const plan={group:20,domains:sources.map((s:any)=>s.domain),page:1};
 const found={page:1,page_size:3,total_hits:16,max_pages:8};
 equal(thenewsSplitPlans(run,plan,found,sources),[]);
 const parts=thenewsSplitPlans(run,plan,{...found,total_hits:100},sources);
 equal(parts.map(p=>p.domains.length),[10,10,10,10]);equal(parts[0].domains[0],'s20.test');
 equal(parts[1].domains[0],'s30.test');
 equal([...parts.flatMap(p=>p.domains)].sort(),[...plan.domains].sort());
 equal(parts.every(p=>new Set(p.domains.map(d=>sources.find((s:any)=>s.domain===d).country)).size===1),true);
 equal(new Set(parts.map(p=>discoveryJobKey(run.id,'thenews',p))).size,parts.length);
 equal(thenewsSplitPlans(run,{...plan,page:2},{...found,page:2,total_hits:100},sources),[]);
});
Deno.test('a prolific single source gets bounded time windows inside the original collection',()=>{
 const plan={group:0,domains:['test.de'],page:1};
 const found={page:1,page_size:3,total_hits:100,max_pages:8};
 const parts=thenewsSplitPlans(run,plan,found,[]);
 equal(parts.length,2);equal(parts[0].from_at,new Date(run.from_at).toISOString());equal(parts[1].to_at,new Date(run.to_at).toISOString());
 equal(parts[0].to_at,parts[1].from_at);equal(parts.map(p=>p.time_depth),[1,1]);
 equal(thenewsSplitPlans(run,{...parts[0],time_depth:2},found,[]),[]);
 equal(discoveryJobKey(run.id,'thenews',parts[0])===discoveryJobKey(run.id,'thenews',parts[1]),false);
});
Deno.test('articles and explicit local alternatives are searched even when the primary response has hits',async()=>{
 const original=globalThis.fetch,urls:URL[]=[],records:any[]=[];
 const rt={secret:()=> 'fixture-secret',db:{rpc:(name:string)=>({data:name.includes('rate_slot')?0:17}),from:()=>({update:(v:any)=>({eq:()=>{records.push(v);return {data:null};}})})}} as Runtime;
 globalThis.fetch=async url=>{urls.push(new URL(String(url)));return Response.json({news:[{id:'same-id',title:'Łukaszenko',url:'https://test.pl/a'}]});};
 try{
  for(const payload of [{language:'en',type:1,variant:0},{language:'en',type:1,variant:1},{language:'pl',type:2,variant:1}])await searchCurrents(rt,{id:1,payload} as Job,run);
  equal(urls.map(u=>[u.searchParams.get('keywords'),u.searchParams.get('type')]),[['Lukashenko','1'],['Lukashenka','1'],['Łukaszenko','2']]);
  equal(records.map(r=>r.details.type),[1,1,2]);equal(records.every(r=>r.credits===1),true);
 }finally{globalThis.fetch=original;}
});
Deno.test('invalid content classes and expanded time windows cannot reserve a paid request',async()=>{
 let reservations=0;const rt={secret:()=> 'fixture-secret',db:{rpc:()=>{reservations++;return {data:17};}}} as Runtime;
 for(const [provider,payload] of [['currents',{language:'en',type:3}],['currents',{language:'xx'}],['thenews',{domains:['test.de'],from_at:'2026-11-24T00:00:00Z'}]] as const){
  let failed=false;try{await (provider==='currents'?searchCurrents:searchTheNews)(rt,{id:1,payload} as Job,run);}catch{failed=true;}equal(failed,true);
 }
 equal(reservations,0);
});
Deno.test('zero budget makes no billable request, and unknown outcomes retain their one-request charge',async()=>{
 const original=globalThis.fetch;let calls=0;const records:any[]=[];
 const rt={secret:()=> 'fixture-secret',db:{rpc:(name:string)=>({data:name.includes('rate_slot')?0:null}),from:()=>({update:(v:any)=>({eq:()=>{records.push(v);return {data:null};}})})}} as Runtime;
 globalThis.fetch=async()=>{calls++;throw new Error('transport');};
 try{const job={id:1,payload:{domains:['test.de']}} as Job;
 equal((await searchTheNews(rt,job,run)).capped,true);equal(calls,0);
 rt.db.rpc=(name:string)=>({data:name.includes('rate_slot')?0:17});
 let error='';try{await searchTheNews(rt,job,run);}catch(e){error=String(e);}
 equal(error.includes('thenews_search_0'),true);equal(records[0].credits,1);equal(calls,1);
 }finally{globalThis.fetch=original;}
});
