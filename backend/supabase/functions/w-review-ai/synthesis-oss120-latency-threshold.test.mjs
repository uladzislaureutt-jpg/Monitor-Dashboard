import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CASES,TARGET,buildCase,testCase,runCases}
 from "./synthesis-oss120-latency-threshold.mjs";
test("4 individually controlled comparisons all target exactly 8000 characters",()=>{
 assert.equal(TARGET,8000);
 assert.deepEqual(CASES.map(c=>c.id),[
  "full_object_medium","full_schema_medium","compact_schema_medium","full_schema_low"]);
 const mapped=CASES.map(buildCase);
 assert.ok(mapped.every(x=>x.fixture.target===8000));
 assert.ok(mapped.every(x=>x.evidence_ids===167));
 assert.ok(mapped.every(x=>x.body.max_tokens>=9000));
 assert.ok(mapped.every(x=>x.body.messages.length===2));
 assert.ok(mapped[0].body.response_format.type==="json_object");
 assert.ok(mapped[1].body.response_format.type==="json_schema");
 assert.ok(mapped[2].body.response_format.type==="json_schema");
 assert.ok(mapped[1].request_chars>mapped[2].request_chars*1.3,
  "compact source variant should measurably reduce payload");
 assert.equal(mapped[1].body.reasoning_effort,"medium");
 assert.equal(mapped[3].body.reasoning_effort,"low");
 assert.ok(Math.abs(mapped[1].request_chars-mapped[3].request_chars)<200);
 assert.ok(mapped[1].body.messages[1].content.includes("P18"));
 assert.ok(mapped[2].body.messages[1].content.includes("P18"));
 assert.equal(mapped[2].fixture.plan.blocks.length,7);
});
test("404, 400, 413, 429 produce transparent failure metrics without false model-quality inferences",async()=>{
 const keys={cfAccount:"a",cfToken:"t"},spec=CASES[1];
 for(const [status,code,message,expected] of [
  [400,123,"bad json schema","bad_format_or_schema"],
  [413,0,"large request","request_too_large"],
  [429,4006,"Service temporarily at capacity","capacity"],
  [429,4006,"You have used up your daily free allocation of 10,000 neurons","daily_neurons"]
 ]){
  const x=await testCase(spec,keys,async()=>new Response(
   JSON.stringify({errors:[{code,message}]}),{status}),{timeoutOverrideMs:1000});
  assert.equal(x.metrics.http_status,status);
  assert.equal(x.metrics.error_category,expected);
  assert.equal(x.metrics.input_tokens,undefined);
 }
});
test("record the time to receive headers separately from full response body",async()=>{
 const result=await testCase(CASES[0],{cfAccount:"a",cfToken:"t"},
   async(_url,opts)=>{
     assert.equal(JSON.parse(opts.body).max_tokens,9500);
     return new Response(JSON.stringify({result:{
       response:JSON.stringify({blocks:[],section_titles:[],bold_phrases:[]}),
       usage:{prompt_tokens:19400,completion_tokens:2000},
       choices:[{finish_reason:"stop"}]}}),{status:200});
   },{timeoutOverrideMs:1000});
 const m=result.metrics;
 assert.equal(m.http_status,200);
 assert.equal(m.input_tokens,19400);
 assert.equal(m.output_tokens,2000);
 assert.equal(m.json_parsed,true);
 assert.ok(m.header_elapsed_ms!==null);
 assert.ok(m.body_elapsed_ms!==null);
 assert.ok(m.body_elapsed_ms>=m.header_elapsed_ms);
 assert.equal(m.within_tolerance,false);
});
test("daily neuron hard stop prevents wasting subsequent API calls",async()=>{
 const folder=mkdtempSync(join(tmpdir(),"w-review-oss-limits-"));
 let calls=0;
 try{
   const v=await runCases({
     keys:{cfAccount:"x",cfToken:"y"},output:folder,delayMs:0,
     cases:CASES,timeoutOverrideMs:1000,
     fetchImpl:async()=>{calls++;return new Response(JSON.stringify({errors:[{
       code:4006,message:"You have used up your daily free allocation of 10,000 neurons"
     }]}),{status:429})}
   });
   assert.equal(calls,1);
   assert.equal(v.results.length,1);
   assert.equal(v.results[0].error_category,"daily_neurons");
   const disk=JSON.parse(readFileSync(join(folder,"metrics.json"),"utf8"));
   assert.equal(disk.total_calls,1);
   assert.equal(disk.target_chars,8000);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("no credentials produces zero external API calls and clear skips",async()=>{
 const folder=mkdtempSync(join(tmpdir(),"w-review-oss-no-token-"));
 try{
   const x=await runCases({keys:{},cases:CASES.slice(0,2),delayMs:0,
     output:folder,fetchImpl:()=>{throw Error("CANNOT_CALL")}});
   assert.equal(x.total_calls,0);
   assert.deepEqual(x.results.map(x=>x.error_category),["missing_secrets","missing_secrets"]);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
