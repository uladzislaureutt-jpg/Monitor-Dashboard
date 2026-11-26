export const VERSION = 'l-news-pilot-1';
export const COUNTRY_NAMES: Record<string,string> = {
 RU:'Россия',UA:'Украина',PL:'Польша',LT:'Литва',LV:'Латвия',SE:'Швеция',FI:'Финляндия',
 DE:'Германия',AT:'Австрия',CZ:'Чехия',RS:'Сербия',BG:'Болгария',CH:'Швейцария',IT:'Италия',
 ES:'Испания',FR:'Франция',GB:'Великобритания',TR:'Турция',US:'США',CA:'Канада',BR:'Бразилия',
 MX:'Мексика',CN:'Китай',JP:'Япония',VN:'Вьетнам',IN:'Индия',PK:'Пакистан',IR:'Иран',
 QA:'Катар',IL:'Израиль',AM:'Армения',GE:'Грузия',AZ:'Азербайджан',KZ:'Казахстан',BE:'Бельгия',
 KG:'Кыргызстан',UZ:'Узбекистан',TJ:'Таджикистан',HU:'Венгрия',RO:'Румыния',SK:'Словакия',
 NO:'Норвегия',AE:'ОАЭ',OM:'Оман',SA:'Саудовская Аравия',JO:'Иордания',EG:'Египет',
 DZ:'Алжир',ZW:'Зимбабве',GQ:'Экваториальная Гвинея',ZA:'ЮАР',NG:'Нигерия',KE:'Кения',
 MA:'Марокко',ET:'Эфиопия',NL:'Нидерланды',IE:'Ирландия',DK:'Дания',PT:'Португалия',
 GR:'Греция',EE:'Эстония',HR:'Хорватия',SI:'Словения',MD:'Молдова',VA:'Ватикан',
 AU:'Австралия',KR:'Южная Корея',TW:'Тайвань',LY:'Ливия',MM:'Мьянма',LB:'Ливан',CU:'Куба',
};
export const COUNTRIES = Object.keys(COUNTRY_NAMES);
export const NAMES = ['Loukachenka','Lukaschenka','Łukaszenko','لوكاشنكو','Loekasjenko','Lukasenka','Lukasenko','Λουκασένκο','Lukaixenko','ลูกาเชนโก','루카셴코','लुकाशेंको','لوکاشینکو','Lukasjenko','Lukasjenka','Лукашенко','Лукашенка','Лукашэнка','Lukashenko','Lukashenka','Loukachenko','Lukaschenko','Łukaszenka','Łukaszenki','Łukaszenkę','Łukaszenką','Łukaszence','Lukaszenko','Lukašenka','Lukašenko','Lukaşenko','Lukašenko','Lukašenkos','Lukašenkas','Lukašenko','Lukashenkon','Lukașenko','卢卡申科','魯卡申柯','盧卡申科','ルカシェンコ','لوکاشنکو','لوكاشينكو','לוקשנקו','ლუკაშენკო','Լուկաշենկո'];
export const QUERY = [...new Set(NAMES)].map(x=>'"'+x+'"').join(' OR ');
export const ROLE_QUERY = '"President of Belarus" OR "Belarusian president" OR "президент Беларуси" OR "президент Белоруссии" OR "prezydent Białorusi"';
const tracking=/^(utm_.+|fbclid|gclid|yclid|dclid|mc_cid|mc_eid|ref_src|cmpid|ocid)$/i;

export type Source = {domain:string;name:string;country:string;language?:string;source_type?:string;priority?:string;baseline?:boolean;coverage?:Record<string,unknown>};
export type Candidate = {url:string;title:string;lead:string;body:string;published_at:string|null;language:string;country:string;domain:string;provider:string;provider_id:string;image?:string;paywall?:boolean;canonical?:string;content_truncated?:boolean;title_en?:string; identity_url?:string; aliases?:string[]};

