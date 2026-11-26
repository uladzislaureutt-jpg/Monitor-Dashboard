import {COUNTRIES,QUERY,urlKey,validDate,relevant,contentLevel,perigonBudget,publicUrl,publisherArticleKey,sourceFor} from './core.ts';
import {extractPage,ukrainianEdition} from './extraction.ts';
import {translateCard,validRussianCard} from './translation.ts';
import type {Job,Runtime} from './providers.ts';
import {githubPublications} from './github.ts';
import {zipSync,strToU8} from 'npm:fflate@0.8.2';
function assert(x:unknown):asserts x{if(!x)throw new Error('assertion failed');}
function equal(a:unknown,b:unknown){assert(JSON.stringify(a)===JSON.stringify(b));}
const c={url:'https://example.com/article',title:'Analysis of regional diplomacy',lead:'',body:'',published_at:'2026-11-19T10:00:00Z',language:'en',country:'GB',domain:'example.com',provider:'test',provider_id:'1'};
Deno.test('requested geography and multilingual query',()=>{
 equal(new Set(COUNTRIES).size,72);
 for(const country of ['KG','UZ','TJ','HU','RO','SK','NO','AE','OM','EG','DZ','ZW','GQ','AU','KR','TW','LY','MM','LB','CU']){
  assert(COUNTRIES.includes(country));
 }
 assert(QUERY.length<1000);assert(QUERY.includes('卢卡申科'));assert(QUERY.includes('魯卡申柯'));
 assert(relevant({...c,title:'習近平北京會見白俄總統魯卡申柯'}).pass);
});
Deno.test('tracking removal preserves article IDs and path case',()=>{
 equal(urlKey('http://www.example.com/News/A/?utm_source=x&id=7#top'),'https://example.com/News/A?id=7');
 assert(urlKey('https://example.com/a?id=7')!==urlKey('https://example.com/a?id=8'));
 assert(urlKey('https://example.com/A')!==urlKey('https://example.com/a'));
});
Deno.test('public URL validation and strict source matching',()=>{
 equal(publicUrl('http://127.0.0.1/a'),null);equal(publicUrl('https://user:pass@example.com/a'),null);
 assert(!sourceFor('https://trusted.com.evil.net/a',[{domain:'trusted.com',name:'Trusted',country:'US'}]));
 const english={domain:'euronews.com',name:'Euronews English',country:'BE'};
 const french={domain:'fr.euronews.com',name:'Euronews France',country:'FR'};
 equal(sourceFor('https://www.euronews.com/news/a',[english,french]),english);
 equal(sourceFor('https://fr.euronews.com/news/a',[english,french]),french);
 equal(sourceFor('https://ru.euronews.com/news/a',[english,french]),undefined);
});
Deno.test('26-hour absolute publication window',()=>{
 const from='2026-11-18T10:07:00Z',to='2026-11-19T12:07:00Z';
 equal(validDate('2026-11-18T13:07:00+03:00',from,to),'2026-11-18T10:07:00.000Z');
 equal(validDate('2026-11-18T10:06:59Z',from,to),null);equal(validDate('2026-11-19T12:07:01Z',from,to),null);
});
Deno.test('late analytical mention reaches contextual review',()=>{
 const body='Background about regional politics. '.repeat(200)+'Alexander Lukashenko plays a central role because the negotiations depend on the decisions of the Belarusian leadership. '+'Other news. '.repeat(200);
 const r=relevant({...c,body});assert(r.pass);equal(r.review?.length,1);
 assert(r.evidence.includes('Lukashenko'));assert(r.review?.[0].context.includes('Other news'));
 assert(!relevant(c).pass);
});
Deno.test('a historical participation aside in an unrelated article is rejected before any model call',()=>{
 const body='Before 2020, the country led by Alexander Lukashenko also used to participate in the exchange program for a while.';
 const result=relevant({...c,title:'Hungarian universities and Erasmus+',body});
 equal(result.pass,false);
 equal(result.reason,'passing_lukashenko_mention');
 const sameTopic=relevant({...c,title:'Belarus and EU academic exchange',body});
 assert(sameTopic.pass&&sameTopic.review?.length===1);
});
Deno.test('dated calendar digests are excluded but a current meeting reaches review',()=>{
 const body='22 ноября 2023 года Эмомали Рахмон встретился с Александром Лукашенко.';
 for(const title of ['КАЛЕНДАРЬ НИАТ «ХОВАР»: сегодня 22 ноября','ТАҚВИМИ АМИТ «ХОВАР»: имрӯз 22 ноябр']){
  const result=relevant({...c,title,body});
  equal(result.pass,false);
  equal(result.reason,'historical_calendar_roundup');
 }
 const current=relevant({...c,title:'Лукашенко принял Эмомали Рахмона'});
 assert(current.pass);
 equal(current.review?.[0]?.quote,'Лукашенко принял Эмомали Рахмона');
 const historical=relevant({...c,title:'Этот день в истории: как Лукашенко вёл переговоры'});
 assert(historical.pass&&historical.review?.length===1);
});
Deno.test('headline labels reach review and provider translations alone are not evidence',()=>{
 const article={...c,title:'Коментатор образив прихильницю Лукашенка Соболенко',lead:'Коментатор потрапив у скандал.',body:'Телеведучий висловився про тенісистку.'};
 const result=relevant(article);
 assert(result.pass);
 equal(result.review?.[0]?.quote,article.title);
 assert(result.review?.[0]?.context.includes(article.body));
 const translationOnly=relevant({...article,title:'Коментатор образив Соболенко',title_en:'Commentator insults Lukashenko supporter'});
 equal(translationOnly.pass,false);
});
Deno.test('context verdict rejects a passing reference and returns one translated, source-anchored draft',async()=>{
 const incidental={...c,title:'Erasmus+ in Hungary',body:'The talks concern Hungarian universities. Before 2020, the country led by Alexander Lukashenko also participated in the exchange program.'};
 const substantive={...c,title:'Units put on alert',lead:'Alexander Lukashenko ordered an inspection of border units.',body:'Alexander Lukashenko ordered an inspection of border units. The inspection covers units on the Polish border.'};
 const headlineLabel={...c,title:'Комментатор оскорбил сторонницу Лукашенко Соболенко',lead:'Телеканал извинился за высказывание о теннисистке.',language:'ru'};
 const directAction={...c,title:'Лукашенко выразил соболезнования после взрыва в Тбилиси',language:'ru'};
 const replies=[
  {verdict:'passing_reference'},
  {verdict:'substantive',evidence_index:0,title_ru:'Подразделения приведены в готовность',excerpt_ru:'Александр Лукашенко распорядился проверить пограничные подразделения.'},
  {verdict:'passing_reference'},
  {verdict:'substantive',evidence_index:0,excerpt_ru:'Лукашенко передал соболезнования в связи со взрывом в Тбилиси.'},
 ];
 const fetchOriginal=globalThis.fetch;
 const rt={secret:(key:string)=>key==='GEMINI_API_KEY'?'fixture-gemini':'',db:{
  rpc:()=>({data:1}),
  from:()=>({update:()=>({eq:()=>({data:null})}),select:()=>({eq:()=>({maybeSingle:()=>({data:null})})}),upsert:()=>({data:null})}),
 }} as Runtime;
 const job={id:1} as Job;
 const source={domain:'example.com',name:'Example',country:'GB'};
 let attempts=0;
 globalThis.fetch=(_url,request)=>{
  attempts++;
  const payload=JSON.parse(String(request?.body));
  assert(payload.contents[0].parts[0].text.includes('evidence_index'));
  return Promise.resolve(Response.json({candidates:[{content:{parts:[{text:JSON.stringify(replies.shift())}]}}]}));
 };
 try{
  const first=relevant(incidental);
  const rejected=await translateCard(rt,job,null,incidental,source,first.evidence,first.review);
  equal(rejected,{accepted:false,reason:'passing_lukashenko_mention'});
  const second=relevant(substantive);
  equal(second.review?.length,1);
  const ready=await translateCard(rt,job,null,substantive,source,second.evidence,second.review);
  assert(ready.accepted);
  if(ready.accepted)equal(ready.evidence,substantive.lead);
  const label=relevant(headlineLabel);
  equal(await translateCard(rt,job,null,headlineLabel,source,label.evidence,label.review),{accepted:false,reason:'passing_lukashenko_mention'});
  const action=relevant(directAction);
  const shortNews=await translateCard(rt,job,null,directAction,source,action.evidence,action.review);
  assert(shortNews.accepted);
  equal(shortNews.evidence,directAction.title);
  equal(shortNews.lead,'Лукашенко передал соболезнования в связи со взрывом в Тбилиси.');
  equal(attempts,4);
 }finally{globalThis.fetch=fetchOriginal;}
});
Deno.test('previews and paywalls cannot become full text; CJK can',()=>{
 const body='Substantive original article paragraph. '.repeat(200);
 equal(contentLevel('x'.repeat(218),false,true),'SNIPPET');equal(contentLevel(body,false,false),'FULL_TEXT');equal(contentLevel(body,true,false),'PARTIAL');
 equal(contentLevel('卢卡申科白俄罗斯总统访问中国讨论双边关系。'.repeat(70)),'FULL_TEXT');
});
Deno.test('publisher metadata preserves body, published time and paywall',()=>{
 const body='Alexander Lukashenko discussed negotiations. '.repeat(100);
 const html='<html><head><link rel="canonical" href="/article/123"><script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',datePublished:'2026-11-19T09:00:00Z',isAccessibleForFree:false,articleBody:body})+'</script></head><body></body></html>';
 const p=extractPage(html,'https://example.com/article/123?utm_source=x');equal(p.body,body.trim());assert(p.paywall);equal(p.published,'2026-11-19T09:00:00Z');equal(p.canonical,'https://example.com/article/123');
});
Deno.test('Perigon reserve bounds collection',()=>{
 const resetAt=new Date(Date.now()+29.9*86400000).toISOString();
 equal(perigonBudget({requestLimit:150,requestsUsed:3,resetAt},4,10),4);
 equal(perigonBudget({requestLimit:150,requestsUsed:141,resetAt},4,10),0);
});
Deno.test('Russian output preserves original numbers',()=>{
 assert(validRussianCard('Lukashenko discussed 35 projects in 2026',{title_ru:'Лукашенко обсудил 35 проектов в 2026 году',excerpt_ru:''}));
 assert(!validRussianCard('Lukashenko discussed 35 projects in 2026',{title_ru:'Лукашенко обсудил 35 проектов',excerpt_ru:''}));
});
Deno.test('nested GitHub artifact wrappers are indexed',()=>{
 const row={monitor_key:'lukashenko',document_id:'gh-doc',publication:{url:'https://example.com/a'}};
 const inner=zipSync({'publications.jsonl':strToU8(JSON.stringify(row)+'\n')});
 equal(githubPublications(inner),[row]);equal(githubPublications(zipSync({'dashboard_bundle.zip':inner})),[row]);
});

