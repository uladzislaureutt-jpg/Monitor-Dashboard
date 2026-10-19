// Numeric-only W-Review dossier quality telemetry.
// Never logs operator text, source URLs, titles, exact Evidence IDs or auth data.
import {evidenceIndex,type EditorialDossier} from "./editorial-dossier.ts";
const intersection=(a:Set<string>,b:Set<string>)=>[...a].filter(x=>b.has(x)).length;
export function dossierQualityMetrics(dossier:EditorialDossier,cards:string[]){
  const source=evidenceIndex(cards),allIds=new Set(source.entries.map(x=>x.id));
  const branchRows=dossier.trends.flatMap(t=>t.branches.map(b=>{
    const refs=new Set(b.evidence_ids.filter(id=>allIds.has(id)));
    const contrary=new Set(b.contrary_evidence_ids.filter(id=>allIds.has(id)));
    const all=new Set([...refs,...contrary]);
    return {ids:all,contrary,refs,overlap:intersection(refs,contrary),
      textCounterpoint:Boolean(b.counterpoint.trim()),
      references:all.size,
      pubs:new Set([...all].map(id=>source.byId.get(id)!.publication))};
  }));
  const uniqueEvidence=new Set(branchRows.flatMap(b=>[...b.ids]));
  const uniqueContrary=new Set(branchRows.flatMap(b=>[...b.contrary]));
  const pubs=new Set([...uniqueEvidence].map(id=>source.byId.get(id)!.publication));
  const nonHeadline=new Set(source.entries.filter(e=>e.kind!=="headline").map(e=>e.id));
  const refsNonHeadline=new Set([...uniqueEvidence].filter(id=>nonHeadline.has(id)));
  let duplicateCitationPairs=0,highlyOverlappingPairs=0;
  for(let i=0;i<branchRows.length;i++)for(let j=i+1;j<branchRows.length;j++){
    const a=branchRows[i].ids,b=branchRows[j].ids;
    const match=intersection(a,b),united=a.size+b.size-match;
    if(match>0)duplicateCitationPairs++;
    if(a.size>=2&&b.size>=2&&united&&match/united>=0.8)highlyOverlappingPairs++;
  }
  const countsByPub=dossier.coverage.map(x=>({
    publication_id:x.publication_id,status:x.status,
    refs:branchRows.reduce((n,b)=>n+[...b.ids].filter(id=>source.byId.get(id)!.publication===x.publication_id).length,0)
  }));
  return {
    publications_total:cards.length,source_evidence_total:source.entries.length,
    source_non_headline_total:nonHeadline.size,
    trends:dossier.trends.length,branches:branchRows.length,
    optional_trends:dossier.trends.filter(t=>t.operator_optional).length,
    mandatory_branches:dossier.trends.flatMap(t=>t.branches).filter(b=>b.required).length,
    unique_used_evidence:uniqueEvidence.size,
    unique_used_non_headline:refsNonHeadline.size,
    evidence_usage_percent:source.entries.length?
      Math.round(uniqueEvidence.size/source.entries.length*100):0,
    linked_publications:pubs.size,
    unlinked_publications:countsByPub.filter(x=>!x.refs).length,
    contrary_unique_evidence:uniqueContrary.size,
    branches_with_contrary:branchRows.filter(b=>b.contrary.size>0).length,
    // Detect the misleading pattern: one branch for every publication, each
    // made from E01 (claim) + E05 (supposed counterpoint) of the same outlet.
    branches_with_multiple_publications:branchRows.filter(b=>b.pubs.size>=2).length,
    branches_with_single_publication:branchRows.filter(b=>b.pubs.size===1).length,
    branches_with_only_one_evidence_record:branchRows.filter(b=>b.ids.size===1).length,
    cross_publication_contrary_branches:branchRows.filter(b=>
      [...b.contrary].some(id=>[...b.refs].some(main=>
        source.byId.get(id)?.publication!==source.byId.get(main)?.publication))).length,
    evidence_E01_refs:branchRows.reduce((n,b)=>n+
      [...b.ids].filter(id=>/:E01$/.test(id)).length,0),
    branches_with_counterpoint_text:branchRows.filter(b=>b.textCounterpoint).length,
    counterpoint_text_without_contrary_refs:branchRows.filter(b=>b.textCounterpoint&&!b.contrary.size).length,
    same_id_on_both_sides:branchRows.reduce((n,b)=>n+b.overlap,0),
    citation_sharing_branch_pairs:duplicateCitationPairs,
    suspicious_high_overlap_branch_pairs:highlyOverlappingPairs,
    publications_with_one_or_fewer_refs:countsByPub.filter(x=>x.refs<=1).length,
    // Privacy by design: no source identities or raw text in this diagnostic.
  };
}
