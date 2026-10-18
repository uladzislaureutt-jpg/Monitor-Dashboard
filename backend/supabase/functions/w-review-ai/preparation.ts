import { parseModelJsonObject, type GeminiJsonMode } from "./gemini-routing.ts";
import { verifyEvidenceCardsIndividually, evidenceQualityWarnings, type EvidenceDocument, type EvidenceCard } from "./evidence-v2.ts";

export type PreparationReply = {ok:true;content:string;usage:{prompt_tokens:number;completion_tokens:number;total_tokens:number};finish_reason?:string;reasoning_tokens?:number} |
  {ok:false;status:number;retryAfter:string|null;detail:string;diagnostic?:{kind:string;retryable:boolean}};
export function preparationBudget(deadline:number,ceiling:number,now=Date.now()) {
  return Math.max(0,Math.min(ceiling,deadline-now-3000));
}
const unavailable = ():PreparationReply => ({ok:false,status:504,retryAfter:null,detail:"preparation_deadline"});
// A schema compatibility failure is local to this request/format, not proof
// that the model is unavailable for all operators or for the editorial map.
export async function structuredGeminiRequest(input:{
  initialMode?:GeminiJsonMode;
  deadline:number; call:(mode:GeminiJsonMode,timeout:number)=>Promise<PreparationReply>;
  log?:(event:Record<string,unknown>)=>void;
  sleep?:(ms:number)=>Promise<void>;
}):Promise<PreparationReply>{
  const sleep=input.sleep||((ms:number)=>new Promise(r=>setTimeout(r,ms)));
  let mode:GeminiJsonMode=input.initialMode||"schema",transientRetried=false,shapeRetried=false;
  for(let attempt=0;attempt<4;attempt++){
    const budget=preparationBudget(input.deadline,35000);
    if(budget<1500)return unavailable();
    const result=await input.call(mode,budget);
    input.log?.({format:mode,status:result.ok?200:result.status,
      finish_reason:result.ok?result.finish_reason||"unknown":"",
      response_chars:result.ok?result.content.length:0,
      completion_tokens:result.ok?result.usage.completion_tokens:0,
      reasoning_tokens:result.ok?result.reasoning_tokens||0:0,
      cause:result.ok?"":result.diagnostic?.kind||result.detail});
    if(result.ok){
      // Truncation is handled by splitting Evidence, never by repeating a
      // full batch or pretending that a salvaged prefix is complete.
      if(/MAX_TOKENS|length/i.test(result.finish_reason||""))return result;
      if(parseModelJsonObject(result.content))return result;
      if(!shapeRetried&&mode!=="json") {mode="json";shapeRetried=true;continue;}
      return result;
    }
    if(result.status===400&&mode!=="json"){
      mode=mode==="schema"?"legacy_schema":"json";
      continue;
    }
    const hint=String(result.retryAfter||"");
    const seconds=/^\d+(?:\.\d+)?s?$/.test(hint)?Number(hint.replace(/s$/,"")):NaN;
    const minuteRetry=result.status===429&&result.diagnostic?.retryable===true&&seconds<=8;
    const temporary=[500,502,503,504].includes(result.status);
    const delay=minuteRetry?Math.max(1,seconds)*1000:800;
    if(!transientRetried&&(minuteRetry||temporary)&&preparationBudget(input.deadline,35000)>delay+5000){
      transientRetried=true;await sleep(delay);continue;
    }
    return result;
  }
  return unavailable();
}

export type PreparedArticle={index:number;card:EvidenceCard;model:string;warnings:string[]};
export async function prepareEvidence(input:{
  documents:EvidenceDocument[];deadline:number;cloudflareFirst?:boolean;
  generate:(provider:"primary"|"cloudflare"|"fallback"|"groq",documents:EvidenceDocument[],deadline:number)=>Promise<{reply:PreparationReply;model:string}>;
  available:{primary:boolean;cloudflare:boolean;fallback:boolean;groq:boolean};
  log?:(event:Record<string,unknown>)=>void;
}){
  const start=Date.now(),best=new Map<number,PreparedArticle>();
  const usage={prompt_tokens:0,completion_tokens:0,total_tokens:0};
  const attempts:Array<Record<string,unknown>>=[];
  const remaining=()=>input.documents.map((_,i)=>i).filter(i=>!best.has(i)||best.get(i)!.warnings.length>0);
  async function attempt(provider:"primary"|"cloudflare"|"fallback"|"groq",indices:number[],deadline:number){
    if(!indices.length||preparationBudget(deadline,35000)<2000)return;
    const docs=indices.map((i,index)=>({...input.documents[i],index}));
    const {reply,model}=await input.generate(provider,docs,deadline);
    if(reply.ok){
      for(const k of ["prompt_tokens","completion_tokens","total_tokens"] as const)usage[k]+=reply.usage[k]||0;
      const parsed=parseModelJsonObject(reply.content);
      // Complete individual cards can survive a failed peer, but incomplete JSON cannot.
      const checked=verifyEvidenceCardsIndividually(parsed,docs);
      for(const entry of checked.accepted){
        const index=indices[entry.index],warnings=evidenceQualityWarnings(entry.card,docs[entry.index]);
        const previous=best.get(index);
        const better=!previous || warnings.length<previous.warnings.length ||
          (warnings.length===previous.warnings.length&&entry.card.records.length>=previous.card.records.length&&
           entry.card.validation.covered_passages>=previous.card.validation.covered_passages&&
           (entry.card.records.length>previous.card.records.length||entry.card.validation.covered_passages>previous.card.validation.covered_passages));
        if(better)best.set(index,{index,card:entry.card,model,warnings});
      }
      attempts.push({provider,model,status:200,articles:indices.map(i=>i+1),
        finish_reason:reply.finish_reason||"unknown",accepted:checked.accepted.length,
        response_shape:{parsed_object:Boolean(parsed),cards_array:Array.isArray(parsed?.cards),
          cards_count:Array.isArray(parsed?.cards)?parsed.cards.length:0,
          indices:Array.isArray(parsed?.cards)?parsed.cards.slice(0,2).map((c:any)=>
            typeof c?.index==="number"&&Number.isInteger(c.index)&&c.index>=0&&c.index<=18?c.index:null):[]},
        failed:checked.failed.map(v=>({article:indices[v.index]+1,reason:v.reason}))});
    }else attempts.push({provider,model,status:reply.status,cause:reply.diagnostic?.kind||"provider_failure",articles:indices.map(i=>i+1)});
    input.log?.(attempts.at(-1)!);
    return reply;
  }
  // At most 65s on primary including format recovery and article-level repair.
  const primaryDeadline=Math.min(input.deadline,start+(input.cloudflareFirst?42000:65000));
  if(input.available.primary){
    const first=await attempt("primary",remaining(),Math.min(primaryDeadline,start+(input.cloudflareFirst?38000:35000)));
    // A useful first card is not rerun merely because its peer failed.
    if(first?.ok)for(const index of remaining())await attempt("primary",[index],primaryDeadline);
  }
  if(input.available.cloudflare)await attempt("cloudflare",remaining(),Math.min(input.deadline-18000,Date.now()+60000));
  if(input.available.fallback)await attempt("fallback",remaining(),Math.min(input.deadline,Date.now()+22000));
  if(input.available.groq)await attempt("groq",remaining(),Math.min(input.deadline,Date.now()+12000));
  return {articles:[...best.values()].sort((a,b)=>a.index-b.index),usage,attempts};
}
