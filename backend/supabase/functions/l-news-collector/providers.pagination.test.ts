import {searchPerigon} from './providers.ts';
Deno.test('Perigon page 4 is a provider pagination ceiling, not an exhausted run quota',async()=>{
 let reserved=0;
 const run={
  id:'test-run',from_at:'2026-11-25T10:00:00Z',to_at:'2026-11-25T12:00:00Z',
  settings:{perigon_per_run:8,perigon_reserve:10},warnings:[],counters:{},status:'processing',number:9,
 };
 const job={
  id:1,run_id:'test-run',kind:'perigon',
  payload:{layer:'name',page:3,quota:{requestsUsed:29,requestLimit:150,maxPageSize:100,paginationLimit:300}},
  attempts:1,
 };
 const rt={
  db:{rpc:()=>{reserved++;throw Error('Unexpected quota reservation');}},
  perigonKey:'unused',newscatcherKey:'',secret:()=>'', 
 };
 const result=await searchPerigon(rt as never,job,run as never);
 if(result.capped||result.next||result.candidates.length)throw Error('Unexpected fourth Perigon page');
 if(!('warnings' in result)||!result.warnings?.some((value:string)=>value.includes('300 результатов')))throw Error('Pagination warning missing');
 if(reserved!==0)throw Error('Fourth page reserved API quota');
});
