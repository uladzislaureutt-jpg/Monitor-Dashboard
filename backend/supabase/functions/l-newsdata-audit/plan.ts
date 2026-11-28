import {NAMES} from '../l-news-collector/core.ts';
import {CURRENTS_TERMS} from '../l-news-collector/discovery.ts';
import {CLORO_PROFILES} from '../l-news-collector/cloro-config.ts';
export const AUDIT='newsdata-gap-20261128';
export function auditQueries(){
 const terms=[...new Set(['Lukashenko','Lukashenka','Лукашенко','Лукашенка','Лукашэнка',...NAMES,...Object.values(CURRENTS_TERMS).flat(),...Object.values(CLORO_PROFILES).flatMap(p=>p.terms)])];
 const groups:{kind:string;q:string}[]=[];let q='';
 for(const term of terms){const next=q?q+' OR '+term:term;if(next.length>100){groups.push({kind:'name',q});q=term;}else q=next;}
 if(q)groups.push({kind:'name',q});
 for(const q of ['"President of Belarus" OR "Belarusian president"','"президент Беларуси" OR "президент Белоруссии"','"prezydent Białorusi" OR "білоруський президент"','"Präsident von Belarus" OR "belarussische Präsident"','"président biélorusse" OR "président du Bélarus"','"presidente bielorusso" OR "presidente bielorruso" OR "presidente da Bielorrússia"','"Beyaz Rusya Cumhurbaşkanı" OR "Belarus Cumhurbaşkanı"','白俄罗斯总统 OR 白俄羅斯總統 OR ベラルーシ大統領 OR "الرئيس البيلاروسي"'])groups.push({kind:'role',q});
 return groups;
}
export function auditWindows(at='2026-11-28T08:25:00.000Z'){
 const t=Date.parse(at),iso=(hours:number)=>new Date(t-hours*3600000).toISOString();
 return {at:new Date(t).toISOString(),requested:{from:iso(26),to:iso(0)},mature:{from:iso(38),to:iso(12)},union:{from:iso(38),to:iso(0)}};
}
export function inWindow(date:string,window:{from:string;to:string}){const t=Date.parse(date);return Number.isFinite(t)&&t>=Date.parse(window.from)&&t<=Date.parse(window.to);}