export function publicUrl(value:string):string|null {
 try {const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port&& !['80','443'].includes(u.port))return null;
  const h=u.hostname.toLowerCase();if(!h.includes('.')||/^\d+(\.\d+){3}$/.test(h)||h.includes(':')||/\.(?:local|localhost|internal|test|invalid)$/.test(h)||h.endsWith('.supabase.co'))return null;
  return u.href;
 }catch{return null;}
}
export function urlKey(value:string):string {
 const safe=publicUrl(value);if(!safe)throw new Error('invalid_public_url');
 const u=new URL(safe);u.hash='';u.protocol='https:';u.hostname=u.hostname.replace(/^www\./,'');
 if(u.hostname==='amp.dw.com')u.hostname='dw.com';
 if(u.hostname==='bbc.com')u.pathname=u.pathname.replace(/\.amp$|\/amp\/?$/,'');
 for(const k of [...u.searchParams.keys()])if(tracking.test(k))u.searchParams.delete(k);
 if(u.hostname==='fontanka.ru'&&/^\/\d{4}\/\d{2}\/\d{2}\/\d+\/comments\/?$/.test(u.pathname)){
  u.pathname=u.pathname.replace(/\/comments\/?$/,'');
 }
 u.searchParams.sort();if(u.pathname.length>1)u.pathname=u.pathname.replace(/\/+$/,'');return u.href;
}
export function domainOf(value:string):string {try{return new URL(value).hostname.toLowerCase().replace(/^www\./,'');}catch{return '';}}
export function publisherArticleKey(value: string): string | null {
 const domain = domainOf(value);
 const host=(site:string)=>domain===site||domain.endsWith('.'+site);
 const exact=['tsn.ua','pravda.com.ua','rbc.ua','iz.ru','politika.rs','rp.pl'];
 const multiHost=['fakti.bg','novosti.rs','censor.net','diena.lt','reuters.com','yahoo.com','obozrevatel.com'];
 if(!exact.includes(domain)&&!multiHost.some(host))return null;
 const path = new URL(value).pathname.replace(/\/+$/, '');
 if(domain==='rp.pl'){
  const id=path.match(/\/art([0-9]{6,12})(?:-|$)/i)?.[1];
  return id?'edition:rp.pl:'+id:null;
 }
 if(host('fakti.bg')){
  const id=path.match(/^\/(?:en\/)?[^/]+\/([0-9]{5,12})-[^/]+$/i)?.[1];
  return id?'edition:fakti.bg:'+id:null;
 }
 if(host('novosti.rs')){
  const id=path.match(/^\/(?:c\/)?[^/]+\/[^/]+\/([0-9]{5,12})(?:\/|$)/i)?.[1];
  return id?'edition:novosti.rs:'+id:null;
 }
 if(host('diena.lt')){
  const id=path.match(/-([0-9]{5,12})$/)?.[1];
  return id?'edition:diena.lt:'+id:null;
 }
 if(host('censor.net')){
  const id=path.match(/^\/(?:(?:ru|en|ua|uk)\/)?news\/([0-9]{5,12})(?:\/|$)/i)?.[1];
  return id?'edition:censor.net:'+id:null;
 }
 if(host('yahoo.com')){
  const id=path.match(/-([0-9]{8,12})\.html$/i)?.[1];
  return id?'edition:yahoo.com:'+id:null;
 }
 if(host('reuters.com')){
  const id=path.match(/\/([A-Z0-9]{18,32})-20[0-9]{2}-[0-9]{2}-[0-9]{2}$/)?.[1];
  if(id)return 'edition:reuters.com:'+id;
  const route=path.match(/^\/(?:world|business|markets|technology|politics|legal)\/(.+-20[0-9]{2}-[0-9]{2}-[0-9]{2})$/i)?.[1];
  return route?'edition:reuters.com:'+route:null;
 }
 if(host('obozrevatel.com')){
  const slug=path.replace(/^\/(?:ukr|rus)\//i,'/').replace(/\/newsamp-/i,'/news-');
  return /^\/section-[^/]+\/news-[a-z0-9-]+\.html$/i.test(slug)?'edition:obozrevatel.com:'+slug.toLowerCase():null;
 }
 if(domain==='iz.ru'){
  const id=path.match(/^\/(?:en\/node\/)?([0-9]{5,12})(?:\/|$)/i)?.[1];
  return id?`edition:iz.ru:${id}`:null;
 }
 if(domain==='politika.rs'){
  const id=path.match(/^\/(?:sr|scc|en)\/clanak\/([0-9]{4,12})(?:\/|$)/i)?.[1];
  return id?`edition:politika.rs:${id}`:null;
 }
 if (domain === 'rbc.ua') {
  const articlePath = path.match(/^\/(?:(?:rus|ukr|eng)\/)?(news\/[^/]+-[0-9]{10}\.html)(?:\/amp)?$/i)?.[1];
  return articlePath ? `edition:https://rbc.ua/${articlePath}` : null;
 }
 const id = domain === 'tsn.ua'
  ? path.match(/^\/(?:[^/]+\/)+[^/]+-([0-9]{6,10})\.html$/i)?.[1]
  : path.match(/^\/(?:(?:rus|eng|ukr)\/)?(?:news|articles|columns|interview)\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/([0-9]{6,10})$/i)?.[1];
 return id ? `edition:${domain}:${id}` : null;
}
export function sourceFor(value:string,sources:Source[]):Source|undefined {
 const domain=domainOf(value);
 // The root Euronews domain is the English edition. Other editions have their own domains.
 return sources.find(s=>s.domain===domain)||sources.filter(s=>s.domain!=='euronews.com'&&domain.endsWith('.'+s.domain)).sort((a,b)=>b.domain.length-a.domain.length)[0];
}
export function clean(value:unknown):string{return String(value??'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();}
export function validDate(value:unknown,from:string,to:string):string|null {
 const t=Date.parse(String(value??''));return Number.isFinite(t)&&t>=Date.parse(from)&&t<=Date.parse(to)?new Date(t).toISOString():null;
}
export function containsName(text:string):boolean {
 const t=text.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
 return NAMES.some(n=>t.includes(n.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase()))||/lukas(?:h|c|s|z)?enk|лукаш[еэ]нк/.test(t);
}
export type RelevancePassage = { quote:string; context:string };
type Relevance = {pass:boolean;reason:string;evidence:string;review?:RelevancePassage[]};

function mentionExcerpt(value:string){
 const pattern=new RegExp(NAMES.join('|')+'|lukas(?:h|c|s|z)?enk|лукаш[еэ]нк','iu');
 const position=value.search(pattern);
 return value.slice(Math.max(0,position-185),Math.max(0,position-185)+850);
}

function isHistoricalParticipationAside(title:string,lead:string,passages:RelevancePassage[]){
 if(passages.length!==1||containsName(lead)||/\b(?:belarus(?:ian)?|minsk)\b/i.test(title+' '+lead))return false;
 const quote=passages[0].quote;
 const identification=/\bthe country (?:led|headed|governed|ruled) by (?:Alexander |Aleksandr |Alyaksandr )?Lukashenk[oa]\b/i;
 return identification.test(quote)&&!containsName(quote.replace(identification,''))&&
  /\b(?:used to participate|formerly participated|previously participated|once participated)\b/i.test(quote);
}

export function relevant(candidate:Candidate,body=candidate.body):Relevance {
 const title=clean(candidate.title),lead=clean(candidate.lead);
 const calendar=/^(?:(?:тақвими|календарь|calendar)\s+(?:амит|ниат|niat)|(?:этот день в истории|цей день в історії|on this day in history)\s*[:—–-])/iu;
 const namedInTitle=containsName(title);
 // A multi-topic roundup is not an independent article about Lukashenko.
 const roundup=/(?:^|[\s:—-])(?:live|liveblog|ticker|chronologie|chronology|хронология|дайджест|сводка за день|r[eé]veil|informations de la nuit|ukraine war briefing|новости сво|новости украины)(?:[\s:—-]|$)/iu;
 const explicitLive=/^\s*\/?\s*(?:live\s*(?:text|blog|updates)|war\s+live\s+updates|ukraine\s+war\s+briefing)\b/i;
 if(explicitLive.test(title)||(!namedInTitle&&roundup.test(title)))return {pass:false,reason:'roundup_not_standalone',evidence:title};
 if(!namedInTitle&&calendar.test(title))return {pass:false,reason:'historical_calendar_roundup',evidence:title};

 const passages=new Map<string,RelevancePassage>();
 if(namedInTitle){
  const opening=clean(body).slice(0,1000);
  const context=[lead.slice(0,400),opening].filter(Boolean).join('\n');
  passages.set(title,{quote:mentionExcerpt(title),context});
 }
 for(const text of [lead,body]){
  const sentences=text.split(/(?<=[.!?])\s+|(?<=[。！？])\s*|\n+/u).map(clean).filter(Boolean);
  for(const [index,sentence] of sentences.entries()){
   if(!containsName(sentence))continue;
   // Editorial recommendations and cross-links are not article content.
   const related=/(?:^|[\s\[({])(?:читайте\s+также|также\s+читайте|ещ[её]\s*[:—-]|още\s*[:—-]|read\s+(?:more|also)|related\s+(?:news|articles)|see\s+also|a\s+lire\s+aussi|zobacz\s+także)(?:\s|[:—-])/iu;
   if(!namedInTitle&&related.test(sentence))continue;
   const previous=sentences[index-1]?.slice(-300)??'';
   const next=sentences[index+1]?.slice(0,300)??'';
   const context=[previous,next].filter(Boolean).join('\n');
   const previousPassage=passages.get(sentence);
   if(!previousPassage||context.length>previousPassage.context.length){
    passages.set(sentence,{quote:mentionExcerpt(sentence),context});
   }
  }
 }
 const review=[...passages.values()];
 if(!review.length)return {pass:false,reason:'no_substantive_lukashenko_mention',evidence:''};
 if(isHistoricalParticipationAside(title,lead,review)){
  return {pass:false,reason:'passing_lukashenko_mention',evidence:review[0].quote};
 }
 const samples=review.length>8?[...review.slice(0,4),...review.slice(-4)]:review;
 return {pass:true,reason:'context_review',evidence:samples[0].quote,review:samples};
}
export function contentLevel(text:string,paywall=false,truncated=false):string {
 const body=text.trim();if(!body)return 'METADATA';
 if(paywall||truncated)return body.length>=350?'PARTIAL':'SNIPPET';
 const substantial=body.split(/\s+/).length>=80||(body.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)||[]).length>=350;
 return body.length>=700&&substantial?'FULL_TEXT':body.length>=350?'PARTIAL':'SNIPPET';
}
export function batches<T>(values:T[],size=100):T[][] {const out:T[][]=[];for(let i=0;i<values.length;i+=size)out.push(values.slice(i,i+size));return out;}
export async function sha(value:string):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
// A conservative cross-language fallback when a publisher does not expose a
// stable article ID. Merge only one outlet, one UTC publication day and nearly
// identical translated headlines; never merge on subject names alone.
export async function samePublisherHeadlineKey(source:string,title:string,published:string):Promise<string|null>{
 const normalized=title.normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
 if(normalized.length<48||!/^20\d{2}-\d\d-\d\d/.test(published))return null;
 const stop=new Set(['и','в','во','на','к','ко','от','для','из','за','с','со','по','о','об','а','но','это','что','как','у','при','или','the','a','an','and','of','to','for','in']);
 const words=normalized.split(/\s+/).filter(w=>w.length>=2&&!stop.has(w)).sort();
 if(words.length<6)return null;
 return 'edition:headline:'+source+':'+published.slice(0,10)+':'+(await sha(words.join('|'))).slice(0,30);
}

export function perigonBudget(info:Record<string,unknown>,max=4,reserve=10):number {
 const limit=Math.min(150,Number(info.requestLimit??150)),used=Number(info.requestsUsed??0);
 // A per-run allowance is a ceiling, not a daily pacing quota.
 // Preserve the hard monthly entitlement and the configured reserve.
 const remaining=Math.max(0,limit-used-reserve);
 return Math.max(0,Math.min(max,remaining));
}

export function buildCard(c:Candidate,s:Source,uid:string,titleRu:string,leadRu:string,level:string,evidence:string,runId:string) {
 return {schema_version:'0.3',monitor_key:'lukashenko',document_id:uid,monitor_item_id:'item_'+uid,
  source:{name:s.name,type:s.source_type||'media',priority:s.priority||'B',language:c.language||s.language||null,configured_region:COUNTRY_NAMES[s.country]||s.country,configured_locality:null},
  publication:{published_at:c.published_at,title:titleRu,title_generated:false,excerpt:leadRu||null,url:c.url,normalized_url:urlKey(c.identity_url||c.canonical||c.url),text_length:c.body.length,preview_image_url:c.image||null},
  classification:{category:'Международная повестка',subcategory:s.source_type==='think_tank'?'Аналитика':'Лукашенко',signal_type:'содержательное упоминание',official_response:null,score:80,matched_terms:['Лукашенко'],category_bonus_only:false},
  event:{region:COUNTRY_NAMES[s.country]||s.country,locality:null,geo_status:'source_country',geo_confidence:1,object:null,problem:'Лукашенко',signature:null,echo:false,echo_anchor:null,echo_sources:null,also_covered_by:null,also_covered_urls:null},
  provenance:{report:'L-News-Assistant',collector_run_id:runId,provider:c.provider,content_level:level,content_source:level==='FULL_TEXT'?'publisher_or_provider_body':'public_preview',title_original:c.title,lead_original:c.lead,url_aliases:[...new Set([c.url,...(c.canonical?[c.canonical]:[]),...(c.aliases??[])])],evidence,translation_target:'ru',paywall:!!c.paywall}};
}
