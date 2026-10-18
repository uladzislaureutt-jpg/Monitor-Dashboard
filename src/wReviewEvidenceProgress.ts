// W-Review Evidence progress is per publication, never per whole request.
// Pure helpers intentionally keep resume logic independent of React state.
export type EvidenceProgressItem={
  evidence:string;
  evidenceContract?:number;
  editorialText:string;
};
export function isEvidencePrepared(item:EvidenceProgressItem,contractVersion:number):boolean{
  return Boolean(item.evidence.trim() && item.evidenceContract===contractVersion);
}
export function pendingEvidenceEntries<T extends EvidenceProgressItem>(
  items:T[],contractVersion:number
):Array<{item:T;index:number}>{
  return items.map((item,index)=>({item,index}))
    .filter(({item})=>!isEvidencePrepared(item,contractVersion));
}
