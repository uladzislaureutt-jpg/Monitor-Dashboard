import { useCallback, useEffect, useRef, useState } from "react";
import { useMonitorAccess } from "../access";
import { loadWorkroomConfig } from "../workroom";

type Run = {id:string; number:number; status:string; to_at:string; counters:Record<string,number>; warnings:string[]};
type Snapshot = {settings:{enabled:boolean;lookback_hours:number};runs:Run[];providers:{provider:string;info:Record<string,any>}[];sources:{country:string;baseline:boolean;coverage:Record<string,unknown>}[]};
const active = (run:Run) => ["queued","discovering","processing"].includes(run.status);
const labels:Record<string,string>={queued:"В очереди",discovering:"Поиск",processing:"Извлечение и перевод",completed:"Завершён",partial:"Завершён с замечаниями",failed:"Ошибка",cancelled:"Остановлен"};

export function LNewsAssistant({onSync,syncBusy}:{onSync:()=>void;syncBusy:boolean}){
 const access=useMonitorAccess();const [data,setData]=useState<Snapshot|null>(null);const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [hours,setHours]=useState(26);const [notice,setNotice]=useState("");
 const token=access.session.accessToken;const onSyncRef=useRef(onSync);onSyncRef.current=onSync;
 const revisionRef=useRef("");
 const call=useCallback(async(action:string,extra:Record<string,unknown>={})=>{
  const config=loadWorkroomConfig();const response=await fetch(`${config.url.replace(/\/+$/,"")}/functions/v1/l-news-collector`,{method:"POST",headers:{apikey:config.anonKey,authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({action,...extra}),signal:AbortSignal.timeout(30000)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||`HTTP ${response.status}`);return result;
 },[token]);
 const refresh=useCallback(async()=>{const snapshot:Snapshot=await call("status");setData(snapshot);setHours(snapshot.settings.lookback_hours);setError("");
  const signature=snapshot.runs.map(r=>`${r.id}:${r.counters.ready||0}`).join("|");
  if(revisionRef.current && signature!==revisionRef.current)onSyncRef.current();revisionRef.current=signature;
 },[call]);
 useEffect(()=>{let stopped=false;const poll=()=>{if(!stopped)void refresh().catch(e=>{if(!stopped)setError(String(e));});};poll();const timer=setInterval(poll,20000);return()=>{stopped=true;clearInterval(timer);};},[refresh]);
 async function act(action:string,extra:Record<string,unknown>={}){setBusy(true);setError("");try{const result=await call(action,extra);setNotice(action==="quota"?"Проверка остатка поставлена в очередь; поисковые запросы не расходуются.":action==="start"?"Сбор поставлен в очередь.":action==="retry_failed"?`Возвращено в очередь: ${result.retried}.`:"Настройки сохранены.");await refresh();}catch(e){setError(String(e));}finally{setBusy(false);}}
 const perigon=data?.providers.find(p=>p.provider==="perigon")?.info;
 const newscatcher=data?.providers.find(p=>p.provider==="newscatcher")?.info;
 const limits=perigon?.limits||{};
 const latest=data?.runs[0];
 const coverage=data?.sources.filter(s=>Object.values(s.coverage||{}).some(v=>typeof v==='object'&&v!==null&&'status' in v&&v.status==='indexed_article_seen')).length||0;
 const totals=data?.runs.reduce((a,r)=>({perigon:a.perigon+(r.counters.perigon_requests||0),newscatcher:a.newscatcher+(r.counters.newscatcher_requests||0),credits:a.credits+(r.counters.newscatcher_credits||0)}),{perigon:0,newscatcher:0,credits:0});
 return <section className="panel l-news-assistant"><div className="panel-head"><div><h3>Помощник L-Monitor · пилот</h3><p>Ежедневно в 15:07 по Минску · окно {data?.settings.lookback_hours??26} часов · карточки на русском</p></div><span className="badge">{data?.settings.enabled?"Расписание включено":"Расписание выключено"}</span></div>
 {error&&<p role="alert" className="error-text">{error}</p>}{notice&&<p role="status">{notice}</p>}
 <div className="kpi-grid"><article className="kpi"><strong>{data?.sources.length??"—"}</strong><span>Каталог · {new Set(data?.sources.map(s=>s.country)).size} стран</span></article><article className="kpi"><strong>{coverage}</strong><span>Источники с фактической выдачей API</span></article><article className="kpi"><strong>{limits.requestsUsed??"—"} / {limits.requestLimit??150}</strong><span>Perigon: использовано за расчётный месяц</span></article><article className="kpi"><strong>{newscatcher?.subscription?.credits_balance??newscatcher?.balance??"—"}</strong><span>Newscatcher: остаток кредитов</span></article></div>
 <p>Perigon: одна страница — один запрос, до {limits.maxPageSize??100} результатов. Лимит пилота — до 4 поисковых запросов в день, резерв — 10 в месяц. Сброс: {limits.resetAt?new Date(limits.resetAt).toLocaleString("ru-RU",{timeZone:"Europe/Minsk"}):"—"}.</p>
 <p>За последние {data?.runs.length??0} сборов: Perigon {totals?.perigon??0} запросов; Newscatcher {totals?.newscatcher??0} страниц / {totals?.credits??0} кредитов. Диагностические запросы Perigon учтены в остатке выше. Каталог — список целей; наличие каждого издания в API проверяется по фактической выдаче.</p>
 <div className="sync-form"><label>Глубина, часов <input type="number" min={1} max={168} value={hours} onChange={e=>setHours(Number(e.target.value))}/></label><button className="secondary-button" disabled={busy} onClick={()=>void act("settings",{lookback_hours:hours})}>Сохранить глубину</button><button className="secondary-button" disabled={busy||!data} onClick={()=>void act("settings",{enabled:!data?.settings.enabled})}>{data?.settings.enabled?"Приостановить расписание":"Включить расписание"}</button><button className="primary-button" disabled={busy||!!latest&&active(latest)} onClick={()=>void act("start")}>Собрать сейчас</button><button className="secondary-button" disabled={busy} onClick={()=>void act("quota")}>Проверить остатки</button><button className="secondary-button" disabled={busy} onClick={()=>void act("retry_failed")}>Повторить ошибки обработки</button><button className="secondary-button" disabled={syncBusy} onClick={onSync}>Получить карточки</button></div>
 <div className="table-wrap"><table><thead><tr><th>Сбор</th><th>Состояние</th><th>Готово / полные тексты</th><th>Повторы</th><th>Расход</th></tr></thead><tbody>{data?.runs.slice(0,10).map(r=><tr key={r.id}><td>Помощник #{r.number}<small>{new Date(r.to_at).toLocaleString("ru-RU",{timeZone:"Europe/Minsk"})}</small></td><td>{labels[r.status]||r.status}{active(r)&&<small>В очереди: {r.counters.jobs_pending||0}</small>}{!!r.warnings?.length&&<details><summary>Замечания: {r.warnings.length}</summary>{r.warnings.map((w,i)=><p key={i}>{w}</p>)}</details>}</td><td>{r.counters.ready||0} / {r.counters.full_texts||0}</td><td>{r.counters.already_known||0}</td><td>Perigon {r.counters.perigon_requests||0}<small>Newscatcher {r.counters.newscatcher_credits||0} кр.</small></td></tr>)}</tbody></table></div></section>;
}
