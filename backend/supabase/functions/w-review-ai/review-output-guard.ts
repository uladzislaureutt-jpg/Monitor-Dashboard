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
  const fixed=text.replace(/«(P\d{2})»|\b(P\d{2})\b(?!:E\d+)/g,(full,q,b)=>{
    const id=q||b,source=sources.get(id);
    if(!source){unresolved.add(id);return full;}
    substitutions++;
    return "«"+source+"»";
  });
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
