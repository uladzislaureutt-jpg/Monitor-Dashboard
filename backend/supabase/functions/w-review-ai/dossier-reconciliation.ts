// Safe structural salvage for W-Review editorial maps.
// Never invent evidence, never invent model conclusions, never change full cards.
// Only existing Evidence v2 IDs are allowed. Missing publications need model
// repair; their priority is never inferred from the omission.
import {evidenceIndex, isRussianDossierProse, normalizeDossier} from "./editorial-dossier.ts";

const trim=(v:unknown,n=450)=>String(v??"").trim().slice(0,n);
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
      const refs=b.evidence_ids.map((v:unknown)=>trim(v,40));
      const contrary=Array.isArray(b.contrary_evidence_ids)?
        b.contrary_evidence_ids.map((v:unknown)=>trim(v,40)):[];
      const invalid=refs.concat(contrary).filter((id:string)=>!ix.byId.has(id));
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
  // Missing analysis is not evidence of peripheral relevance. Do not invent a
  // low-priority, disabled trend from the first fact of an omitted article.
  // The caller can repair the plan on the same model within its deadline.
  if(missing.length)return null;
  const allAdded:string[]=[];
  // Publication disposition derives only from actual validated branch refs,
  // not the model's unsupported classifications.
  const previous=Array.isArray(raw.coverage)?raw.coverage:[];
  const coverage=ix.publications.map(pub=>{
    const original=previous.find((v:any)=>v?.publication_id===pub);
    const refs=[...linked].filter(ref=>ref.startsWith(pub+":"));
    const isDuplicate=duplicated.has(pub)&&!refs.length;
    let reason=trim(original?.reason,300);
    if(!isRussianDossierProse(reason))
      reason="Материал подтверждает соответствующую сюжетную ветку проверенными доказательствами.";
    return {publication_id:pub,status:isDuplicate?"duplicate":
      original?.status==="supporting"?"supporting":"used",reason};
  });
  const draft={trends,coverage,inventory:raw.inventory||{quotes:0,headlines:0,experts:0}};
  const verified=normalizeDossier(draft,cards,{requireEveryDistinctSource:true});
  if(verified.error||!verified.dossier)return null;
  return {draft,repaired:missing.length>0||removedBranches>0,
    removedBranches,additionalSources:allAdded,discardedEvidenceRefs};
}
