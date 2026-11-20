export const VERSION = 'l-news-pilot-1';
export const COUNTRIES = ['RU','UA','PL','LT','LV','SE','FI','DE','AT','CZ','RS','BG','CH','IT','ES','FR','GB','TR','US','CA','BR','MX','CN','JP','VN','IN','PK','IR','QA','IL','AM','GE','AZ','KZ','BE'];
export const COUNTRY_NAMES: Record<string,string> = {RU:'Россия',UA:'Украина',PL:'Польша',LT:'Литва',LV:'Латвия',SE:'Швеция',FI:'Финляндия',DE:'Германия',AT:'Австрия',CZ:'Чехия',RS:'Сербия',BG:'Болгария',CH:'Швейцария',IT:'Италия',ES:'Испания',FR:'Франция',GB:'Великобритания',TR:'Турция',US:'США',CA:'Канада',BR:'Бразилия',MX:'Мексика',CN:'Китай',JP:'Япония',VN:'Вьетнам',IN:'Индия',PK:'Пакистан',IR:'Иран',QA:'Катар',IL:'Израиль',AM:'Армения',GE:'Грузия',AZ:'Азербайджан',KZ:'Казахстан',BE:'Бельгия'};
export const NAMES = ['Лукашенко','Лукашенка','Лукашэнка','Lukashenko','Lukashenka','Loukachenko','Lukaschenko','Łukaszenka','Łukaszenki','Łukaszenkę','Łukaszenką','Łukaszence','Lukaszenko','Lukašenka','Lukašenko','Lukaşenko','Lukašenko','Lukašenkos','Lukašenkas','Lukašenko','Lukashenkon','Lukașenko','卢卡申科','ルカシェンコ','لوکاشنکو','لوكاشينكو','לוקשנקו','ლუკაშენკო','Լուկաշենկո'];
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
 for(const k of [...u.searchParams.keys()])if(tracking.test(k))u.searchParams.delete(k);
 if(u.hostname==='fontanka.ru'&&/^\/\d{4}\/\d{2}\/\d{2}\/\d+\/comments\/?$/.test(u.pathname)){
  u.pathname=u.pathname.replace(/\/comments\/?$/,'');
 }
 u.searchParams.sort();if(u.pathname.length>1)u.pathname=u.pathname.replace(/\/+$/,'');return u.href;
}
export function domainOf(value:string):string {try{return new URL(value).hostname.toLowerCase().replace(/^www\./,'');}catch{return '';}}
export function sourceFor(value:string,sources:Source[]):Source|undefined {
 const domain=domainOf(value);return sources.find(s=>s.domain===domain)||sources.filter(s=>domain.endsWith('.'+s.domain)).sort((a,b)=>b.domain.length-a.domain.length)[0];
}
export function clean(value:unknown):string{return String(value??'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();}
export function validDate(value:unknown,from:string,to:string):string|null {
 const t=Date.parse(String(value??''));return Number.isFinite(t)&&t>=Date.parse(from)&&t<=Date.parse(to)?new Date(t).toISOString():null;
}
export function containsName(text:string):boolean {
 const t=text.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
 return NAMES.some(n=>t.includes(n.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase()))||/lukas(?:h|c|s|z)?enk|лукаш[еэ]нк/.test(t);
}
export function relevant(candidate:Candidate,body=candidate.body):{pass:boolean;reason:string;evidence:string} {
 const title=clean(candidate.title), text=clean(body),lead=clean(candidate.lead);
 if(containsName(title))return {pass:true,reason:'name_in_title',evidence:title};
 const paragraphs=body.split(/(?<=[.!?。！？])\s+|\n+/u).map(clean).filter(Boolean);
 const evidence=paragraphs.find(p=>containsName(p)&&p.length>=50);
 function context(value:string){
  const pattern=new RegExp(NAMES.join('|')+'|lukas(?:h|c|s|z)?enk|лукаш[еэ]нк','iu');
  const index=value.search(pattern);const start=Math.max(0,index-200);return value.slice(start,start+1000);
 }
 if(evidence)return {pass:true,reason:'substantive_body_mention',evidence:context(evidence)};
 if(containsName(text)&&text.length>=200)return {pass:true,reason:'body_mention',evidence:context(text)};
 if(containsName(lead)&&lead.length>=80)return {pass:true,reason:'public_lead_mention',evidence:lead};
 if(containsName(candidate.title_en||''))return {pass:true,reason:'translated_title_mention',evidence:candidate.title_en!};
 return {pass:false,reason:'no_substantive_lukashenko_mention',evidence:''};
}
export function contentLevel(text:string,paywall=false,truncated=false):string {
 const body=text.trim();if(!body)return 'METADATA';
 if(paywall||truncated)return body.length>=350?'PARTIAL':'SNIPPET';
 const substantial=body.split(/\s+/).length>=80||(body.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)||[]).length>=350;
 return body.length>=700&&substantial?'FULL_TEXT':body.length>=350?'PARTIAL':'SNIPPET';
}
export function batches<T>(values:T[],size=100):T[][] {const out:T[][]=[];for(let i=0;i<values.length;i+=size)out.push(values.slice(i,i+size));return out;}
export async function sha(value:string):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export function perigonBudget(info:Record<string,unknown>,max=4,reserve=10):number {
 const limit=Math.min(150,Number(info.requestLimit??150)),used=Number(info.requestsUsed??0);
 const remaining=Math.max(0,limit-used-reserve);const reset=Date.parse(String(info.resetAt||''));
 const days=Number.isFinite(reset)?Math.max(1,Math.ceil((reset-Date.now())/86400000)):30;
 return Math.max(0,Math.min(max,remaining,Math.floor(remaining/days)));
}

export function buildCard(c:Candidate,s:Source,uid:string,titleRu:string,leadRu:string,level:string,evidence:string,runId:string) {
 return {schema_version:'0.3',monitor_key:'lukashenko',document_id:uid,monitor_item_id:'item_'+uid,
  source:{name:s.name,type:s.source_type||'media',priority:s.priority||'B',language:c.language||s.language||null,configured_region:COUNTRY_NAMES[s.country]||s.country,configured_locality:null},
  publication:{published_at:c.published_at,title:titleRu,title_generated:false,excerpt:leadRu||null,url:c.url,normalized_url:urlKey(c.identity_url||c.canonical||c.url),text_length:c.body.length,preview_image_url:c.image||null},
  classification:{category:'Международная повестка',subcategory:s.source_type==='think_tank'?'Аналитика':'Лукашенко',signal_type:'содержательное упоминание',official_response:null,score:80,matched_terms:['Лукашенко'],category_bonus_only:false},
  event:{region:COUNTRY_NAMES[s.country]||s.country,locality:null,geo_status:'source_country',geo_confidence:1,object:null,problem:'Лукашенко',signature:null,echo:false,echo_anchor:null,echo_sources:null,also_covered_by:null,also_covered_urls:null},
  provenance:{report:'L-News-Assistant',collector_run_id:runId,provider:c.provider,content_level:level,content_source:level==='FULL_TEXT'?'publisher_or_provider_body':'public_preview',title_original:c.title,lead_original:c.lead,url_aliases:[...new Set([c.url,...(c.canonical?[c.canonical]:[]),...(c.aliases??[])])],evidence,translation_target:'ru',paywall:!!c.paywall}};
}
