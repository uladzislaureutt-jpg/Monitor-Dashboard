// W-Review deterministic output integrity. This is NOT an AI rewrite.
// Pxx is a private pool address and must never appear as a source name.
// We only replace exact, independently indexed Pxx labels using the very
// Evidence Cards supplied for this specific synthesis request.
export type WReviewOutputGuard={
  text:string;substitutions:number;unresolved:string[];
  attributionWarnings:string[];
};
const strip=(s:string)=>s.trim().replace(/^«|»$/g,"").trim();
export function poolSourceNames(cards:string[]):Map<string,string>{
  const sources=new Map<string,string>();
  for(let index=0;index<cards.length;index++){
    const id="P"+String(index+1).padStart(2,"0");
    const reported=cards[index].match(/^ИСТОЧНИК:\s*(.+)$/m)?.[1]||"";
    let name=strip(reported).replace(/^["“”]|["“”]$/g,"");
    if(/^(?:[a-z0-9-]+\.)+[a-z]{2,24}\/+$/i.test(name))name=name.replace(/\/+$/,"");
    if(name&&name!=="Источник"&&name.length<=300) sources.set(id,name);
  }
  return sources;
}
export function inspectReviewAttribution(text:string):string[]{
  const warnings:string[]=[];
  const paragraphs=text.split(/\n\s*\n/);
  for(let i=0;i<paragraphs.length;i++){
    const p=paragraphs[i];
    const russianMedia=/российск(?:ие|их|ими|ой|ую|ое)\s+(?:СМИ|медиа|издания|ресурсы|пресс[а-я]*)/iu;
    if(russianMedia.test(p)&&/(?:The Guardian|cfr\.org|(?<![A-Za-z])CFR(?![A-Za-z]))/i.test(p))
      warnings.push("Абзац "+(i+1)+": «The Guardian» (Великобритания) или CFR (США) названы в контексте российских медиа. Проверьте национальную атрибуцию и смысл источников.");
    if(/\bP\d{2}(?::E\d+)?\b/.test(p))
      warnings.push("Абзац "+(i+1)+": остался неразрешённый внутренний идентификатор публикации.");
  }
  return [...new Set(warnings)];
}
export function normalizeReviewSourceLabels(text:string,cards:string[]):WReviewOutputGuard{
  const sources=poolSourceNames(cards);
  let substitutions=0;
  const unresolved=new Set<string>();
  // Explicitly quoted model mistakes («P03») and bare P03 in source lists.
  // Deliberately leave Evidence IDs P03:E04 intact for diagnostics rather
  // than turning them into fictional source names or hiding them.
  const fixed=text.replace(/«(P\d{2})»|\b(P\d{2})\b(?!:E\d+)/g,(full,q,b)=>{
    const id=q||b,source=sources.get(id);
    if(!source){unresolved.add(id);return full;}
    substitutions++;
    return "«"+source+"»";
  });
  for(const m of fixed.matchAll(/\bP\d{2}(?::E\d+)?\b/g))unresolved.add(m[0]);
  const attributionWarnings=inspectReviewAttribution(fixed);
  if(unresolved.size)attributionWarnings.push("Не удалось разрешить обозначения: "+[...unresolved].join(", ")+". Проверьте источники перед экспортом.");
  return {text:fixed,substitutions,unresolved:[...unresolved],attributionWarnings};
}
export function minimumParagraphChars(targetChars:number,minParagraphs:number):number{
  // Approximate 2 characters for each blank line. Strictly documented
  // count will still be checked after generation; no artificial padding.
  const total=Math.round(targetChars*0.95),count=Math.max(1,minParagraphs);
  return Math.max(80,Math.ceil((total-(count-1)*2)/count));
}
