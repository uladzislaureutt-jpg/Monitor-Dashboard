// Safe structural salvage for W-Review editorial maps.
// Never invent evidence, never invent model conclusions, never change full cards.
// Only fully verified Evidence v2 IDs are allowed; peripheral source facts remain
// separate and operator-optional. The regular dossier validator is authoritative.
import {evidenceIndex, isRussianDossierProse, normalizeDossier} from "./editorial-dossier.ts";

type Entry={publication:string;id:string;kind:string;statement:string};
const trim=(v:unknown,n=450)=>String(v??"").trim().slice(0,n);
function indexedFacts(cards:string[]):Map<string,Entry[]>{
  const facts=new Map<string,Entry[]>();
  for(let i=0;i<cards.length;i++){
    const pub="P"+String(i+1).padStart(2,"0");
    const list:Entry[]=[];
    for(const m of cards[i].matchAll(/^E(\d+)\s+\[([a-z_]+)\/(?:P\d+|TITLE)\]\s+(.+)$/gm)){
      const id=pub+":E"+m[1];
      const statement=m[3].split(" | SOURCE:")[0].trim();
      if(statement&&isRussianDossierProse(statement))
        list.push({publication:pub,id,kind:m[2],statement});
    }
    facts.set(pub,list);
  }
  return facts;
}
function publicationTitle(card:string):string{
  const original=card.match(/^TITLE_RU:\s*(.+)$/m)?.[1]||
    card.match(/^ЗАГОЛОВОК:\s*(.+)$/m)?.[1]||"";
  return trim(original,105);
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
  const facts=indexedFacts(cards);
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
  const availableSlots=5-trends.length,neededSlots=Math.ceil(missing.length/9);
  if(neededSlots>availableSlots)return null;
  const allAdded:string[]=[];
  for(let start=0;start<missing.length;start+=9){
    const pubs=missing.slice(start,start+9),branches:any[]=[];
    for(const pub of pubs){
      const candidates=facts.get(pub)||[];
      const best=candidates.find(e=>e.kind!=="headline")||candidates[0];
      // Do not treat a source title as source-backed analysis.
      if(!best||best.kind==="headline")return null;
      const idx=ix.publications.indexOf(pub);
      const title=publicationTitle(cards[idx]);
      branches.push({
        id:"B"+String(branches.length+1),title:isRussianDossierProse(title)?
          title:"Дополнительные сведения "+pub,
        claim:trim(best.statement,550),mechanism:"",counterpoint:"",
        limitation:"",significance:"Дополнительная фактура для редакционного выбора.",
        priority:"low",required:false,evidence_ids:[best.id],contrary_evidence_ids:[]
      });
      linked.add(best.id);
      allAdded.push(pub);
    }
    const labels=pubs.map(pub=>publicationTitle(cards[ix.publications.indexOf(pub)]))
      .filter(t=>isRussianDossierProse(t));
    const subject=labels.slice(0,2).map(v=>trim(v,54)).join("; ");
    trends.push({
      id:"T"+String(trends.length+1),
      title:trim(subject?"Дополнительная линия: "+subject:"Дополнительные позиции СМИ",160),
      summary:"Материалы сопутствующей тематики, предложенные для отдельного редакционного решения.",
      thesis:"Факты и позиции дополнительных публикаций рассматриваются отдельно от основных тенденций.",
      operator_optional:true,
      optional_reason:"Сопутствующая линия: оператор самостоятельно решает, включать ли её в обзор.",
      branches
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
      reason="Материал выделен в дополнительную тенденцию для выбора оператора.";
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
