// Isolated Cloudflare GPT-OSS-120B final-synthesis latency diagnostics.
// 8000-character reviews, same 18 synthetic publications / 167 Evidence,
// one varying factor at a time: strict JSON schema, compact source context,
// JSON object, and reasoning effort. Four sequential requests maximum.
// Never accesses real operator data, Supabase, payment or user generation quotas.
import {mkdirSync,writeFileSync,appendFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {synthesisFixture,outputBudget,checkReview} from "./synthesis-model-benchmark.mjs";
import {synthesisResponseSchema} from "./synthesis-blocks.ts";
import {parseModelJsonObject} from "./gemini-routing.ts";

export const TARGET=8000;
export const CASES=[
 {id:"full_object_medium",evidence:"full",format:"json_object",reasoning:"medium",timeout_ms:125000},
 {id:"full_schema_medium",evidence:"full",format:"json_schema",reasoning:"medium",timeout_ms:125000},
 {id:"compact_schema_medium",evidence:"compact",format:"json_schema",reasoning:"medium",timeout_ms:125000},
 {id:"full_schema_low",evidence:"full",format:"json_schema",reasoning:"low",timeout_ms:125000}
];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const shortSourceLine=s=>{
 if(!/^E\d{2} \[/.test(s))return s;
 // Strip repeated synthetic scaffolding, preserving original proposition
 // (including the five known opposing claims), publication-ID and Evidence-ID.
 // Do NOT trim, coalesce, reorder or fabricate source Evidence identifiers.
 let head=s.split(" Источник «")[0];
 return head.replace(/ \| SOURCE:.*$/,"");
};
export function compactEvidenceUser(user){
 const mark="\n\nEVIDENCE CARDS:\n";
 const end="\n\nФИНАЛЬНОЕ ЗАДАНИЕ:";
 if(!user.includes(mark)||!user.includes(end))throw Error("MISSING_EVIDENCE_SECTION");
 const [pre,rest]=user.split(mark);
 const [evidence,post]=rest.split(end);
 if(!post)throw Error("MISSING_OUTPUT_INSTRUCTIONS");
 const short=evidence.split("\n").map(shortSourceLine).join("\n");
 return pre+mark+short+end+post;
}
export function buildCase(spec){
 const fixture=synthesisFixture(TARGET);
 const evidenceInput=spec.evidence==="compact"?
   compactEvidenceUser(fixture.user):fixture.user;
 const format=spec.format==="json_schema"?
   {type:"json_schema",json_schema:{name:"w_review_blocks_v1",strict:true,
     schema:synthesisResponseSchema(fixture.plan.blocks)}}:
   {type:"json_object"};
 const system=spec.format==="json_object"?
   fixture.system+"\n\nСТРУКТУРА ОТВЕТА ОБЯЗАТЕЛЬНА: JSON-объект с blocks "+
   "(block_id и paragraphs как массивы строк), section_titles и bold_phrases. "+
   "Сохраняй точно все блоки из плана. Без Markdown.":
   fixture.system;
 const body={messages:[
   {role:"system",content:system},{role:"user",content:evidenceInput}
 ],temperature:0.36,reasoning_effort:spec.reasoning,
 max_tokens:outputBudget(TARGET),response_format:format};
 const req=JSON.stringify(body);
 return {
   body,fixture,request_chars:req.length,
   user_chars:evidenceInput.length,
   source_section_chars:evidenceInput.split("\n\nEVIDENCE CARDS:\n")[1]
      ?.split("\n\nФИНАЛЬНОЕ ЗАДАНИЕ:")[0].length||0,
   evidence_ids:(evidenceInput.match(/^E\d{2} \[/gm)||[]).length
 };
}
function responseContent(data){
 const a=data?.result||data||{};
 const value=a.response||a.choices?.[0]?.message?.content||a.output_text||
   a.output?.filter(x=>x.type==="message").flatMap(x=>x.content||[])
     .filter(x=>x.type==="output_text").map(x=>x.text).join("\n");
 return typeof value==="string"?value:value&&typeof value==="object"?JSON.stringify(value):"";
}
function providerCategory(status,code,message){
 if(status===429&&/daily free allocation|used up.*neurons/i.test(message))return "daily_neurons";
 if(status===429&&/at capacity|out of capacity/i.test(message))return "capacity";
 if(status===429)return "rate_or_admission";
 if(status===413)return "request_too_large";
 if(status===400)return "bad_format_or_schema";
 return status?"http_"+status:"no_http_response";
}
const safeError=e=>/AbortError|TimeoutError/i.test(String(e?.name))?"local_timeout":"network_or_transport";
export async function testCase(spec,keys,fetchImpl=fetch,{timeoutOverrideMs=null}={}){
 const f=buildCase(spec),start=Date.now();
 const out={id:spec.id,model:"@cf/openai/gpt-oss-120b",
  input_variant:spec.evidence,response_format:spec.format,reasoning_effort:spec.reasoning,
  target_chars:TARGET,request_chars:f.request_chars,user_chars:f.user_chars,
  source_section_chars:f.source_section_chars,evidence_ids:f.evidence_ids,
  output_ceiling:f.body.max_tokens,configured_timeout_ms:spec.timeout_ms,
  http_status:0,header_elapsed_ms:null,body_elapsed_ms:null,
  elapsed_ms:0,error_category:"not_started"};
 let rawText="",normalized="";
 if(!keys?.cfAccount||!keys?.cfToken){
   out.error_category="missing_secrets";
   return {metrics:out,rawText,normalized};
 }
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),Math.min(
   timeoutOverrideMs??spec.timeout_ms,spec.timeout_ms));
 try{
   const url="https://api.cloudflare.com/client/v4/accounts/"+
     encodeURIComponent(keys.cfAccount)+"/ai/run/@cf/openai/gpt-oss-120b";
   const response=await fetchImpl(url,{method:"POST",
     headers:{Authorization:"Bearer "+keys.cfToken,"Content-Type":"application/json"},
     body:JSON.stringify(f.body),signal:controller.signal});
   out.http_status=response.status;
   out.header_elapsed_ms=Date.now()-start;
   out.cf_ray=response.headers.get("cf-ray")?.slice(0,64)||null;
   const body=await response.text();
   out.body_elapsed_ms=Date.now()-start;
   let parsed=null;
   try{parsed=JSON.parse(body)}catch{}
   if(!response.ok){
     const err=parsed?.errors?.[0]||{};
     out.provider_error_code=Number(err.code)||0;
     out.error_category=providerCategory(response.status,Number(err.code),
       String(err.message||""));
   }else{
     out.error_category="none";
     rawText=responseContent(parsed);
     const q=checkReview(rawText,f.fixture);
     Object.assign(out,q);
     const ai=parsed?.result||parsed||{};
     out.input_tokens=Number(ai?.usage?.prompt_tokens||0);
     out.output_tokens=Number(ai?.usage?.completion_tokens||0);
     out.finish_reason=String(ai?.choices?.[0]?.finish_reason||
       ai?.finish_reason||"unknown").slice(0,50);
     out.response_chars=rawText.length;
     const structured=parseModelJsonObject(rawText);
     normalized=structured?.blocks?.flatMap(b=>Array.isArray(b.paragraphs)?
       b.paragraphs:[]).filter(x=>typeof x==="string").join("\n\n")||"";
   }
 }catch(e){out.error_category=safeError(e)}
 finally{clearTimeout(timeout);out.elapsed_ms=Date.now()-start;}
 return {metrics:out,rawText,normalized};
}
const report=rows=>{
 const lines=[
  "# W-Review: GPT-OSS-120B 8000-character synthesis latency & admission test",
  "",
  "Controlled experiments on the same 18-publication / 167-Evidence SYNTHETIC pool.",
  "The compact variant strips redundant synthetic wording while retaining all record IDs and basic propositions; its completeness is not equivalent to full source-grounded editorial evidence.",
  "One parameter changes per comparison; four sequential calls MAX; no Supabase or real user materials.",
  "",
  "| Case | Request chars | Evidence rows | API status | Time s | Input tokens | Output tokens | Review chars | Target 7600–8400 | JSON valid | Error |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|"
 ];
 for(const r of rows)lines.push("| "+[
   r.id,r.request_chars,r.evidence_ids,r.http_status,
   (r.elapsed_ms/1000).toFixed(1),r.input_tokens||"—",
   r.output_tokens||"—",r.actual_chars||"—",
   r.within_tolerance?"yes":"no",r.json_parsed?"yes":"no",r.error_category
 ].join(" | ")+" |");
 lines.push("",
  "The test identifies a completion-time/format/input-size correlation; a provider admission delay or shared capacity can still confound it.",
  "A timeout without HTTP headers cannot establish whether the model started generating.",
  "Do not lower production's 8000-character target or 140-second server budget based on these synthetic trials alone.",
  "");
 return lines.join("\n")+"\n";
};
export async function runCases({keys,fetchImpl=fetch,
  cases=CASES,output="out/w-review-oss120-8000-latency",delayMs=9000,
  timeoutOverrideMs=null}={}){
 mkdirSync(output+"/synthetic_outputs",{recursive:true});
 const results=[];
 for(const spec of cases){
   if(results.length&&delayMs>0)await pause(delayMs);
   const result=await testCase(spec,keys,fetchImpl,{timeoutOverrideMs});
   const m=result.metrics;results.push(m);
   if(result.rawText)writeFileSync(output+"/synthetic_outputs/"+spec.id+".json.txt",result.rawText+"\n");
   if(result.normalized)writeFileSync(output+"/synthetic_outputs/"+spec.id+".review.txt",result.normalized+"\n");
   console.info("SYNTHESIS_PROBE "+JSON.stringify({
     id:m.id,status:m.http_status,elapsed_ms:m.elapsed_ms,
     header_elapsed_ms:m.header_elapsed_ms,response_format:m.response_format,
     input_variant:m.input_variant,reasoning_effort:m.reasoning_effort,
     request_chars:m.request_chars,evidence_ids:m.evidence_ids,
     actual_chars:m.actual_chars||0,within_tolerance:m.within_tolerance||false,
     error_category:m.error_category,provider_error_code:m.provider_error_code||0
   }));
   if(m.error_category==="daily_neurons"){
     console.warn("STOP_DAILY_NEURONS: no further Cloudflare calls on this account.");
     break;
   }
 }
 const details={synthetic_only:true,created_at:new Date().toISOString(),
   target_chars:TARGET,max_requests:CASES.length,
   total_calls:results.filter(x=>x.error_category!=="missing_secrets").length,results};
 writeFileSync(output+"/metrics.json",JSON.stringify(details,null,2)+"\n");
 const md=report(results);
 writeFileSync(output+"/report.md",md);
 if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,md);
 return details;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 runCases({keys:{
   cfAccount:process.env.CLOUDFLARE_ACCOUNT_ID||"",
   cfToken:process.env.CLOUDFLARE_API_TOKEN||""
 }}).catch(e=>{console.error("DIAGNOSTIC_FAILED:"+String(e?.name||"internal"));process.exitCode=1;});
}
