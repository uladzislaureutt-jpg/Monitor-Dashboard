// W-Review editorial headlines: every supplied publication has an original title.
// The dossier's AI-generated inventory.headlines counts special Evidence records,
// NOT available publication titles. These are two different quantities.
export type PublicationHeadline={
  publicationId:string;
  source:string;
  original:string;
  russian:string;
  hasRussianTranslation:boolean;
  verifiedHeadlineEvidence:boolean;
};
const clean=(s:string)=>String(s||"").replace(/\s+/g," ").trim();
const find=(card:string,key:string)=>clean(card.match(new RegExp("^"+key+":\\s*(.+)$","m"))?.[1]||"");
const titleLimit=600;
export function publicationHeadlineInventory(cards:string[]):PublicationHeadline[]{
  return cards.flatMap((card,index)=>{
    const original=(find(card,"ЗАГОЛОВОК")||find(card,"TITLE_ORIGINAL")).slice(0,titleLimit);
    if(!original||original==="Без названия")return [];
    const russian=find(card,"TITLE_RU").slice(0,titleLimit);
    const source=clean(card.match(/^ИСТОЧНИК:\s*«([^»]+)»/m)?.[1]||"");
    const verifiedHeadlineEvidence=/^E\d+\s+\[headline\/(?:TITLE|P\d+)\]\s+/m.test(card);
    return [{
      publicationId:"P"+String(index+1).padStart(2,"0"),
      source:source||"Источник",
      original,
      russian:russian||original,
      hasRussianTranslation:Boolean(russian&&russian!==original),
      verifiedHeadlineEvidence,
    }];
  });
}
export function editorialHeadlineTarget(count:number,targetChars:number,density:string):number{
  if(density==="minimum")return Math.min(count,1);
  if(density==="all")return Math.min(count,8);
  const desired=density==="many" ? Math.max(3,Math.ceil(targetChars/1600))
    :Math.max(2,Math.ceil(targetChars/3000));
  return Math.min(count,Math.min(6,desired));
}
export function editorialHeadlineBrief(headlines:PublicationHeadline[],target:number):string{
  if(!headlines.length)return "РЕЕСТР ЗАГОЛОВКОВ ПУСТ: не придумывай заголовки и не выдавай свои выводы за названия статей.";
  return [
    "ПОЛНЫЙ РЕЕСТР ОРИГИНАЛЬНЫХ ЗАГОЛОВКОВ ПУБЛИКАЦИЙ (не только специально выделенные kind=headline):",
    ...headlines.map(h=>h.publicationId+" / «"+h.source+"» / ОРИГИНАЛ: "+h.original+
      (h.hasRussianTranslation?" / TITLE_RU (предоставленный перевод, сверь с оригиналом): "+h.russian:"")+
      (h.verifiedHeadlineEvidence?" / ОТДЕЛЬНАЯ ЗАПИСЬ HEADLINE В EVIDENCE":"")),
    "РЕДАКЦИОННАЯ ЗАДАЧА: просмотри все "+headlines.length+" названий и найди среди них "+
      "по-настоящему содержательные, необычные, резкие или контрастирующие заголовки, "+
      "если они отражают выбранные сюжетные линии. Предпочти их механическому пересказу "+
      "и сопоставляй акценты редакций. Ориентир — до "+target+" уместных заголовков "+
      "без повторов, НЕ обязательная числовая квота.",
    "Отмечай, что цитируешь заголовок издания, а не слова его эксперта или журналиста из текста. "+
      "Заголовок не всегда выражает доказанную редакционную позицию: различай сообщение, "+
      "вопросительный/иронический заголовок и собственную оценку. "+
      "Точные формулировки оригинальных русскоязычных заголовков можно цитировать дословно. "+
      "Для иноязычных заголовков используй только аккуратный русский перевод без добавления "+
      "отсутствующих утверждений, по смыслу сверенный с ОРИГИНАЛОМ; если перевод нельзя "+
      "надёжно подтвердить — перескажи смысл без кавычек. "+
      "Не дополняй и не комбинируй заголовки, не выдумывай контраст ради риторики.",
  ].join("\n");
}
export function editorialHeadlineUsage(text:string,headlines:PublicationHeadline[]):{
  titlesAvailable:number;quotedTitles:number;quotedIds:string[];
}{
  const normalize=(v:string)=>clean(v).toLocaleLowerCase("ru-RU");
  const review=normalize(text);
  const quoted=headlines.filter(h=>{
    // Only explicit title quotations count; publication/source names do not.
    const readable=h.hasRussianTranslation?h.russian:h.original;
    return readable.length>=12&&review.includes("«"+normalize(readable)+"»");
  });
  return {titlesAvailable:headlines.length,quotedTitles:quoted.length,
    quotedIds:quoted.map(h=>h.publicationId)};
}
