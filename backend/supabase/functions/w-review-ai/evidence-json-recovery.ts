import {parseModelJsonObject} from "./gemini-routing.ts";

// Evidence-specific, deterministic decoding. No language model, network,
// synthetic text, or "JSON repair" that changes record contents.
// Every recovered card still goes through independent source-anchor validation.
export type EvidenceJsonRecovery = {
  payload:unknown; method:"direct"|"wrapped"|"top_level_cards"|"single_card"|"complete_card_objects"|"unrecognized";
  recovered_cards:number;
};
const cardShaped=(v:any):boolean =>
  v!==null&&typeof v==="object"&&!Array.isArray(v)&&
  Number.isInteger(v.index)&&v.index>=0&&v.index<=18&&Array.isArray(v.records);
const isCards=(v:unknown,limit:number):v is any[] =>
  Array.isArray(v)&&v.length>0&&v.length<=limit&&v.every(cardShaped);

function collectFullyClosedCards(source:string,limit:number):any[]{
  // String-aware brace scanning. Truncated objects are NEVER completed, and
  // braces inside quoted excerpts never count as structure.
  const stack:number[]=[];const cards:any[]=[];
  let inString=false,escape=false;
  for(let i=0;i<source.length;i++){
    const c=source[i];
    if(inString){
      if(escape){escape=false;continue;}
      if(c==="\\"){escape=true;continue;}
      if(c==='"')inString=false;
      continue;
    }
    if(c==='"'){inString=true;continue;}
    if(c==="{"){stack.push(i);continue;}
    if(c!=="}"||!stack.length)continue;
    const start=stack.pop()!;
    // Limit candidate size, and avoid collecting complete 'record' objects.
    if(i-start>120_000)continue;
    let v:any;
    try{v=JSON.parse(source.slice(start,i+1));}catch{continue;}
    if(cardShaped(v))cards.push(v);
    if(cards.length>limit*5)break;
  }
  // A repeated index is ambiguous; never pick one silently.
  const duplicated=new Set<number>();
  const seen=new Set<number>();
  for(const c of cards){if(seen.has(c.index))duplicated.add(c.index);seen.add(c.index);}
  return cards.filter(c=>!duplicated.has(c.index)).slice(0,limit);
}
export function parseEvidenceJson(content:string,limit=2):EvidenceJsonRecovery {
  const text=String(content||"").trim().replace(/^\uFEFF/,"");
  if(text.length>2_000_000)return {payload:null,method:"unrecognized",recovered_cards:0};
  const unwrapped=text.replace(/^\x60{3}(?:json)?\s*/i,"").replace(/\s*\x60{3}$/,"").trim();
  // A valid TOP-LEVEL ARRAY must be handled before the generic object parser
  // which intentionally finds only its first object.
  try{
    const full=JSON.parse(unwrapped);
    if(isCards(full,limit))
      return {payload:{cards:full},method:"top_level_cards",recovered_cards:full.length};
    if(cardShaped(full))
      return {payload:{cards:[full]},method:"single_card",recovered_cards:1};
  }catch{/* damaged envelope or prefaced JSON */}
  const direct=parseModelJsonObject(text);
  if(Array.isArray(direct?.cards))
    return {payload:direct,method:"direct",recovered_cards:direct.cards.length};
  // Some JSON-mode model responses use a single extra wrapper instead of cards.
  if(direct){
    for(const key of ["result","data","output"]){
      const nested=direct[key];
      if(isCards(nested,limit))return {payload:{cards:nested},method:"wrapped",recovered_cards:nested.length};
      if(isCards(nested?.cards,limit))
        return {payload:{cards:nested.cards},method:"wrapped",recovered_cards:nested.cards.length};
    }
    if(cardShaped(direct)){
      // Do NOT trust only the first element of concatenated/card arrays.
      // The complete-card scanner detects duplicate indices and omits them.
      const completed=collectFullyClosedCards(text,limit);
      return completed.length
        ? {payload:{cards:completed},method:"complete_card_objects",recovered_cards:completed.length}
        : {payload:null,method:"unrecognized",recovered_cards:0};
    }
    return {payload:direct,method:"unrecognized",recovered_cards:0};
  }
  const cards=collectFullyClosedCards(text,limit);
  if(cards.length)return {payload:{cards},method:"complete_card_objects",recovered_cards:cards.length};
  return {payload:null,method:"unrecognized",recovered_cards:0};
}
