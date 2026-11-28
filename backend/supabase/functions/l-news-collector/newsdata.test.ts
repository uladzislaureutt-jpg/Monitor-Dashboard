import {newsdataWindow,newsdataQueries,newsdataCandidate,newsdataHeaders,validateNewsdataSettings,searchNewsdata} from './newsdata.ts';
import {extractPage} from './extraction.ts';
import {NAMES,publisherArticleKey} from './core.ts';
import type {Runtime,Run,Job} from './providers.ts';
const equal=(a:unknown,b:unknown)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);};
Deno.test('12:17 Minsk collects 26 matured hours and includes the whole previous calendar day',()=>{
 equal(newsdataWindow('2026-11-28T09:17:49Z'),{from:'2026-11-26T19:16:00.000Z',to:'2026-11-27T21:16:00.000Z'});
 const w=newsdataWindow('2026-11-28T09:17:49Z',48);equal(Date.parse(w.to)-Date.parse(w.from),48*3600000);
});
Deno.test('all local surnames fit the NewsData free query limit',()=>{
 const q=newsdataQueries();equal(q.length,15);equal(q.every(p=>p.q.length<=100),true);
 for(const term of NAMES)equal(q.some(p=>p.q.split(' OR ').includes(term)),true);
});
Deno.test('NewsData never treats paid-plan notices or discovery time as publication content/date',()=>{
 const c=newsdataCandidate({id:'x',title:'Lukashenko',content:'ONLY AVAILABLE IN PAID PLANS',fetched_at:'2026-11-28T12:17:00Z',meta_description:'lead'});
 equal(c.body,'');equal(c.published_at,null);equal(c.lead,'lead');
 equal(newsdataCandidate({published_at:'2026-11-27T11:00:00Z'}).published_at,'2026-11-27T11:00:00Z');
 equal(newsdataHeaders(new Headers({'x-api-limit-remaining':'145','x-ratelimit-remaining':'0'})).rate_remaining,0);
});
Deno.test('NewsData settings validate independent time, hard budgets and country scope',()=>{
 const patch=validateNewsdataSettings({enabled:false,local_time:'12:17',newsdata_per_run:80,newsdata_reserve:40,countries:['PL','DE','PL']},['PL','DE']);equal(patch.countries,['PL','DE']);equal(patch.enabled,false);
 for(const bad of [{local_time:'24:17'},{newsdata_daily_credits:201},{newsdata_per_run:-1},{countries:[]},{countries:['XX']},{enabled:1}]){let failed=false;try{validateNewsdataSettings(bad,['PL']);}catch{failed=true;}equal(failed,true);}
});
Deno.test('short article text wins over a long recommendation feed, with its original date',()=>{
 const main='President of Belarus Aleksandr Lukashenko is scheduled to pay an official visit to Vietnam from December 1 to 3.';
 const page=extractPage(`<head><meta property="og:type" content="article"><meta property="article:published_time" content="2026-11-27T14:29:41+07:00"></head><article><div class="article__body">${main}</div><div class="related">${'Unrelated recommended story. '.repeat(300)}</div></article>`,'https://en.vietnamplus.vn/story.vnp');
 equal(page.body,main);equal(page.published,'2026-11-27T14:29:41+07:00');
 const structured=extractPage(`<script type="application/ld+json">${JSON.stringify({'@type':'NewsArticle',articleBody:main,datePublished:'2026-11-27T07:29:41Z'})}</script><article>${'An unrelated feed. '.repeat(400)}</article>`,'https://example.com/news');equal(structured.body,main);
});
Deno.test('CNN international, main and lite article copies share one stable publication identity',()=>{
 const path='/2026/11/27/world/putin-lukashenko-ukraine-russia-mongolia-intl';
 const keys=['cnn.com','edition.cnn.com','lite.cnn.com'].map(h=>publisherArticleKey('https://'+h+path));equal(new Set(keys).size,1);equal(keys[0]!==null,true);
 equal(publisherArticleKey('https://cnn.com'+path+'-another')===keys[0],false);
});
Deno.test('NewsData freezes publication dates, settles one request and retains cursor paging without logging credentials',async()=>{
 const original=globalThis.fetch;let sent:URL|undefined;const calls:any[]=[];
 const rt={secret:()=> 'fixture-key',db:{from:()=>({select(){return this;},eq(){return this;},maybeSingle:()=>({data:null})}),rpc:(name:string,args:any)=>{calls.push({name,args});return {data:name==='l_news_reserve_newsdata_call'?77:null};}}} as Runtime;
 globalThis.fetch=async input=>{sent=new URL(String(input));return Response.json({status:'success',results:[{id:'one',title:'Lukashenko',url:'https://example.com/news',published_at:'2026-11-27T10:00:00Z',content:'ONLY AVAILABLE IN PAID PLANS'}],total_results:11,next_page:'cursor_2'},{headers:{'x-api-limit-remaining':'144','x-ratelimit-limit':'60','x-ratelimit-remaining':'56'}});};
 try{const result=await searchNewsdata(rt,{id:1,payload:{query_index:0,page:1}} as Job,{id:'r',from_at:'2026-11-26T19:16:00+00:00',to_at:'2026-11-27T21:16:00+00:00'} as Run);
  equal(sent?.searchParams.get('from_date'),'2026-11-26 19:16:00');equal(sent?.searchParams.get('to_date'),'2026-11-27 21:16:00');equal(result.next_cursor,'cursor_2');equal(result.candidates?.[0].body,'');equal(calls[1].args.p_credits,1);equal(JSON.stringify(calls).includes('fixture-key'),false);
 }finally{globalThis.fetch=original;}
});

Deno.test('a transport failure remains unconfirmed while the budget reserves it conservatively',async()=>{
 const original=globalThis.fetch;const calls:any[]=[];
 const rt={secret:()=> 'fixture-key',db:{from:()=>({select(){return this;},eq(){return this;},maybeSingle:()=>({data:null})}),rpc:(name:string,args:any)=>{calls.push({name,args});return {data:name==='l_news_reserve_newsdata_call'?77:null};}}} as Runtime;
 globalThis.fetch=async()=>{throw Error('transport');};
 try{let failed=false;try{await searchNewsdata(rt,{id:1,payload:{query_index:0}} as Job,{id:'r',from_at:'2026-11-26T19:16:00Z',to_at:'2026-11-27T21:16:00Z'} as Run);}catch{failed=true;}equal(failed,true);equal(calls[1].args.p_status,0);equal(calls[1].args.p_credits,null);}finally{globalThis.fetch=original;}
});

Deno.test('NewsData alternate sections of Digi24 and Teraz keep the publisher article ID',()=>{
 equal(publisherArticleKey('https://www.digi24.ro/stiri/externe/sua/old-title-4055267'),publisherArticleKey('https://m.digi24.ro/stiri/externe/ue/updated-title-4055267'));
 equal(publisherArticleKey('https://teraz.sk/zahranicie/old/1010868-clanok.html'),publisherArticleKey('https://teraz.sk/najnovsie/new/1010868-clanok.html'));
 equal(publisherArticleKey('https://digi24.ro/stiri/other-4055268')===publisherArticleKey('https://digi24.ro/stiri/first-4055267'),false);
});