Deno.test('Fontanka comment route resolves to the original article ID',()=>{
 const url='https://www.fontanka.ru/2026/11/19/76778292/comments/?utm_source=test';
 equal(urlKey(url),'https://fontanka.ru/2026/11/19/76778292');
 equal(urlKey('https://example.com/2026/11/19/76778292/comments/'),'https://example.com/2026/11/19/76778292/comments');
});
Deno.test('24 Kanal groups only publisher-declared translations on the same host',()=>{
 const uk='https://24tv.ua/same-interview_n3183327';
 const ru='https://24tv.ua/ru/interview_n3183750';
 const en='https://24tv.ua/en/interview_n3183752';
 const page=extractPage('<head>'+[['uk',uk],['ru',ru],['en',en]].map(([lang,url])=>'<link rel="alternate" hreflang="'+lang+'" href="'+url+'">').join('')+'</head>',ru);
 equal(ukrainianEdition(ru,page.alternatives),{primary:uk,aliases:[uk,ru,en]});
 equal(ukrainianEdition('https://24tv.ua/unrelated_n3184000',page.alternatives),null);
 equal(ukrainianEdition(ru,[{language:'uk',url:'https://example.com/interview_n1'},{language:'ru',url:ru}]),null);
});

Deno.test('same publisher article ID survives different Ukrainian and Russian URL paths',()=>{
 const tsn='https://tsn.ua/svit/lukashenko-doruchyv-pidhotovku-3222839.html';
 equal(publisherArticleKey(tsn),'edition:tsn.ua:3222839');
 equal(publisherArticleKey('https://www.tsn.ua/ru/svit/lukashenko-poruchil-podgotovku-3222839.html?utm_source=fixture'),publisherArticleKey(tsn));
 assert(publisherArticleKey(tsn)!==publisherArticleKey(tsn.replace('3222839','3222555')));
 const pravda='https://www.pravda.com.ua/articles/2026/11/20/8063865/';
 equal(publisherArticleKey(pravda),'edition:pravda.com.ua:8063865');
 equal(publisherArticleKey(pravda.replace('/articles','/rus/articles')),publisherArticleKey(pravda));
 equal(publisherArticleKey(pravda.replace('/articles','/eng/articles')),publisherArticleKey(pravda));
 equal(publisherArticleKey('https://sport.pravda.com.ua/articles/2026/11/20/8063865/'),null);
 equal(publisherArticleKey('https://tsn.ua/ru/tags/category-3222839'),null);
 equal(publisherArticleKey('https://24tv.ua/news/some-article_n3183327'),null);
 const rbc='https://www.rbc.ua/ukr/news/same-story-1795089124.html';
 equal(publisherArticleKey(rbc),publisherArticleKey(rbc.replace('/ukr/','/rus/')+'/amp'));
 assert(publisherArticleKey(rbc)!==publisherArticleKey(rbc.replace('same-story','other-story')));
});

