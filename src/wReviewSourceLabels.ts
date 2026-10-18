// Presentation-only mapping for already saved W-Review drafts.
// Keeps the operator's editor text untouched. Every replacement must have a
// direct corresponding item at that exact pool index; otherwise export blocks.
export function resolvePoolMarkersForExport(
  reviewText:string,items:Array<{source:string}>
):{text:string;replaced:number;unresolved:string[]}{
  const byIndex=new Map<string,string>();
  for(let i=0;i<items.length;i++){
    const id="P"+String(i+1).padStart(2,"0");
    let source=String(items[i].source||"").trim().replace(/^«|»$/g,"");
    if(/^(?:[a-z0-9-]+\.)+[a-z]{2,24}\/+$/i.test(source))
      source=source.replace(/\/+$/,"");
    if(source)byIndex.set(id,source);
  }
  const missing=new Set<string>();
  let replaced=0;
  const text=reviewText.replace(/«(P\d{2})»|\b(P\d{2})\b(?!:E\d+)/g,(m,q,b)=>{
    const id=q||b,name=byIndex.get(id);
    if(!name){missing.add(id);return m;}
    replaced++;return "«"+name+"»";
  });
  for(const m of text.matchAll(/\bP\d{2}(?::E\d+)?\b/g))missing.add(m[0]);
  return {text,replaced,unresolved:[...missing]};
}
