import type { WEvidenceData } from "./wReviewAi";

// A conservative regression signal, not a claim that more records are truer.
// Only compare extraction of exactly the same source text and Evidence version.
export function evidenceRegression(previous:WEvidenceData|undefined,next:WEvidenceData):boolean{
  if(!previous||previous.version!==2||next.version!==2||!previous.source_sha256||
     previous.source_sha256!==next.source_sha256)return false;
  const before=previous.records.length,after=next.records.length;
  const oldCoverage=previous.validation?.covered_passages||0;
  const newCoverage=next.validation?.covered_passages||0;
  return (before-after>=3&&after<before*0.8)||
    (oldCoverage-newCoverage>=3&&newCoverage<oldCoverage*0.75);
}