Deno.test('other Ukrainian publishers require an article and a same-host language link to itself',()=>{
 const uk='https://example.ua/news/one-local-article';
 const ru='https://example.ua/ru/news/one-translated-article';
 const alternatives=[{language:'uk-UA',url:uk},{language:'ru',url:ru}];
 equal(ukrainianEdition(ru,alternatives),null);
 equal(ukrainianEdition(ru,alternatives,true),{primary:uk,aliases:[uk,ru]});
 equal(ukrainianEdition(ru,[{language:'uk',url:'https://example.ua/uk'},alternatives[1]],true),null);
 equal(ukrainianEdition(ru,[{language:'uk',url:'https://other.ua/news/another-topic-article'},alternatives[1]],true),null);
});

Deno.test('Rzeczpospolita headline changes keep one publisher article ID',()=>{
 const before='https://www.rp.pl/konflikty-zbrojne/art45542441-najwyzszy-czas-by-mongolia';
 const after='https://rp.pl/konflikty-zbrojne/art45542441-lukaszenko-zadrwil-z-putina';
 equal(publisherArticleKey(before),'edition:rp.pl:45542441');equal(publisherArticleKey(after),publisherArticleKey(before));
 assert(publisherArticleKey('https://rp.pl/news/art45542442-other')!==publisherArticleKey(before));
 equal(publisherArticleKey('https://rp.pl/temat/lukaszenko'),null);
});
