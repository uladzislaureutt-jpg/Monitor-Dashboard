// Canonical display label; publication URLs are never rewritten.
export function canonicalWReviewSourceName(raw:string):string{
  let source=String(raw||"").trim().replace(/^«|»$/g,"").trim();
  if(/^(?:[a-z0-9-]+\.)+[a-z]{2,24}\/+$/i.test(source))
    source=source.replace(/\/+$/,"");
  return /^cfr\.org$/i.test(source)?"CFR.org":source;
}

// Presentation-only mapping for already saved W-Review drafts.
// Keeps the operator's editor text untouched. Every replacement must have a
// direct corresponding item at that exact pool index; otherwise export blocks.
export function resolvePoolMarkersForExport(
  reviewText:string,items:Array<{source:string}>
):{text:string;replaced:number;unresolved:string[]}{
  const byIndex=new Map<string,string>();
  for(let i=0;i<items.length;i++){
    const id="P"+String(i+1).padStart(2,"0");
    const source=canonicalWReviewSourceName(items[i].source);
    if(source)byIndex.set(id,source);
  }
  const missing=new Set<string>();
  let replaced=0;
  const marked=reviewText.replace(/«(P\d{2})»|\b(P\d{2})\b(?!:E\d+)/g,(m,q,b)=>{
    const id=q||b,name=byIndex.get(id);
    if(!name){missing.add(id);return m;}
    replaced++;return "«"+name+"»";
  });
  // Preserve the operator's master text, but fix both old and new citations
  // in the temporary DOCX export copy, including already saved drafts.
  const text=[...byIndex.values()].includes("CFR.org")
    ? marked.replace(/«\s*cfr\.org\/+\s*»|«\s*cfr\.org\s*»/gi,"«CFR.org»")
    : marked;
  for(const m of text.matchAll(/\bP\d{2}(?::E\d+)?\b/g))missing.add(m[0]);
  return {text,replaced,unresolved:[...missing]};
}
