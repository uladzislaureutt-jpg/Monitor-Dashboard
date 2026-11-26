export type CloroProfile={language:string;terms:string[]};
const p=(language:string,...terms:string[]):CloroProfile=>({language,terms});
// Explicit locales only. A country without a profile must never silently use English.
export const CLORO_PROFILES:Record<string,CloroProfile>={
 US:p('en','Lukashenko','Lukashenka'),GB:p('en','Lukashenko','Lukashenka'),AU:p('en','Lukashenko','Lukashenka'),IE:p('en','Lukashenko','Lukashenka'),
 CA:p('en','Lukashenko','Lukashenka','Loukachenko','Loukachenka'),
 DE:p('de','Lukaschenko','Lukaschenka'),AT:p('de','Lukaschenko','Lukaschenka'),
 CH:p('de','Lukaschenko','Lukaschenka','Loukachenko','Lukashenko'),
 PL:p('pl','Łukaszenka','Łukaszenko','Lukaszenka'),UA:p('uk','Лукашенко','Лукашенка'),RU:p('ru','Лукашенко','Лукашэнка'),
 FR:p('fr','Loukachenko','Loukachenka'),BE:p('fr','Loukachenko','Loekasjenko','Lukashenko'),
 IT:p('it','Lukashenko','Lukashenka'),ES:p('es','Lukashenko','Lukashenka'),
 PT:p('pt','Lukashenko','Lukashenka'),BR:p('pt','Lukashenko','Lukashenka'),TR:p('tr','Lukaşenko','Lukashenko'),
 LT:p('lt','Lukašenka','Lukašenkos','Lukašenką','Лукашенко'),
 LV:p('lv','Lukašenko','Лукашенко'),EE:p('et','Lukašenka','Lukašenko','Лукашенко'),
 CZ:p('cs','Lukašenko','Lukašenka'),SK:p('sk','Lukašenko','Lukašenka'),
 HU:p('hu','Lukasenka','Lukasenko'),RO:p('ro','Lukașenko','Lukaşenko','Lukasenko','Lukashenko'),
 MD:p('ro','Lukașenko','Lukaşenko','Лукашенко'),BG:p('bg','Лукашенко','Лукашенка'),
 RS:p('sr','Лукашенко','Lukašenko','Lukašenka'),KZ:p('ru','Лукашенко','Лукашэнка'),KG:p('ru','Лукашенко','Лукашэнка'),
 AE:p('ar','لوكاشينكو','لوكاشنكو'),SA:p('ar','لوكاشينكو','لوكاشنكو'),QA:p('ar','لوكاشينكو','لوكاشنكو'),
 OM:p('ar','لوكاشينكو','لوكاشنكو'),JO:p('ar','لوكاشينكو','لوكاشنكو'),EG:p('ar','لوكاشينكو','لوكاشنكو'),
 DZ:p('ar','لوكاشينكو','لوكاشنكو','Loukachenko'),MA:p('ar','لوكاشينكو','لوكاشنكو','Loukachenko'),
 LY:p('ar','لوكاشينكو','لوكاشنكو'),LB:p('ar','لوكاشينكو','لوكاشنكو'),
 CN:p('zh-CN','卢卡申科','盧卡申科','魯卡申柯'),TW:p('zh-TW','盧卡申科','魯卡申柯','卢卡申科'),
 JP:p('ja','ルカシェンコ'),KR:p('ko','루카셴코'),IR:p('fa','لوکاشنکو','لوکاشینکو'),
 IL:p('he','לוקשנקו'),GE:p('ka','ლუკაშენკო'),AM:p('hy','Լուկաշենկո'),
};
export const CLORO_PRIORITY=['US','DE','PL'];
export const CLORO_ROTATION=['FR','IT','UA','GB','ES','TR','LT','LV','EE'];
export const CLORO_DEFAULT_COUNTRIES=[...CLORO_PRIORITY,...CLORO_ROTATION];
export const cloroSearchMetadata=()=>({countries:Object.keys(CLORO_PROFILES),priority_countries:CLORO_PRIORITY,default_countries:CLORO_DEFAULT_COUNTRIES});
export function cloroRequest(country:string,fromAt:string,toAt:string){
 const profile=CLORO_PROFILES[country];if(!profile)throw new Error('invalid_cloro_country');
 const from=new Date(Date.parse(fromAt)-86400000).toISOString().slice(0,10),to=new Date(Date.parse(toAt)+86400000).toISOString().slice(0,10);
 return {query:'('+profile.terms.join(' OR ')+') after:'+from+' before:'+to,country,gl:country.toLowerCase(),hl:profile.language,pages:1,include:{html:false}};
}
