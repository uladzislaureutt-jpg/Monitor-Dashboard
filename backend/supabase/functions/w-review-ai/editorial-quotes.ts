// W-Review: deterministic editorial quote inventory from already validated Evidence v2.
// Zero external calls, zero new facts. Source excerpts alone are NEVER transformed
// into attributed direct speech: only records with kind=quote and checked ORIGINAL.
export type EditorialQuote={
  id:string;source:string;quoteRu:string;original:string;speaker:string;role:string;
};
const clean=(s:string)=>String(s||"").trim().replace(/\s+/g," ");
const canonical=(s:string)=>/^cfr\.org\/?$/i.test(s.trim())?"CFR.org":s.trim();

export function editorialQuoteInventory(cards:string[]):EditorialQuote[]{
  const candidates:EditorialQuote[]=[];
  const seen=new Set<string>();
  cards.forEach((card,idx)=>{
    const pub="P"+String(idx+1).padStart(2,"0");
    const source=canonical(clean(card.match(/^ИСТОЧНИК:\s*«([^»]+)»/m)?.[1]||""));
    if(!source)return;
    for(const line of card.split(/\r?\n/)){
      // Only E## [quote/P###] entries. A SOURCE excerpt from a fact record
      // is evidence of the fact, not authorization to manufacture a quotation.
      const match=line.match(/^(E\d{2}) \[quote\/[A-Z0-9]+\] [\s\S]*? \| ORIGINAL: «(.+?)» \| RU: «(.+?)» \| SPEAKER: (.*)$/);
      if(!match)continue;
      const original=clean(match[2]),quoteRu=clean(match[3]);
      if(original.length<12||quoteRu.length<18||quoteRu.length>450)continue;
      const speakerRole=clean(match[4]);
      const split=speakerRole.match(/^(.*?)\s*\(([^()]*)\)$/);
      const speaker=clean(split?split[1]:speakerRole),role=clean(split?split[2]:"");
      const dedup=quoteRu.toLocaleLowerCase("ru-RU").replace(/[^\p{L}\p{N}]/gu,"");
      if(dedup.length<14||seen.has(dedup))continue;
      seen.add(dedup);
      candidates.push({id:pub+":"+match[1],source,quoteRu,original,speaker,role});
    }
  });
  return candidates;
}
export function editorialQuoteTarget(candidates:number,requestedChars:number,density:string):number{
  if(!candidates||density==="minimum")return Math.min(candidates,1);
  if(density==="all")return Math.min(candidates,12);
  const desired=density==="many"
    ?Math.max(4,Math.ceil(requestedChars/1200))
    :Math.max(3,Math.ceil(requestedChars/1500));
  return Math.min(candidates,Math.min(10,desired));
}
export function editorialQuoteBrief(candidates:EditorialQuote[],target:number):string{
  if(!candidates.length){
    return "РЕЕСТР ДОСЛОВНЫХ ЦИТАТ ПУСТ: в предоставленных Evidence v2 нет ни одной проверенной записи kind=quote с русским текстом цитаты. Запрещено создавать псевдоцитаты из пересказов, новостных заголовков и собственных обобщений. Сообщи об этом только в диагностике; не добавляй пояснение в сам обзор.";
  }
  const selected:EditorialQuote[]=[];
  const usedSources=new Set<string>();
  // Maximize source diversity before repeating the same publication.
  for(const q of candidates){
    if(selected.length>=14)break;
    if(!usedSources.has(q.source)){selected.push(q);usedSources.add(q.source);}
  }
  for(const q of candidates){
    if(selected.length>=14)break;
    if(!selected.includes(q))selected.push(q);
  }
  return "РЕЕСТР ДОПУСТИМЫХ ПРЯМЫХ ЦИТАТ ИЗ EVIDENCE v2 (внутренние ID не выводить):\n"+
    selected.map(q=>q.id+" / «"+q.source+"» / автор слов: "+(q.speaker||"не установлен")+
      (q.role?" ("+q.role+")":"")+" / текст для цитирования на русском: «"+q.quoteRu+"»").join("\n")+
    "\nОТБОР ПО СМЫСЛУ, БЕЗ ЧИСЛОВОЙ КВОТЫ: сперва выбери формулировку, которая действительно раскрывает основной акцент нескольких СМИ; далее ищи подлинную контрцитату, если она отражает противоположный аргумент. В других смысловых блоках вплетай точные цитаты как доказательства, а не декоративные вставки."+
    " Цитата эксперта или политика не равна собственной позиции издания. Если автор не установлен, не приписывай слова редакции без оснований. Не меняй текст цитаты и не комбинируй разрозненные фрагменты.";
}
export function editorialQuoteUsage(reviewText:string,candidates:EditorialQuote[]):{
  available:number;used:number;usedIds:string[];sources:number
}{
  const compact=(s:string)=>clean(s).toLocaleLowerCase("ru-RU");
  const haystack=compact(reviewText);
  const used=candidates.filter(q=>haystack.includes("«"+compact(q.quoteRu)+"»"));
  return {available:candidates.length,used:used.length,usedIds:used.map(q=>q.id),
    sources:new Set(used.map(q=>q.source)).size};
}
