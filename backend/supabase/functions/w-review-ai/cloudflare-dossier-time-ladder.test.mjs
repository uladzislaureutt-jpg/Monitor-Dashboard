import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WAIT_SECONDS,buildProductionFixture,timeLadder,runTimeLadder}
  from "./cloudflare-dossier-time-ladder.mjs";
test("One exact Cloudflare model, 18 synthetic publications, 167 Evidence, 7500 tokens",()=>{
 const fx=buildProductionFixture();
 assert.equal(fx.cards.length,18);
 assert.equal(fx.evidenceCount,167);
 assert.equal(fx.body.max_tokens,7500);
 assert.equal(fx.body.reasoning_effort,"low");
 assert.equal(fx.body.response_format.type,"json_object");
 assert.ok(fx.body.messages[1].content.includes("P18:E09"));
 assert.ok(fx.inputChars>15000);
 assert.ok(!fx.body.messages[0].content.includes("ПРОВЕРЯЕМАЯ РЕДАКЦИОННАЯ ДИСЦИПЛИНА"));
});
test("Wait thresholds do not make six API requests: exactly 70,80,90,100,120,140",()=>{
 assert.deepEqual(WAIT_SECONDS,[70,80,90,100,120,140]);
 assert.deepEqual(timeLadder(95000,true,false).map(x=>x.strict_valid),
   [false,false,false,true,true,true]);
 assert.deepEqual(timeLadder(null,false,false).map(x=>x.response_received),
   [false,false,false,false,false,false]);
 assert.deepEqual(timeLadder(63000,false,true).map(x=>x.reconciled_valid),
   [true,true,true,true,true,true]);
});
test("HTTP200 with invalid dossier never claims a passed validation",async()=>{
 const temp=mkdtempSync(join(tmpdir(),"w-review-dossier-timing-"));
 let requests=0;
 try{
   const metrics=await runTimeLadder({
     keys:{cfAccount:"dummy",cfToken:"dummy"},
     maxMs:1000,output:temp,log:()=>{},
     fetchImpl:async(url,req)=>{
       requests++;
       assert.match(url,/gpt-oss-120b/);
       const body=JSON.parse(req.body);
       assert.equal(body.max_tokens,7500);
       return new Response(JSON.stringify({result:{
         response:JSON.stringify({trends:[],coverage:[],inventory:{quotes:0,headlines:0,experts:0}}),
         choices:[{finish_reason:"stop"}]
       }}),{status:200,headers:{"content-type":"application/json"}});
     }
   });
   assert.equal(requests,1);
   assert.equal(metrics.http_status,200);
   assert.equal(metrics.strict_valid,false);
   assert.equal(metrics.repaired_valid,false);
   assert.equal(metrics.ladder.length,6);
   assert.ok(metrics.ladder.every(x=>!x.strict_valid));
   const disk=JSON.parse(readFileSync(join(temp,"metrics.json"),"utf8"));
   assert.equal(disk.request_count,1);
 }finally{rmSync(temp,{recursive:true,force:true});}
});
test("HTTP 429 is separate from model quality and never reported as strict valid",async()=>{
 const temp=mkdtempSync(join(tmpdir(),"w-review-dossier-timing-"));
 try{
   const m=await runTimeLadder({
     keys:{cfAccount:"dummy",cfToken:"dummy"},maxMs:1000,
     output:temp,log:()=>{},
     fetchImpl:async()=>new Response(JSON.stringify({errors:[{code:4006}]}),{status:429})
   });
   assert.equal(m.http_status,429);
   assert.equal(m.provider_error_code,4006);
   assert.equal(m.strict_valid,false);
   assert.equal(m.error_category,"provider_http_429");
 }finally{rmSync(temp,{recursive:true,force:true});}
});
test("No secrets: zero external calls and no falsely reported availability",async()=>{
 const temp=mkdtempSync(join(tmpdir(),"w-review-dossier-timing-"));
 try{
   const m=await runTimeLadder({keys:{},maxMs:1000,output:temp,log:()=>{},
     fetchImpl:()=>{throw Error("SHOULD_NOT_CALL");}});
   assert.equal(m.request_count,0);
   assert.equal(m.error_category,"missing_secrets");
   assert.ok(m.ladder.every(x=>x.response_received===false));
 }finally{rmSync(temp,{recursive:true,force:true});}
});
