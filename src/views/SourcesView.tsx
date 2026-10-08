import { useEffect, useMemo, useState } from "react";
import { desktopApi } from "../api";
import type { PeriodDays, SourceSummary } from "../types";
import { useI18n } from "../i18n";
import { localizeDataLabel } from "../dataLabels";
import { PeriodSelector } from "../components/PeriodSelector";

type SourceSort = "default" | "priority" | "region";

function priorityRank(value: string | null) {
  if (!value?.trim()) return Number.POSITIVE_INFINITY;
  const normalized = value.trim().toLocaleLowerCase();
  const number = normalized.match(/\d+/)?.[0];
  if (number) return Number(number);
  if (/critical|highest|high|высок|высокі/.test(normalized)) return 1;
  if (/medium|normal|сред|сярэд/.test(normalized)) return 2;
  if (/low|низк|нізк/.test(normalized)) return 3;
  return 1000;
}

export function SourcesView(){
  const{t,locale}=useI18n();
  const isLMonitor=desktopApi.activeMonitorKey()==="lukashenko";
  const[items,setItems]=useState<SourceSummary[]>([]),[query,setQuery]=useState(""),[error,setError]=useState(""),[moderationVersion,setModerationVersion]=useState(0),[period,setPeriod]=useState<PeriodDays>(30),[loading,setLoading]=useState(false),[sort,setSort]=useState<SourceSort>("default");
  useEffect(()=>{const handler=()=>setModerationVersion(value=>value+1);window.addEventListener("monitor:moderation-changed",handler);return()=>window.removeEventListener("monitor:moderation-changed",handler)},[]);
  useEffect(()=>{setLoading(true);desktopApi.sources(period).then((result)=>{setItems(result);setError("")}).catch(r=>setError(String(r))).finally(()=>setLoading(false))},[moderationVersion,period]);
  const filtered=useMemo(()=>{
    const n=query.trim().toLocaleLowerCase(locale==="be"?"be-BY":"ru-RU");
    const base=n?items.filter(item=>[item.name,item.domain??"",item.region??"",localizeDataLabel(item.region,locale,"region"),item.locality??"",item.sourceType??"",localizeDataLabel(item.sourceType,locale,"sourceType")].some(v=>v.toLocaleLowerCase(locale==="be"?"be-BY":"ru-RU").includes(n))):items;
    if(!isLMonitor||sort==="default")return base;
    const collator=new Intl.Collator(locale==="be"?"be-BY":"ru-RU",{sensitivity:"base",numeric:true});
    return [...base].sort((a,b)=>{
      if(sort==="priority"){
        const rank=priorityRank(a.priority)-priorityRank(b.priority);
        if(rank!==0)return rank;
        const priority=collator.compare(a.priority??"",b.priority??"");
        if(priority!==0)return priority;
      }
      if(sort==="region"){
        const regionA=localizeDataLabel(a.region,locale,"region")||"";
        const regionB=localizeDataLabel(b.region,locale,"region")||"";
        if(!regionA&&regionB)return 1;
        if(regionA&&!regionB)return -1;
        const region=collator.compare(regionA,regionB);
        if(region!==0)return region;
      }
      return collator.compare(a.name,b.name);
    });
  },[items,query,locale,isLMonitor,sort]);
  const sx={
    sortLabel:locale==="be"?"Сартаванне":"Сортировка",
    defaultSort:locale==="be"?"Па змаўчанні":"По умолчанию",
    prioritySort:locale==="be"?"Па прыярытэце":"По приоритету",
    regionSort:locale==="be"?"Па рэгіёне":"По региону",
  };
  return <div className="view-stack"><section className="view-heading"><div><div className="eyebrow dark">{t("sources.eyebrow")}</div><h2>{t("sources.title")}</h2><p>{t("sources.subtitle")}</p></div><div className="sources-heading-controls"><PeriodSelector value={period} onChange={setPeriod}/>{isLMonitor&&<label className="sources-sort-control"><span>{sx.sortLabel}</span><select value={sort} onChange={e=>setSort(e.target.value as SourceSort)}><option value="default">{sx.defaultSort}</option><option value="priority">{sx.prioritySort}</option><option value="region">{sx.regionSort}</option></select></label>}<div className="compact-search"><span>⌕</span><input value={query} onChange={e=>setQuery(e.target.value)} placeholder={t("sources.search")}/></div></div></section>{error&&<div className="notice error">{error}</div>}<section className="panel source-table-panel"><div className="panel-head"><div><h3>{loading?"…":t("sources.count",{count:filtered.length})}</h3><p>{t("sources.help")}</p></div></div><div className="table-wrap sources-table-wrap"><table className="sources-table"><thead><tr><th>{t("sources.source")}</th><th>{t("sources.type")}</th><th>{t("sources.priority")}</th><th>{t("sources.region")}</th><th>{t("sources.publications")}</th><th>{t("sources.runResults")}</th><th>{t("sources.access")}</th><th>{t("sources.admission")}</th></tr></thead><tbody>{filtered.map(item=><tr key={item.id}><td><b>{item.name}</b><small>{item.domain??"—"}</small></td><td>{localizeDataLabel(item.sourceType,locale,"sourceType")}</td><td>{item.priority??"—"}</td><td>{localizeDataLabel(item.region,locale,"region")}{item.locality&&item.locality!==item.region?<small>{item.locality}</small>:null}</td><td>{item.publications}</td><td>{item.totalResults}</td><td><span className="status-pill">{localizeDataLabel(item.accessStatus,locale,"accessStatus")}</span></td><td><span className="status-pill muted">{localizeDataLabel(item.admissionStatus,locale,"admissionStatus")}</span></td></tr>)}</tbody></table></div></section></div>;
}
