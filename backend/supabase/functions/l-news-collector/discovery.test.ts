import {continueDiscovery,currentsPlans,searchCurrents,searchTheNews,thenewsPlans} from './discovery.ts';
import {containsName} from './core.ts';
import type {Job,Run,Runtime} from './providers.ts';
const equal=(a:unknown,b:unknown)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);};
const run={id:'r',assistant_id:2,assistant_number:1,from_at:'2026-11-25T00:00:00+00:00',to_at:'2026-11-26T02:00:00+00:00',settings:{countries:['CN','IN','JP','DE'],currents_languages:['en','zh','hi','ja','de','fr'],currents_per_run:64,currents_pages_per_query:5,thenews_per_run:40,thenews_pages_per_query:3}} as Run;
Deno.test('multilingual discovery covers matching scripts and keeps manual country scope',()=>{
 equal(currentsPlans(run).map(p=>p.language),['en','zh','hi','ja','de']);
 equal(currentsPlans({...run,settings:{...run.settings,countries:['JP']}}).map(p=>p.language),['en','ja']);
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
Deno.test('pagination checks below known first-page headlines, then requires productive directions',()=>{
 equal(continueDiscovery(1,5,true,0),true);equal(continueDiscovery(2,5,true,0),false);
 equal(continueDiscovery(2,5,true,1),true);equal(continueDiscovery(5,5,true,5),false);equal(continueDiscovery(1,5,false,2),false);
});
Deno.test('provider requests use local spellings, valid UTC dates and daily headers without leaking credentials',async()=>{
 const original=globalThis.fetch;const states:any[]=[];const records:any[]=[];const urls:URL[]=[];
 const rt={secret:()=> 'fixture-secret',db:{rpc:(name:string)=>({data:name.includes('rate_slot')?0:17}),from:()=>({update:(v:any)=>({eq:()=>{records.push(v);return {data:null};}}),upsert:(v:any)=>{states.push(v);return {data:null};}})}} as Runtime;
 globalThis.fetch=async url=>{const u=new URL(String(url));urls.push(u);return u.hostname.includes('currents')?Response.json({news:[{title:'卢卡申科',url:'https://test.cn/a',published:'2026-11-25T12:00:00Z'}]},{headers:{'x-ratelimit-remaining':'229','x-ratelimit-limit':'250','x-ratelimit-reset-time':'2026-11-27T00:00:00Z'}}):Response.json({meta:{found:8,limit:3},data:Array.from({length:3},(_,i)=>({uuid:'u'+i,title:'Lukashenko',url:'https://test.de/'+i,published_at:'2026-11-25T12:00:00Z'}))},{headers:{'x-usagelimit-remaining':'81','x-usagelimit-limit':'100'}});};
 try{
 const a=await searchCurrents(rt,{id:1,payload:{language:'zh',page:1}} as Job,run);
 const b=await searchTheNews(rt,{id:2,payload:{group:0,domains:['test.de'],page:1}} as Job,run);
 equal(urls[0].searchParams.has('query'),false);equal(urls[0].searchParams.get('keywords'),'卢卡申科');equal(a.next_variant,1);
 equal(urls[1].searchParams.get('published_after'),'2026-11-25T00:00:00');equal(urls[1].searchParams.get('domains'),'test.de');
 equal(urls[1].searchParams.get('search')!.includes(' | '),true);equal(b.next,true);equal(a.candidates[0].provider,'currents');
 equal(states.map(s=>[s.provider,s.info.limits.remaining]),[['currents',229],['thenews',81]]);
 equal(records.map(r=>r.credits),[1,1]);equal(JSON.stringify(records).includes('fixture-secret'),false);
 }finally{globalThis.fetch=original;}
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
