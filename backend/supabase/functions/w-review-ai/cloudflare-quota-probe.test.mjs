import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PROBES,safeProviderFailure,probeOne,runProbes} from "./cloudflare-quota-probe.mjs";
const temp=()=>mkdtempSync(join(tmpdir(),"cf4006-"));
test("provider message distinguishes overloaded 4006 and daily-quota 4006",()=>{
  const daily=safeProviderFailure(429,{errors:[{code:4006,
    message:"AiError: You have used up your daily free allocation of 10,000 neurons"}]});
  const busy=safeProviderFailure(429,{errors:[{code:4006,
    message:"AiError: Service temporarily at capacity"}]});
  assert.equal(daily.message_class,"daily_neurons");
  assert.equal(busy.message_class,"capacity");
  assert.equal(daily.code,4006);
  assert.equal(busy.code,4006);
});
test("tiny probes always compare three models; account-denied responses do not trigger more calls",async()=>{
 const folder=temp(),called=[];
 try{
   const result=await runProbes({keys:{account:"test",token:"test"},
     output:folder,fetchImpl:async(_url,o)=>{
       called.push(JSON.parse(o.body));
       return new Response(JSON.stringify({errors:[{code:4006,
         message:"You have used up your daily free allocation of 10,000 neurons"}]}),
         {status:429,headers:{"cf-ray":"ray-123"}});
     }});
   assert.equal(result.rows.length,3);
   assert.equal(called.length,3);
   assert.ok(result.hints.all_4006_daily);
   assert.ok(result.rows.every(x=>x.cf_ray==="ray-123"));
   assert.ok(called.every(x=>x.max_tokens===64));
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("probe includes 512-token checks only after 64-token success on the same model",async()=>{
 const folder=temp(),urls=[];
 try{
   const result=await runProbes({keys:{account:"test",token:"test"},
     output:folder,fetchImpl:async(url,opts)=>{
       urls.push({url,body:JSON.parse(opts.body)});
       return new Response(JSON.stringify({result:{response:"OK",
          usage:{prompt_tokens:12,completion_tokens:1}}}),
         {status:200});
     }});
   assert.equal(result.rows.length,5);
   assert.deepEqual(result.rows.map(x=>x.max_tokens),[64,64,64,512,512]);
   assert.ok(urls.find(x=>x.url.includes("nemotron")).body.chat_template_kwargs.enable_thinking===false);
   assert.ok(urls.find(x=>x.url.includes("gpt-oss")).body.reasoning_effort==="low");
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("no keys cause no real provider requests",async()=>{
 const folder=temp();
 try{
   const result=await runProbes({keys:{},output:folder,fetchImpl:()=>{throw Error("network")}}); 
   assert.ok(result.rows.every(x=>x.error_category==="missing_secret"));
 }finally{rmSync(folder,{recursive:true,force:true});}
});
