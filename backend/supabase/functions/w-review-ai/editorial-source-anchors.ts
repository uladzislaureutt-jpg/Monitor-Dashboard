// Compact, source-grounded editorial anchors by selected dossier line.
// Unlike a global quote inventory, this helps the model locate direct speech
// AFTER the opening in the subject area of its source publication.
// All quotes come from Evidence v2 kind=quote and remain optional by relevance.
import type {EditorialDossier} from "./editorial-dossier.ts";
import type {EditorialQuote} from "./editorial-quotes.ts";

const pubId=(id:string)=>id.match(/^(P\d{2}):E\d{2,3}$/)?.[1]||"";
const oneLine=(s:string)=>s.replace(/\s+/g," ").trim();
export function makeEditorialSourceAnchors(
  dossier:EditorialDossier,selectedIds:string[],quotes:EditorialQuote[],
):{brief:string,anchoredQuotes:number,unanchoredQuotes:number}{
  const selected=new Set(selectedIds);
  const used=new Set<string>();
  const rows:string[]=[];
  let allocated=0;
  for(const [i,trend] of dossier.trends.filter(t=>selected.has(t.id)).entries()){
    const refs=trend.branches.flatMap(b=>b.evidence_ids.concat(b.contrary_evidence_ids));
    const pubs=new Set(refs.map(pubId).filter(Boolean));
    const candidateQuotes=quotes.filter(q=>pubs.has(pubId(q.id))&&!used.has(q.id));
    // Keep each quotation available in exactly one line, with cross-publisher
    // diversity ahead of source repetition. The model still decides topical
    // suitability by reading the quote AND the branch's evidence.
    const picks:EditorialQuote[]=[];
    const seenPublishers=new Set<string>();
    for(const q of candidateQuotes){
      if(picks.length>=4)break;
      if(!seenPublishers.has(q.source)){picks.push(q);seenPublishers.add(q.source);}
    }
    for(const q of candidateQuotes){
      if(picks.length>=4)break;
      if(!picks.some(x=>x.id===q.id))picks.push(q);
    }
    picks.forEach(q=>used.add(q.id));allocated+=picks.length;
    const focus=trend.branches.map(b=>oneLine(b.title)+
      (b.counterpoint?" / заявленное противоречие: "+oneLine(b.counterpoint):"")).join("; ");
    rows.push("БЛОК line_"+(i+1)+" — "+oneLine(trend.title)+
      "\nСМЫСЛОВЫЕ ЛИНИИ: "+focus+
      "\nПРОВЕРЕННЫЕ КАНДИДАТЫ НА ПРЯМУЮ РЕЧЬ ИЗ ПУБЛИКАЦИЙ ЭТОГО БЛОКА:\n"+
      (picks.length?picks.map(q=>
        q.id+" / «"+q.source+"» / "+(q.speaker?"говорящий: "+q.speaker:"говорящий неизвестен")+
        (q.role?" ("+q.role+")":"")+
        " / дословный RU: «"+q.quoteRu+"»").join("\n"):
        "Нет отдельной подтверждённой прямой цитаты у связанных публикаций; используй точный заголовок или атрибутированный факт, без псевдоцитат."));
  }
  const brief="РЕДАКЦИОННЫЕ ЯКОРЯ ДЛЯ ОСНОВНОЙ ЧАСТИ — ИСПОЛЬЗУЙ ПОСЛЕ УДАЧНОГО ЗАЧИНА:\n"+
    "В каждом смысловом ходе не пересказывай подряд события: возьми значимую оригинальную формулировку СМИ или подтверждённую цитату эксперта/политика, затем раскрой факт и сопоставь с ДРУГОЙ публикацией, если её аргумент действительно отличается. "+
    "Это кандидаты по принадлежности публикации к линии, а не гарантия, что слова относятся к конкретной ветке: сначала проверь смысл цитаты по Evidence, затем цитируй дословно либо не используй. "+
    "Если в источниках нет подтверждённого возражения одному тезису, допустимо сопоставить разные политические аргументы без объявления одного опровержением другого. "+
    "Не приписывай слова собеседника редакции. Не превращай каждый абзац в цитатный шаблон и не жертвуй содержательной полнотой. "+
    "Используй краткую смысловую часть длинной цитаты только при дословном непрерывном совпадении с RU; никакого монтажа фрагментов.\n\n"+
    (rows.join("\n\n")||"Нет выбранных содержательных линий.");
  return {brief,anchoredQuotes:allocated,unanchoredQuotes:quotes.length-allocated};
}
