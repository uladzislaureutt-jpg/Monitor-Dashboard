import {COUNTRIES,QUERY,urlKey,validDate,relevant,contentLevel,perigonBudget,publicUrl,sourceFor} from './core.ts';
import {extractPage} from './extraction.ts';
import {validRussianCard} from './translation.ts';
import {githubPublications} from './github.ts';
import {zipSync,strToU8} from 'npm:fflate@0.8.2';
function assert(x:unknown):asserts x{if(!x)throw new Error('assertion failed');}
function equal(a:unknown,b:unknown){assert(JSON.stringify(a)===JSON.stringify(b));}
const c={url:'https://example.com/article',title:'Analysis of regional diplomacy',lead:'',body:'',published_at:'2026-11-19T10:00:00Z',language:'en',country:'GB',domain:'example.com',provider:'test',provider_id:'1'};
Deno.test('requested geography and multilingual query',()=>{equal(new Set(COUNTRIES).size,35);assert(QUERY.length<1000);assert(QUERY.includes('卢卡申科'));});
Deno.test('tracking removal preserves article IDs and path case',()=>{
 equal(urlKey('http://www.example.com/News/A/?utm_source=x&id=7#top'),'https://example.com/News/A?id=7');
 assert(urlKey('https://example.com/a?id=7')!==urlKey('https://example.com/a?id=8'));
 assert(urlKey('https://example.com/A')!==urlKey('https://example.com/a'));
});
Deno.test('public URL validation and strict source matching',()=>{
 equal(publicUrl('http://127.0.0.1/a'),null);equal(publicUrl('https://user:pass@example.com/a'),null);
 assert(!sourceFor('https://trusted.com.evil.net/a',[{domain:'trusted.com',name:'Trusted',country:'US'}]));
});
Deno.test('26-hour absolute publication window',()=>{
 const from='2026-11-18T10:07:00Z',to='2026-11-19T12:07:00Z';
 equal(validDate('2026-11-18T13:07:00+03:00',from,to),'2026-11-18T10:07:00.000Z');
 equal(validDate('2026-11-18T10:06:59Z',from,to),null);equal(validDate('2026-11-19T12:07:01Z',from,to),null);
});
Deno.test('late analytical mention is retained and shown in excerpt',()=>{
 const body='Background about regional politics. '.repeat(200)+'Alexander Lukashenko plays a central role because the negotiations depend on the decisions of the Belarusian leadership. '+'Other news. '.repeat(200);
 const r=relevant({...c,body});assert(r.pass);assert(r.evidence.includes('Lukashenko'));assert(r.evidence.length<=1000);
 assert(!relevant(c).pass);
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
