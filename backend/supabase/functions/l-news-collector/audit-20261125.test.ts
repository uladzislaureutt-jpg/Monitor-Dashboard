import {publisherArticleKey,relevant,samePublisherHeadlineKey} from './core.ts';
const eq=(a:unknown,b:unknown)=>{if(a!==b)throw Error(String(a)+' != '+String(b));};
Deno.test('publisher-edition identities',()=>{
 const pairs=[
 ['https://fakti.bg/world/1104317-abc','https://fakti.bg/en/world/1104317-def'],
 ['https://novosti.rs/planeta/svet/1674395/abc','https://novosti.rs/c/planeta/svet/1674395/abc'],
 ['https://klaipeda.diena.lt/naujienos/some-title-1784534','https://vilniaus.diena.lt/naujienos/some-title-1784534'],
 ['https://censor.net/en/news/4035452/abc','https://censor.net/ru/news/4035452/def'],
 ['https://ca.news.yahoo.com/same-222744513.html','https://sg.news.yahoo.com/same-222744513.html'],
 ['https://mobile.reuters.com/world/same-story-2026-11-24','https://uk.mobile.reuters.com/world/same-story-2026-11-24'],
 ];
 for(const [a,b] of pairs){const k=publisherArticleKey(a);if(!k)throw Error('missing '+a);eq(k,publisherArticleKey(b));}
 eq(publisherArticleKey('https://sport.pravda.com.ua/articles/2026/11/20/8063865'),null);
});
Deno.test('off-topic sidebars and roundups are excluded',()=>{
 const c={url:'https://x.example/a',title:'',lead:'',body:'',published_at:null,language:'en',country:'GB',domain:'x.example',provider:'fixture',provider_id:'1'};
 eq(relevant({...c,title:'Réveil Courrier du 25 novembre',body:'Alexander Lukashenko said something.'}).pass,false);
 eq(relevant({...c,title:'German army expands drones',body:'Още: Зеленски отговори на предложението на Лукашенко.'}).pass,false);
 eq(relevant({...c,title:'Лукашенко предложил Зеленскому поездку в Москву',body:'Лукашенко предложил ему сопровождение.'}).pass,true);
});
Deno.test('same outlet title fallback',async()=>{
 const title='Лукашенко предложил необычный сценарий встречи Зеленского с Путиным';
 const key=await samePublisherHeadlineKey('apostrophe.ua',title,'2026-11-25T10:00:00Z');
 if(!key)throw Error('no key');
 eq(key,await samePublisherHeadlineKey('apostrophe.ua',title+'!','2026-11-25T10:00:00Z'));
 if(key===await samePublisherHeadlineKey('uatv.ua',title,'2026-11-25T10:00:00Z'))throw Error('merged different outlets');
});
