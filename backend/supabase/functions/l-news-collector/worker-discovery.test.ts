import {workOne} from './worker.ts';
import {discoveryJobKey} from './discovery.ts';
import type {Job,Run,Runtime} from './providers.ts';
const equal=(a:unknown,b:unknown)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);};
const base={id:'r',assistant_id:2,status:'processing',from_at:'2026-11-25T00:00:00Z',to_at:'2026-11-26T02:00:00Z',settings:{countries:['DE','PL','RU'],candidate_limit:1200,thenews_per_run:70,thenews_pages_per_query:8}} as Run;

function fixture(run:Run,sources:any[]=[],initialJobs=1){
 const scheduled:any[]=[],records:any[]=[];
 const rt={secret:()=> 'fixture',db:{rpc:(name:string)=>({data:name.includes('rate_slot')?0:17}),from:(table:string)=>{
  let patch:any;
  const query:any={select:()=>query,eq:()=>query,order:()=>query,
   single:()=>({data:run}),range:()=>({data:sources}),
   update:(value:any)=>{patch=value;return query;},
   upsert:(value:any)=>{if(!scheduled.some(row=>row.dedupe_key===value.dedupe_key))scheduled.push(value);return {data:null};},
   then:(resolve:any)=>{if(patch)records.push(patch);resolve({data:[],count:table==='l_news_jobs'?initialJobs+scheduled.length:0});},
  };return query;
 }}} as Runtime;
 return {rt,scheduled,records};
}

Deno.test('worker retrieves all 16 The News hits across six pages after unproductive early pages',async()=>{
 const original=globalThis.fetch,requested:number[]=[],f=fixture(base);
 const root={group:20,domains:['catalog.test'],page:1};
 const queue:any[]=[root];
 globalThis.fetch=async url=>{const page=Number(new URL(String(url)).searchParams.get('page'));requested.push(page);
  return Response.json({meta:{found:16,limit:3},data:Array.from({length:page===6?1:3},(_,i)=>({uuid:`${page}-${i}`,url:`https://outside-catalog.test/${page}/${i}`,title:'Lukashenko'}))});};
 try{
  for(let i=0;i<queue.length;i++){
   const before=f.scheduled.length;
   const result=await workOne(f.rt,{id:i+1,kind:'thenews',run_id:'r',payload:queue[i]} as Job);
   equal(result.new_to_index,0);
   queue.push(...f.scheduled.slice(before).map(row=>row.payload));
  }
  equal(requested,[1,2,3,4,5,6]);equal(f.records.length,6);
  equal(f.scheduled.every(row=>row.dedupe_key===discoveryJobKey('r','thenews',row.payload)),true);
 }finally{globalThis.fetch=original;}
});

Deno.test('worker replaces oversized parent paging with every disjoint child group when budget allows',async()=>{
 const original=globalThis.fetch;
 const sources=Array.from({length:40},(_,i)=>({domain:`s${i}.test`,country:i<20?'RU':i<30?'DE':'PL'}));
 const f=fixture(base,sources),payload={group:0,domains:sources.map(s=>s.domain),page:1};
 globalThis.fetch=async()=>Response.json({meta:{found:100,limit:3},data:Array.from({length:3},(_,i)=>({uuid:String(i),url:'https://outside-catalog.test/'+i,title:'Lukashenko'}))});
 try{
  const result=await workOne(f.rt,{id:1,kind:'thenews',run_id:'r',payload} as Job);
  equal(result.split,true);equal(f.scheduled.length,4);
  equal(f.scheduled.every(row=>row.payload.page===1&&row.payload.domains.length===10),true);
  equal(f.scheduled[0].payload.domains[0],'s20.test');
  equal(f.scheduled.flatMap(row=>row.payload.domains).sort(),payload.domains.sort());
 }finally{globalThis.fetch=original;}
});

Deno.test('worker keeps parent coverage when all split children cannot fit, then stops at the run ceiling',async()=>{
 const original=globalThis.fetch;
 const sources=Array.from({length:40},(_,i)=>({domain:`s${i}.test`,country:'DE'}));
 const run={...base,settings:{...base.settings,thenews_per_run:2}},f=fixture(run,sources);
 globalThis.fetch=async()=>Response.json({meta:{found:100,limit:3},data:Array.from({length:3},(_,i)=>({uuid:String(i),url:'https://outside-catalog.test/'+i,title:'Lukashenko'}))});
 try{
  const payload={group:0,domains:sources.map(s=>s.domain),page:1};
  equal((await workOne(f.rt,{id:1,kind:'thenews',run_id:'r',payload} as Job)).split,false);
  equal(f.scheduled.length,1);equal(f.scheduled[0].payload.page,2);equal(f.scheduled[0].payload.domains,payload.domains);
  await workOne(f.rt,{id:2,kind:'thenews',run_id:'r',payload:f.scheduled[0].payload} as Job);
  equal(f.scheduled.length,1);
 }finally{globalThis.fetch=original;}
});
