// Controlled long-article Evidence A/B repeated test (synthetic source texts).
// Same two articles, same prompt, 9000 token ceiling and verifier for every call.
// 4 sequential LIVE requests maximum: Gemini / OSS / OSS / Gemini (ABBA).
// No production pool, Supabase, operator data or model changes.
import {mkdirSync,writeFileSync,appendFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {EVIDENCE_MODELS,testCorpus,identicalEvidencePrompt,callEvidenceModel}
  from "./evidence-model-benchmark.mjs";
export const LONG_TEST_ORDER=["gemini35","oss120","oss120","gemini35"];
export const OUTPUT_TOKEN_CEILING=9000;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const summarize=rows=>["gemini35","oss120"].map(id=>{
 const subset=rows.filter(x=>x.model_id===id),successful=subset.filter(x=>x.status===200);
 const values=key=>successful.map(x=>Number(x[key]??0));
 const aggregate=key=>{
   const v=values(key);
   return v.length?{min:Math.min(...v),max:Math.max(...v),
     mean:Number((v.reduce((n,x)=>n+x,0)/v.length).toFixed(2))}:null;
 };
 return {
   model_id:id,attempts:subset.length,successes:successful.length,
   failure_categories:subset.filter(x=>x.status!==200).map(x=>({
     status:x.status,category:x.error_category||"unknown",provider_code:x.provider_error_code||0
   })),
   elapsed_ms:aggregate("elapsed_ms"),
   accepted_records:aggregate("records_accepted"),
   covered_passages:aggregate("passages_covered"),
   rejected_records:aggregate("records_rejected"),
   accepted_cards:aggregate("cards_accepted"),
   final_third_covered:aggregate("final_third_covered"),
   quotes:aggregate("confirmed_quotes"),
   expert_records:aggregate("expert_records"),
   opposition_records:aggregate("counterposition_records"),
   first_answer_within_cf_35s:successful.length?
     successful.filter(x=>x.elapsed_ms<=35000).length+"/"+successful.length:"0/0"
 };
});
export function report(rows,summary){
 const lines=["# W-Review — controlled long Evidence pair repeated A/B",
   "",
   "Four sequential real requests on IDENTICAL synthetic long articles, order Gemini → GPT-OSS → GPT-OSS → Gemini.",
   "Each request uses the same Evidence v2 instructions, source verification and a 9000-token OUTPUT CEILING. No automatic retries.",
   "Response times include full API latency; successful extraction does not establish that the model fits the production Cloudflare fallback's 35-second window.",
   "",
   "| Run | Model | HTTP | Time s | Accepted cards | Verified Evidence | Rejected | Covered passages | Last third | Quotes | Experts | Counterpositions |",
   "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
 for(const r of rows){
   lines.push("| "+[
     r.sequence,r.model_id,r.status,((r.elapsed_ms||0)/1000).toFixed(1),
     (r.cards_accepted??0)+"/"+r.cards_requested,
     r.records_accepted??0,r.records_rejected??0,
     (r.passages_covered??0)+"/"+r.passages_total,
     (r.final_third_covered??0)+"/2",r.confirmed_quotes??0,
     r.expert_records??0,r.counterposition_records??0
   ].join(" | ")+" |");
 }
 lines.push("","## Stability per model","",
   "| Model | Successful / 2 | Evidence min–max | Coverage min–max | Time min–max (s) | Cloudflare fallback 35s |",
   "|---|---:|---:|---:|---:|---|");
 for(const x of summary)lines.push("| "+[
   x.model_id,x.successes+"/2",
   x.accepted_records?x.accepted_records.min+"–"+x.accepted_records.max:"N/A",
   x.covered_passages?x.covered_passages.min+"–"+x.covered_passages.max:"N/A",
   x.elapsed_ms?(x.elapsed_ms.min/1000).toFixed(1)+"–"+(x.elapsed_ms.max/1000).toFixed(1):"N/A",
   x.first_answer_within_cf_35s
 ].join(" | ")+" |");
 lines.push("","Metrics are mechanical and may not capture argument quality; inspect synthetic model outputs before changing provider order.",
   "Neither a 429 nor a timeout should be classified as poor source extraction.");
 return lines.join("\n")+"\n";
}
export async function runLongRepeated({keys,fetchImpl=fetch,output="out/w-review-long-evidence-repeat",delayMs=9000}){
 const fixture=testCorpus()[1];
 if(fixture.name!=="long_pair"||fixture.docs.length!==2)throw Error("INVALID_LONG_FIXTURE");
 if(fixture.docs.some(d=>d.passages.length<15))throw Error("LONG_FIXTURE_HAS_TOO_FEW_PASSAGES");
 const baseline=identicalEvidencePrompt(fixture.docs);
 if(baseline.length<5000)throw Error("PROMPT_NOT_LONG");
 const specs=new Map(EVIDENCE_MODELS.map(m=>[m.id,m]));
 const rows=[],outputs=[];
 for(const id of LONG_TEST_ORDER){
   if(rows.length&&delayMs>0)await sleep(delayMs);
   const spec=specs.get(id);
   if(!spec)throw Error("UNKNOWN_TEST_MODEL");
   const call=await callEvidenceModel(spec,fixture.docs,keys,fetchImpl,110000,
     raw=>outputs.push({sequence:rows.length+1,model_id:id,content:raw.content}));
   const row={sequence:rows.length+1,...call};rows.push(row);
   // No full model replies, texts, keys or provider error descriptions in Actions logs.
   console.info(JSON.stringify({sequence:row.sequence,model_id:row.model_id,status:row.status,
     elapsed_ms:row.elapsed_ms,cards:row.cards_accepted,records:row.records_accepted,
     coverage:row.passages_covered,error_category:row.error_category}));
 }
 const summary=summarize(rows),md=report(rows,summary);
 mkdirSync(output+"/synthetic_outputs",{recursive:true});
 writeFileSync(output+"/metrics.json",JSON.stringify({
   synthetic_only:true,created_at:new Date().toISOString(),
   output_token_ceiling:OUTPUT_TOKEN_CEILING,sequence:LONG_TEST_ORDER,
   source_passages:fixture.docs.reduce((n,d)=>n+d.passages.length,0),
   source_characters:fixture.docs.reduce((n,d)=>n+d.passages.reduce((m,p)=>m+p.text.length,0),0),
   input_prompt_characters:baseline.length,rows,summary
 },null,2)+"\n");
 writeFileSync(output+"/report.md",md);
 for(const o of outputs)writeFileSync(output+"/synthetic_outputs/"+o.sequence+"-"+o.model_id+".txt",o.content+"\n");
 if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,md);
 return {rows,summary};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 runLongRepeated({keys:{
   gemini:process.env.GEMINI_API_KEY||process.env.GOOGLE_GEMINI_API_KEY||"",
   cfAccount:process.env.CLOUDFLARE_ACCOUNT_ID||"",
   cfToken:process.env.CLOUDFLARE_API_TOKEN||""
 }}).catch(e=>{console.error("REPEAT_TEST_FAILED:"+String(e?.name||"internal"));process.exitCode=1;});
}
