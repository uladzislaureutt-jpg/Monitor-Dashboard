import test from "node:test";
import assert from "node:assert/strict";
import {timingStatus,run} from "./synthesis-low-reasoning-probe.mjs";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
test("Thresholds report exact 65,80,95,105 seconds without repeated calls",()=>{
 assert.deepEqual(timingStatus(91000,true).map(x=>x.complete_and_valid),
  [false,false,true,true]);
 assert.ok(timingStatus(null,false).every(x=>!x.completed));
});
test("Without credentials it does not call any provider",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"wrev-low-"));
 try{
  const x=await run({keys:{},output:dir,fetchImpl:()=>{throw Error("network forbidden");}});
  assert.equal(x.error_category,"missing_secret");
  assert.equal(x.http_status,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("Only one Cloudflare call, with reasoning low, same JSON schema, and 7500 tokens",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"wrev-low-"));
 let calls=0;
 try{
  const x=await run({keys:{cfAccount:"test",cfToken:"secret"},output:dir,
   fetchImpl:async(url,opts)=>{
    calls++;
    assert.ok(url.includes("/ai/run/@cf/openai/gpt-oss-120b"));
    const body=JSON.parse(opts.body);
    assert.equal(body.reasoning_effort,"low");
    assert.equal(body.max_tokens,7500);
    assert.equal(body.response_format.type,"json_schema");
    assert.equal(body.messages.length,2);
    assert.ok(JSON.stringify(body).includes("STYLE_ONLY"));
    assert.ok(JSON.stringify(body).includes("SOURCE_REGISTRY"));
    return new Response(JSON.stringify({result:{
      response:JSON.stringify({blocks:[],section_titles:[],bold_phrases:[]}),
      usage:{prompt_tokens:1000,completion_tokens:300},
      choices:[{finish_reason:"stop"}]
    }}),{status:200});
   }});
  assert.equal(calls,1);assert.equal(x.http_status,200);
  assert.equal(x.within_tolerance,false);
  assert.ok(x.ladder.every(z=>!z.complete_and_valid));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
