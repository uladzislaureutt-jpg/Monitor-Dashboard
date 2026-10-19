// One Cloudflare GPT-OSS-120B low-reasoning call with EXACT SAME synthetic
// 18-publication/167-Evidence inputs and 6000-character target as prior A/B.
// No Supabase writes, no operator data, no automatic provider fallback.
import {mkdirSync,writeFileSync,appendFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {synthesisFixture,outputBudget,checkReview} from "./synthesis-model-benchmark.mjs";
import {synthesisResponseSchema} from "./synthesis-blocks.ts";
import {parseModelJsonObject} from "./gemini-routing.ts";
const maxWaitMs=105000;
const checkpoints=[65,80,95,105];
export function timingStatus(elapsedMs,valid){
 return checkpoints.map(seconds=>({
  seconds,completed:elapsedMs!==null&&elapsedMs<=seconds*1000,
  complete_and_valid:elapsedMs!==null&&elapsedMs<=seconds*1000&&Boolean(valid)
 }));
}
const yes=x=>x?"YES":"NO";
export async function run({keys,fetchImpl=fetch,output="out/w-review-low-reasoning-synthesis"}={}){
 const fixture=synthesisFixture(6000);
 const metrics={model:"@cf/openai/gpt-oss-120b",reasoning_effort:"low",
  synthetic_only:true,source_publications:18,evidence_total:167,
  target_chars:6000,http_status:0,elapsed_ms:0,output_chars:0,
  output_token_ceiling:outputBudget(6000),error_category:"not_started"};
 let completedMs=null,review="",rawText="";
 if(!keys?.cfAccount||!keys?.cfToken)metrics.error_category="missing_secret";
 else{
  const body={
    messages:[{role:"system",content:fixture.system},
      {role:"user",content:fixture.user}],
    temperature:0.36,reasoning_effort:"low",
    max_tokens:metrics.output_token_ceiling,
    response_format:{type:"json_schema",json_schema:{
      name:"w_review_blocks_v1",strict:true,
      schema:synthesisResponseSchema(fixture.plan.blocks)
    }}
  };
  metrics.request_chars=JSON.stringify(body).length;
  const started=Date.now(),controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),maxWaitMs);
  try{
   const url="https://api.cloudflare.com/client/v4/accounts/"+
     encodeURIComponent(keys.cfAccount)+"/ai/run/@cf/openai/gpt-oss-120b";
   const resp=await fetchImpl(url,{method:"POST",
     headers:{Authorization:"Bearer "+keys.cfToken,"Content-Type":"application/json"},
     body:JSON.stringify(body),signal:controller.signal});
   metrics.http_status=resp.status;
   const raw=await resp.text();
   completedMs=Date.now()-started;
   if(!resp.ok){
    metrics.error_category="provider_http_"+resp.status;
    try{metrics.provider_error_code=Number(JSON.parse(raw)?.errors?.[0]?.code||0);}catch{}
   }else{
    const payload=JSON.parse(raw),answer=payload?.result||payload||{};
    const content=answer.response||answer.choices?.[0]?.message?.content||
      answer.output_text||answer.output?.filter(x=>x.type==="message")
        .flatMap(x=>x.content||[]).filter(x=>x.type==="output_text")
        .map(x=>x.text).join("\n")||"";
    rawText=typeof content==="string"?content:JSON.stringify(content);
    const quality=checkReview(rawText,fixture);
    Object.assign(metrics,quality);
    metrics.output_chars=rawText.length;
    metrics.error_category=quality.json_parsed?"none":"invalid_model_json";
    metrics.input_tokens=Number(answer?.usage?.prompt_tokens||0);
    metrics.output_tokens=Number(answer?.usage?.completion_tokens||0);
    metrics.finish_reason=String(answer?.choices?.[0]?.finish_reason||
      answer?.finish_reason||"unknown").slice(0,30);
    const parsed=parseModelJsonObject(rawText);
    review=(parsed?.blocks||[]).flatMap(b=>Array.isArray(b.paragraphs)?
      b.paragraphs:[]).filter(x=>typeof x==="string").join("\n\n");
   }
  }catch(e){metrics.error_category=/AbortError|TimeoutError/i.test(String(e?.name))?
   "timeout":"transport_or_invalid_provider_reply";}
  finally{clearTimeout(timer);metrics.elapsed_ms=Date.now()-started;}
 }
 metrics.ladder=timingStatus(completedMs,metrics.within_tolerance&&metrics.json_parsed&&
   metrics.blocks_measured===fixture.plan.blocks.length);
 const report=[
  "# W-Review Cloudflare GPT-OSS-120B low-reasoning synthetic synthesis probe",
  "",
  "One identical synthetic 18/167 input as previous A/B, target 6000 characters. Cloudflare reasoning LOW instead of MEDIUM which timed out at 103 seconds. Direct API only, no actual operator content.",
  "",
  "| Wait threshold | Full HTTP response | Complete JSON and 95–105% target |",
  "|---:|---|---|",
  ...metrics.ladder.map(x=>"| "+x.seconds+"s | "+yes(x.completed)+
    " | "+yes(x.complete_and_valid)+" |"),
  "",
  "HTTP: "+metrics.http_status+"; error: "+metrics.error_category+
   "; elapsed: "+(metrics.elapsed_ms/1000).toFixed(2)+"s.",
  "JSON: "+Boolean(metrics.json_parsed)+"; output length: "+
    (metrics.actual_chars??0)+" characters; output tokens: "+(metrics.output_tokens??0),
  "Underfilled blocks: "+(metrics.blocks_underfilled??"-")+" of 7; "+
    "source mentions: "+(metrics.sources_named??0)+"/18; "+
    "facets: "+(metrics.themes_with_named_sources??0)+"/5.",
  "",
  "Successful JSON does NOT guarantee fact fidelity or stylistic integrity. Synthetic full output and metrics are retained for manual editorial reading.",
  ""
 ].join("\n")+"\n";
 mkdirSync(output,{recursive:true});
 writeFileSync(output+"/metrics.json",JSON.stringify(metrics,null,2)+"\n");
 writeFileSync(output+"/report.md",report);
 if(rawText)writeFileSync(output+"/synthetic-output.json.txt",rawText+"\n");
 if(review)writeFileSync(output+"/synthetic-review.txt",review+"\n");
 if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,report);
 console.info("FINAL "+JSON.stringify({status:metrics.http_status,
  elapsed_ms:metrics.elapsed_ms,category:metrics.error_category,
  chars:metrics.actual_chars??0,within_tolerance:metrics.within_tolerance??false,
  source_coverage:metrics.sources_named??0}));
 return metrics;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 await run({keys:{
  cfAccount:process.env.CLOUDFLARE_ACCOUNT_ID||"",
  cfToken:process.env.CLOUDFLARE_API_TOKEN||""
 }});
}
