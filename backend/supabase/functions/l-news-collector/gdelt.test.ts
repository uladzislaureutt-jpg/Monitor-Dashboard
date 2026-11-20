import { probeGdelt, retryAfterAt, searchGdelt } from './gdelt.ts';
import type { Job, Run, Runtime } from './providers.ts';

const from='2026-11-18T19:23:00Z',to='2026-11-19T21:23:00Z';
const run={id:'test-run',from_at:from,to_at:to,settings:{gdelt_per_run:4}} as Run;

function equal(actual:unknown,expected:unknown){
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

Deno.test('Retry-After supports seconds and HTTP-date',()=>{
 const now=Date.parse('2026-11-20T12:00:00Z');
 equal(retryAfterAt('120',now),'2026-11-20T12:02:00.000Z');
 equal(retryAfterAt('Fri, 20 Nov 2026 13:00:00 GMT',now),'2026-11-20T13:00:00.000Z');
 equal(retryAfterAt(null,now),null);
 equal(retryAfterAt('unknown',now),null);
});

Deno.test('the diagnostic captures 429 evidence and the blocked search performs no second fetch',async()=>{
 const fetchOriginal=globalThis.fetch;
 const until='2026-11-20T12:07:00+00:00';
 let calls=0;
 const states:Record<string,unknown>[]=[];
 const rt={db:{rpc(name:string,args:Record<string,unknown>){
  if(name==='l_news_reserve_gdelt'){
   if(args.p_endpoint==='doc_probe')return {data:{usage_id:42}};
   return {data:{blocked_until:until}};
  }
  if(name==='l_news_finish_gdelt'){states.push(args);return {data:until};}
  throw new Error(name);
 }}} as Runtime;
 globalThis.fetch=((input:string,options:RequestInit)=>{
  calls++;
  equal(options.redirect,'error');
  equal(new URL(input).searchParams.get('startdatetime'),'20261118192300');
  return Promise.resolve(new Response('Please limit requests to one every 5 seconds.',{
   status:429,headers:{'content-type':'text/plain','retry-after':'120'},
  }));
 }) as typeof fetch;
 try{
  const probe=await probeGdelt(rt,{id:1,payload:{from,to}} as Job);
  equal(probe,{status:429,returned:0,content_type:'text/plain',retry_after:'120',
   body_excerpt:'Please limit requests to one every 5 seconds.',transport_error:null,valid_articles:false,blocked_until:until});
  equal(states.length,1);
  equal(states[0].p_status,429);
  const skipped=await searchGdelt(rt,{id:2,payload:{}} as Job,run);
  equal('warnings' in skipped&&skipped.warnings[0].includes('HTTP 429'),true);
  equal(calls,1);
 }finally{globalThis.fetch=fetchOriginal;}
});
