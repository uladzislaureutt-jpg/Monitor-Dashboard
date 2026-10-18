// Safe structural salvage for W-Review editorial maps.
// Never invent evidence, never invent model conclusions, never change full cards.
// Only existing Evidence v2 IDs are allowed. Missing publications need model
// repair; their priority is never inferred from the omission.
import {evidenceIndex, isRussianDossierProse, normalizeDossier} from "./editorial-dossier.ts";

const trim=(v:unknown,n=450)=>String(v??"").trim().slice(0,n);
// Formatting-only canonicalization. A reconstructed ID is accepted strictly
// when that exact evidence record exists in the current pool. E99 is NEVER
// changed to E01 or attributed to another source.
export function canonicalEvidenceId(raw:unknown, valid:Map<string,unknown>):string{
  const value=trim(raw,65);
  if(valid.has(value))return value;
  const m=value.match(/^P\s*0*(\d{1,2})\s*[:.\/-]\s*E\s*0*(\d{1,3})$/i);
  if(!m)return "";
  const id="P"+String(Number(m[1])).padStart(2,"0")+":E"+String(Number(m[2])).padStart(2,"0");
  return valid.has(id)?id:"";
}
function canonicalUrl(card:string):string{
  return trim(card.match(/^URL:\s*(https?:\/\/\S+)/m)?.[1],1300)
    .replace(/#.*$/,"").replace(/\/$/,"").toLowerCase();
}
export type DossierRepairResult={
  draft:any;repaired:boolean;removedBranches:number;
  additionalSources:string[];discardedEvidenceRefs:number;
};
// A deterministic rescue is allowed only for a parseable Russian draft with at
// least one genuinely anchored main trend. Other failures need a provider.
export function reconcileDossierDraft(raw:any,cards:string[]):DossierRepairResult|null{
  const ix=evidenceIndex(cards);
  if(!raw||!Array.isArray(raw.trends)||!raw.trends.length||raw.trends.length>5||!ix.entries.length)
    return null;

  const trends:any[]=[];
  let removedBranches=0,discardedEvidenceRefs=0;
  const linked=new Set<string>();
  for(const t of raw.trends){
    if(!t||!Array.isArray(t.branches)||!isRussianDossierProse(t.title)||
       !isRussianDossierProse(t.summary)||!isRussianDossierProse(t.thesis))return null;
    const branches:any[]=[];
    for(const b of t.branches.slice(0,9)){
      if(!b||!Array.isArray(b.evidence_ids))return null;
      const rawRefs=b.evidence_ids.map((v:unknown)=>trim(v,65));
      const rawContrary=Array.isArray(b.contrary_evidence_ids)?
        b.contrary_evidence_ids.map((v:unknown)=>trim(v,65)):[];
      const invalid=rawRefs.concat(rawContrary).filter((id:string)=>!canonicalEvidenceId(id,ix.byId));
      const refs=rawRefs.map((id:string)=>canonicalEvidenceId(id,ix.byId)).filter(Boolean);
      const contrary=rawContrary.map((id:string)=>canonicalEvidenceId(id,ix.byId)).filter(Boolean);
      // Do NOT reattach a different record to a branch whose cited support
      // is fabricated. Discard the entire branch instead.
      if(!refs.length||invalid.length||refs.length>18||contrary.length>12){
        removedBranches++;
        discardedEvidenceRefs+=invalid.length;
        continue;
      }
      if(!isRussianDossierProse(b.title)||!isRussianDossierProse(b.claim)||
         !isRussianDossierProse(b.significance))return null;
      for(const key of ["mechanism","counterpoint","limitation"]){
        const v=trim(b[key]);
        if(v&&!isRussianDossierProse(v))return null;
      }
      const valid={...b,evidence_ids:[...new Set(refs)],
        contrary_evidence_ids:[...new Set(contrary)],
        priority:["high","medium","low"].includes(b.priority)?b.priority:"medium",
        required:typeof b.required==="boolean"?b.required:true};
      refs.concat(contrary).forEach((id:string)=>linked.add(id));
      branches.push(valid);
    }
    if(branches.length){
      trends.push({...t,branches,
        operator_optional:t.operator_optional===true,
        optional_reason:t.operator_optional===true?trim(t.optional_reason,300):""});
    }
  }
  if(!trends.length||!trends.some(t=>t.operator_optional!==true))return null;
  // Genuine URL duplicates may remain unlinked; reports on the same event
  // from DIFFERENT URLs are independent and require their own evidence.
  const priorUrls=new Map<string,string>();
  const duplicated=new Set<string>();
  for(let i=0;i<cards.length;i++){
    const pub=ix.publications[i],url=canonicalUrl(cards[i]);
    if(url&&priorUrls.has(url)&&
      [...linked].some(ref=>ref.startsWith(priorUrls.get(url)+":")))
      duplicated.add(pub);
    else if(url&&!priorUrls.has(url))priorUrls.set(url,pub);
  }
  const missing=ix.publications.filter(pub=>!duplicated.has(pub)&&
    ![...linked].some(id=>id.startsWith(pub+":")));
  // A missing source is NOT proof of editorial irrelevance. When the model
  // returns a substantive, partly grounded map, keep its authentic branches;
  // for genuinely unassigned publications add ONE EXPLICIT REVIEW QUEUE with
  // exact Evidence v2 facts. Never call it a peripheral editorial trend or
  // infer publication priority; it remains OFF until the operator chooses.
  const allAdded:string[]=[];
  if(missing.length){
    if(trends.length>=5||missing.length>9)return null;
    const waiting:any[]=[];
    for(const pub of missing){
      const proven=ix.entries.filter(e=>e.publication===pub&&e.kind!=="headline"&&
        isRussianDossierProse(e.summary));
      const row=proven[0];
      if(!row)return null;
      waiting.push({id:"B"+(waiting.length+1),
        title:"Материал "+pub+" — "+row.source,
        claim:trim(row.summary,550),mechanism:"",counterpoint:"",limitation:"",
        significance:"Материал подтверждён, но модель не распределила его по аналитическим сюжетам.",
        priority:"medium",required:false,evidence_ids:[row.id],contrary_evidence_ids:[]});
      linked.add(row.id);allAdded.push(pub);
    }
    trends.push({
      id:"T"+(trends.length+1),
      title:"Публикации для редакционного распределения",
      summary:"Материалы присутствуют в доказательной базе, но не получили достоверных ссылок в построенных сюжетах.",
      thesis:"Их значимость и принадлежность к тенденциям устанавливает оператор, а не автоматическая классификация.",
      operator_optional:true,
      optional_reason:"Техническая подборка нераспределённых публикаций. Это не оценка их второстепенности: проверьте и включите значимые материалы.",
      branches:waiting
    });
  }
  // Publication disposition derives only from actual validated branch refs,
  // not the model's unsupported classifications.
  const previous=Array.isArray(raw.coverage)?raw.coverage:[];
  const coverage=ix.publications.map(pub=>{
    const original=previous.find((v:any)=>v?.publication_id===pub);
    const refs=[...linked].filter(ref=>ref.startsWith(pub+":"));
    const isDuplicate=duplicated.has(pub)&&!refs.length;
    let reason=trim(original?.reason,300);
    if(allAdded.includes(pub))
      reason="Публикация выделена для редакционного распределения, поскольку модель не подтвердила её сюжетную привязку.";
    else if(!isRussianDossierProse(reason))
      reason="Материал подтверждает соответствующую сюжетную ветку проверенными доказательствами.";
    return {publication_id:pub,status:isDuplicate?"duplicate":
      original?.status==="supporting"||allAdded.includes(pub)?"supporting":"used",reason};
  });
  const draft={trends,coverage,inventory:raw.inventory||{quotes:0,headlines:0,experts:0}};
  const verified=normalizeDossier(draft,cards,{requireEveryDistinctSource:true});
  if(verified.error||!verified.dossier)return null;
  return {draft,repaired:missing.length>0||removedBranches>0,
    removedBranches,additionalSources:allAdded,discardedEvidenceRefs};
}
