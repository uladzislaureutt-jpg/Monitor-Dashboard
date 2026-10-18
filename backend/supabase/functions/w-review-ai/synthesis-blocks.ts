// Internal block boundaries are diagnostic metadata, never visible headings.
export type SynthesisBlock = {id:string;title:string;targetChars:number;paragraphs:number};
export function synthesisResponseSchema(plan:SynthesisBlock[]){
  return {type:"object",properties:{
    blocks:{type:"array",minItems:plan.length,maxItems:plan.length,items:{type:"object",
      properties:{block_id:{type:"string",enum:plan.map(b=>b.id)},
        paragraphs:{type:"array",minItems:1,items:{type:"string"}}},
      required:["block_id","paragraphs"],additionalProperties:false}},
    section_titles:{type:"array",items:{type:"string"},maxItems:2},
    bold_phrases:{type:"array",items:{type:"string"},maxItems:4}
  },required:["blocks","section_titles","bold_phrases"],additionalProperties:false};
}
const paragraphs=(value:unknown):string[]=>Array.isArray(value)
  ?value.filter((p):p is string=>typeof p==="string").map(p=>p.trim()).filter(Boolean):[];
export function readSynthesisBlocks(raw:any,plan:SynthesisBlock[]){
  const warnings:string[]=[],metrics:{id:string;target_chars:number;actual_chars:number;paragraphs:number}[]=[];
  if(!Array.isArray(raw?.blocks)||!raw.blocks.length){
    warnings.push("Модель не вернула разметку сюжетов: проверить объём каждого блока автоматически невозможно.");
    return {paragraphs:paragraphs(raw?.paragraphs),warnings,metrics};
  }
  const all:string[]=[],found=new Map<string,string[]>(),counts=new Map<string,number>();
  const order:string[]=[];
  // Preserve all prose in model order, even malformed/unknown/duplicate blocks.
  // Never fabricate missing content or silently delete a useful draft.
  for(const block of raw.blocks){
    const id=typeof block?.block_id==="string"?block.block_id:"";
    const content=paragraphs(block?.paragraphs);
    all.push(...content);order.push(id);
    counts.set(id,(counts.get(id)||0)+1);
    found.set(id,[...(found.get(id)||[]),...content]);
  }
  const expected=new Set(plan.map(b=>b.id));
  if(order.some(id=>!expected.has(id)))warnings.push("В ответе есть блок с неизвестным обозначением; его текст сохранён.");
  if([...counts.values()].some(n=>n>1))warnings.push("Модель повторила обозначение блока; проверьте текст на повторы.");
  const recognized=order.filter(id=>expected.has(id));
  if(recognized.some((id,i)=>id!==plan[i]?.id))warnings.push("Порядок или состав блоков отличается от плана; текст сохранён в порядке модели.");
  for(const b of plan){
    const content=found.get(b.id)||[],actual=content.join("\n\n").length;
    metrics.push({id:b.id,target_chars:b.targetChars,actual_chars:actual,paragraphs:content.length});
    if(!actual)warnings.push(`Блок «${b.title}» отсутствует в разметке ответа; проверьте раскрытие сюжета.`);
    else if(actual<Math.round(b.targetChars*0.8))warnings.push(`Блок «${b.title}»: ${actual} знаков при плане около ${b.targetChars}; проверьте полноту раскрытия.`);
  }
  return {paragraphs:all,warnings,metrics};
}
