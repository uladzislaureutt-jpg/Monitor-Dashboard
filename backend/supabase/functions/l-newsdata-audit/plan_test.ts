import {auditQueries,auditWindows,inWindow} from './plan.ts';
import {NAMES} from '../l-news-collector/core.ts';
import {CURRENTS_TERMS} from '../l-news-collector/discovery.ts';
import {CLORO_PROFILES} from '../l-news-collector/cloro-config.ts';
function assert(value:unknown,message:string){if(!value)throw Error(message);}
Deno.test('queries fit the real free-plan character ceiling and include every configured name',()=>{
 const q=auditQueries();assert(q.length===15,'expected fifteen independent search groups');
 assert(q.every(x=>x.q.length>0&&x.q.length<=100),'free-plan query limit');
 assert(new Set(q.map(x=>x.q)).size===q.length,'duplicate groups');
 const terms=q.filter(x=>x.kind==='name').flatMap(x=>x.q.split(' OR '));
 for(const term of [...NAMES,...Object.values(CURRENTS_TERMS).flat(),...Object.values(CLORO_PROFILES).flatMap(x=>x.terms)])assert(terms.includes(term),'omitted configured term: '+term);
});
Deno.test('requested and delay-adjusted windows both contain 26 hours',()=>{
 const w=auditWindows();for(const v of [w.requested,w.mature])assert(Date.parse(v.to)-Date.parse(v.from)===26*3600000,'not 26 hours');
 assert(Date.parse(w.at)-Date.parse(w.mature.to)===12*3600000,'delay not applied');
});
Deno.test('only fourteen hours of a current 26-hour window have matured',()=>{
 const w=auditWindows();assert(Date.parse(w.mature.to)-Date.parse(w.requested.from)===14*3600000,'inaccessible news counted as searched');
});
Deno.test('window membership uses timestamps and handles invalid dates',()=>{
 const w=auditWindows().mature;assert(inWindow(w.from,w)&&inWindow(w.to,w),'boundary missing');
 assert(!inWindow('invalid',w)&&!inWindow('2026-11-28T08:25:00Z',w),'unavailable date included');
 assert(inWindow('2026-11-27T23:25:00+03:00',w),'timezone conversion failed');
});
