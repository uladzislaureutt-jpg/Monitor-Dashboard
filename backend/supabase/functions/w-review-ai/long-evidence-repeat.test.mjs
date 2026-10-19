import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LONG_TEST_ORDER,OUTPUT_TOKEN_CEILING,runLongRepeated,summarize}
  from "./long-evidence-repeat.mjs";
import {testCorpus,identicalEvidencePrompt} from "./evidence-model-benchmark.mjs";
test("controlled paired repeats are ABBA and keep a 9000 ceiling",()=>{
 assert.deepEqual(LONG_TEST_ORDER,["gemini35","oss120","oss120","gemini35"]);
 assert.equal(OUTPUT_TOKEN_CEILING,9000);
 const docs=testCorpus()[1].docs;
 assert.equal(docs.length,2);
 assert.ok(docs.every(d=>d.passages.length>=15));
 assert.ok(identicalEvidencePrompt(docs).length>5000);
});
test("mock four API responses use precisely identical long-article prompt and 9000 ceiling",async()=>{
 const folder=mkdtempSync(join(tmpdir(),"w-review-long-"));
 const seen=[];
 const f=async(url,opts)=>{
   const req=JSON.parse(opts.body);
   const gemini=url.includes("generativelanguage.googleapis.com");
   const prompt=gemini?req.contents[0].parts[0].text:req.messages[0].content;
   const ceiling=gemini?req.generationConfig.maxOutputTokens:req.max_tokens;
   seen.push({prompt,ceiling,gemini});
   // Synthetic-only response. Source validator decides acceptance.
   const text=JSON.stringify({cards:[]});
   return new Response(JSON.stringify(gemini?
     {candidates:[{finishReason:"STOP",content:{parts:[{text}]}}],usageMetadata:{
       promptTokenCount:100,candidatesTokenCount:20}}:
     {success:true,result:{response:text,usage:{prompt_tokens:100,completion_tokens:20}}}),
   {status:200,headers:{"content-type":"application/json"}});
 };
 try{
   const r=await runLongRepeated({
     keys:{gemini:"dummy",cfAccount:"demo",cfToken:"dummy"},
     fetchImpl:f,delayMs:0,output:folder
   });
   assert.equal(seen.length,4);
   assert.equal(new Set(seen.map(x=>x.prompt)).size,1);
   assert.deepEqual(seen.map(x=>x.gemini),[true,false,false,true]);
   assert.ok(seen.every(x=>x.ceiling===9000));
   assert.deepEqual(r.rows.map(x=>x.status),[200,200,200,200]);
   assert.deepEqual(r.summary.map(x=>x.attempts),[2,2]);
   const saved=JSON.parse(readFileSync(join(folder,"metrics.json"),"utf8"));
   assert.equal(saved.synthetic_only,true);
   assert.equal(saved.output_token_ceiling,9000);
   assert.ok(readFileSync(join(folder,"report.md"),"utf8").includes("Stability"));
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("success rates exclude 429 / timeout from semantic scores",()=>{
 const s=summarize([
   {model_id:"gemini35",status:200,elapsed_ms:5000,records_accepted:15,passages_covered:12,cards_accepted:2},
   {model_id:"gemini35",status:200,elapsed_ms:5500,records_accepted:22,passages_covered:18,cards_accepted:2},
   {model_id:"oss120",status:429,elapsed_ms:120,provider_error_code:4006,error_category:"cloudflare_429_other"},
   {model_id:"oss120",status:0,elapsed_ms:110000,error_category:"timeout"}
 ]);
 assert.equal(s[0].accepted_records.min,15);
 assert.equal(s[0].accepted_records.max,22);
 assert.equal(s[1].successes,0);
 assert.equal(s[1].accepted_records,null);
 assert.deepEqual(s[1].failure_categories.map(x=>x.status),[429,0]);
});
