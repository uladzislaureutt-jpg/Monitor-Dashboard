// W-Review deterministic output integrity. This is NOT an AI rewrite.
// Pxx is a private pool address and must never appear as a source name.
// We only replace exact, independently indexed Pxx labels using the very
// Evidence Cards supplied for this specific synthesis request.
export type WReviewOutputGuard={
  text:string;substitutions:number;unresolved:string[];
  attributionWarnings:string[];
};
const strip=(s:string)=>s.trim().replace(/^«|»$/g,"").trim();
// Canonicalize known outlet labels, never the underlying article URL.
// CFR publishes at cfr.org; the trailing slash is not part of its name.
export function canonicalWReviewSourceName(value:string):string{
  const raw=strip(value).replace(/^["“”]|["“”]$/g,"");
  const noTrailingSlash=/^(?:[a-z0-9-]+\.)+[a-z]{2,24}\/+$/i.test(raw)
    ? raw.replace(/\/+$/,""):raw;
  return /^cfr\.org$/i.test(noTrailingSlash)?"CFR.org":noTrailingSlash;
}
export function poolSourceNames(cards:string[]):Map<string,string>{
  const sources=new Map<string,string>();
  for(let index=0;index<cards.length;index++){
    const id="P"+String(index+1).padStart(2,"0");
    const reported=cards[index].match(/^ИСТОЧНИК:\s*(.+)$/m)?.[1]||"";
    const name=canonicalWReviewSourceName(reported);
    if(name&&name!=="Источник"&&name.length<=300) sources.set(id,name);
  }
  return sources;
}
// Existing source metadata travels with each card. Unknown regions are never
// inferred from domain/language or subject; the check is advisory only.
const geoGroups=[
  {country:"Россия",group:/российск/iu,origin:/^россия$|^рф$/iu},
  {country:"Беларусь",group:/белорусск|беларуск/iu,origin:/^беларусь$/iu},
  {country:"США",group:/американск/iu,origin:/^сша$|^соединённые штаты$|^соединенные штаты$/iu},
  {country:"Великобритания",group:/британск/iu,origin:/^великобритания$|^соединённое королевство$/iu},
  {country:"Украина",group:/украинск/iu,origin:/^украина$/iu},
  {country:"Польша",group:/польск/iu,origin:/^польша$/iu},
  {country:"Германия",group:/немецк|германск/iu,origin:/^германия$/iu},
  {country:"Франция",group:/французск/iu,origin:/^франция$/iu},
  {country:"Китай",group:/китайск/iu,origin:/^китай$/iu},
  {country:"Япония",group:/японск/iu,origin:/^япония$/iu},
  {country:"Индия",group:/индийск/iu,origin:/^индия$/iu},
  {country:"Турция",group:/турецк/iu,origin:/^турция$/iu},
  {country:"Израиль",group:/израильск/iu,origin:/^израиль$/iu},
  {country:"Казахстан",group:/казахстанск/iu,origin:/^казахстан$/iu},
  {country:"Италия",group:/итальянск/iu,origin:/^италия$/iu},
  {country:"Австрия",group:/австрийск/iu,origin:/^австрия$/iu},
  {country:"Швейцария",group:/швейцарск/iu,origin:/^швейцария$/iu},
  {country:"Чехия",group:/чешск/iu,origin:/^чехия$/iu},
  {country:"Канада",group:/канадск/iu,origin:/^канада$/iu},
  {country:"Австралия",group:/австралийск/iu,origin:/^австралия$/iu}
];
export function inspectReviewAttribution(text:string,cards:string[]=[]):string[]{
  const warnings:string[]=[];
  const paragraphs=text.split(/\n\s*\n/);
  const origins=cards.map((card,index)=>({
    name:poolSourceNames(cards).get("P"+String(index+1).padStart(2,"0"))||"",
    region:(card.match(/^КАТАЛОЖНЫЙ_РЕГИОН:\s*(.*)$/m)?.[1]||"").trim()
  })).filter(x=>x.name&&x.region);
  for(let i=0;i<paragraphs.length;i++){
    const paragraph=paragraphs[i];
    // Check only local spans near national-media group expressions, not all
    // sources mentioned elsewhere in the paragraph.
    for(const m of paragraph.matchAll(/([А-Яа-яЁё-]+)\s+(?:СМИ|медиа|издания|газеты|агентства|ресурсы|пресса|печать)/giu)){
      const given=geoGroups.find(g=>g.group.test(m[1]));
      if(!given)continue;
      const immediate=paragraph.slice(m.index,m.index+220).toLocaleLowerCase("ru");
      for(const source of origins){
        const actual=geoGroups.find(g=>g.origin.test(source.region));
        if(!actual||given===actual)continue;
        if(immediate.includes(source.name.toLocaleLowerCase("ru")))
          warnings.push("Абзац "+(i+1)+": национальная атрибуция «"+
            m[0]+"» не соответствует источнику «"+source.name+"» ("+
            actual.country+"). Проверьте контекст: источник и цитируемый участник — не одно и то же.");
      }
    }
    if(/\bP\d{2}(?::E\d+)?\b/.test(paragraph))
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
  const marked=text.replace(/«(P\d{2})»|\b(P\d{2})\b(?!:E\d+)/g,(full,q,b)=>{
    const id=q||b,source=sources.get(id);
    if(!source){unresolved.add(id);return full;}
    substitutions++;
    return "«"+source+"»";
  });
  // Also fix model-written citations, not only internal Pxx substitutions.
  // Limit the rewrite to quoted outlet names, never URLs or other prose.
  const fixed=sources.size&&[...sources.values()].includes("CFR.org")
    ?marked.replace(/«\s*cfr\.org\/+\s*»|«\s*cfr\.org\s*»/gi,"«CFR.org»")
    :marked;
  for(const m of fixed.matchAll(/\bP\d{2}(?::E\d+)?\b/g))unresolved.add(m[0]);
  const attributionWarnings=inspectReviewAttribution(fixed,cards);
  if(unresolved.size)attributionWarnings.push("Не удалось разрешить обозначения: "+[...unresolved].join(", ")+". Проверьте источники перед экспортом.");
  return {text:fixed,substitutions,unresolved:[...unresolved],attributionWarnings};
}
export function minimumParagraphChars(targetChars:number,minParagraphs:number):number{
  // Approximate 2 characters for each blank line. Strictly documented
  // count will still be checked after generation; no artificial padding.
  const total=Math.round(targetChars*0.95),count=Math.max(1,minParagraphs);
  return Math.max(80,Math.ceil((total-(count-1)*2)/count));
}


// Advisory only. Detect literal copying from STYLE_ONLY examples without
// deleting or rewriting prose and without calling another AI provider.
// Only numeric counts and a generic paragraph warning leave the server.
const editorialWords=(text:string)=>text.toLocaleLowerCase("ru")
  .replace(/ё/g,"е").match(/[\p{L}\p{N}]+/gu)||[];
export function inspectStyleOnlyCopy(reviewText:string,
  excerpts:{text:string}[],minConsecutiveWords=16):string[]{
  if(!reviewText||!excerpts?.length)return [];
  const size=Math.max(12,Math.min(40,Math.floor(minConsecutiveWords)));
  const samples=new Set<string>();
  for(const example of excerpts){
    const words=editorialWords(String(example?.text||""));
    for(let i=0;i<=words.length-size;i++){
      const part=words.slice(i,i+size).join(" ");
      if(part.length>=70)samples.add(part);
    }
  }
  if(!samples.size)return [];
  const warnings:string[]=[];
  const paragraphs=reviewText.split(/\n\s*\n/).filter(Boolean);
  for(let i=0;i<paragraphs.length;i++){
    const words=editorialWords(paragraphs[i]);
    const overlap=words.some((_,start)=>start<=words.length-size&&
      samples.has(words.slice(start,start+size).join(" ")));
    if(overlap)warnings.push("Абзац "+(i+1)+
      ": обнаружен длинный дословный фрагмент из STYLE_ONLY; "+
      "проверьте самостоятельность формулировки. Текст не изменён.");
  }
  return warnings;
}
