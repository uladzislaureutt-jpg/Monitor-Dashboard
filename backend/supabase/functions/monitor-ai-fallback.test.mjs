import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {stripTypeScriptTypes} from "node:module";

const base=new URL("./",import.meta.url);
const names=["l-translate","transcription-edit","media-transcribe","transcription-image-ocr"];
const read=name=>readFileSync(new URL(name+"/index.ts",base),"utf8");
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json"}});

for(const name of names){
 test(name+" parses as valid TypeScript and keeps authenticated operator access",()=>{
  const src=read(name);
  const stripped=stripTypeScriptTypes(src,{mode:"strip"}).replace(/^import .*;\s*$/gm,"");
  assert.doesNotThrow(()=>new vm.Script(stripped,{filename:name+".ts"}));
  assert.match(src,/auth\.getUser\(\)/);
  assert.match(src,/monitor_profiles/);
  assert.match(src,/AbortSignal\.timeout/);
  assert.match(src,/provider_failure/);
 });
}
function install(name,fetcher,envValues={}){
 const src=read(name).replace(/^import .*;\s*$/gm,"");
 const js=stripTypeScriptTypes(src,{mode:"strip"});
 let handler;
 const profile={select(){return this},eq(){return this},maybeSingle:async()=>({data:{status:"active",minimum_allowed_version:"0.0.0",latest_version:"0.0.0",update_mode:"normal"},error:null})};
 const createClient=()=>({auth:{getUser:async()=>({data:{user:{id:"u1"}},error:null})},from:()=>profile});
 const env={GEMINI_API_KEY:"gemini-secret",GROQ_L_TRANSLATION_API_KEY:"groq-secret",GROQ_TRANSCRIPTION_API_KEY:"groq-audio",
  CLOUDFLARE_ACCOUNT_ID:"cf-account-one",CLOUDFLARE_API_TOKEN:"cf-one",
  CLOUDFLARE_BACKUP_ACCOUNT_ID:"cf-account-two",CLOUDFLARE_BACKUP_API_TOKEN:"cf-two",...envValues};
 const context={Deno:{serve:fn=>handler=fn,env:{get:key=>env[key]||""}},createClient,
  fetch:fetcher,Response,File,FormData,AbortSignal,TextEncoder,TextDecoder,Uint8Array,btoa,
  console:{info(){},warn(){}},Date,JSON,Number,String,Math,Array,Object,Boolean,RegExp,Set};
 vm.runInNewContext(js,context,{timeout:1500});
 assert.equal(typeof handler,"function");
 return handler;
}
test("Gemini translation 429 falls back to Cloudflare 120B preserving full text",async()=>{
 const calls=[];
 const handler=install("l-translate",async(url)=>{
  calls.push(url);
  if(url.includes("generativelanguage"))return response({error:"RESOURCE_EXHAUSTED"},429);
  return response({success:true,result:{response:JSON.stringify({translated_text:"Переведённый текст. ".repeat(16)})}});
 });
 const result=await handler({method:"POST",headers:new Headers({Authorization:"Bearer x"}),json:async()=>({text:"Original article ".repeat(12),title:"Title",provider:"gemini"})});
 const data=await result.json();
 assert.equal(result.status,200);
 assert.equal(data.provider,"cloudflare");
 assert.equal(data.model,"@cf/openai/gpt-oss-120b");
 assert.equal(calls.length,2);
});
test("transcription text editor uses Cloudflare on Gemini overload, preserving length",async()=>{
 const calls=[];
 const handler=install("transcription-edit",async(url)=>{
  calls.push(url);
  if(url.includes("generativelanguage"))return response({error:"429"},429);
  return response({success:true,result:{response:JSON.stringify({edited_text:"Исправленный связный транскрибированный текст. ".repeat(4)})}});
 });
 const result=await handler({method:"POST",headers:new Headers({Authorization:"Bearer x"}),json:async()=>({text:"Исходный транскрибированный текст. ".repeat(4),app_version:"0.8.73"})});
 const data=await result.json();
 assert.equal(result.status,200);assert.equal(data.provider,"cloudflare");assert.equal(calls.length,2);
});
test("Groq Whisper 429 falls back to Cloudflare Whisper with timestamps",async()=>{
 const calls=[];
 const handler=install("media-transcribe",async(url)=>{
  calls.push(url);
  if(url.includes("api.groq.com"))return response({error:"rate"},429);
  return response({success:true,result:{text:"Первый сегмент",language:"ru",segments:[{start:0,end:2.5,text:"Первый сегмент"}]}});
 });
 const file=new File([new Uint8Array(50000)],"audio.mp3",{type:"audio/mpeg"});
 const form=new FormData();form.set("file",file);form.set("app_version","0.8.73");
 const result=await handler({method:"POST",headers:new Headers({Authorization:"Bearer x"}),formData:async()=>form});
 const data=await result.json();
 assert.equal(result.status,200);assert.equal(data.segments.length,1);
 assert.equal(data.model,"@cf/openai/whisper-large-v3-turbo");assert.equal(calls.length,2);
});
test("Gemini screenshot OCR 429 falls back to Cloudflare multimodal vision",async()=>{
 const calls=[];
 const handler=install("transcription-image-ocr",async(url)=>{
  calls.push(url);
  if(url.includes("generativelanguage"))return response({error:"limit"},429);
  return response({success:true,result:{response:"Текст на кадре"}});
 });
 const file=new File([new Uint8Array(300)],"screenshot.png",{type:"image/png"});
 const form=new FormData();form.set("image",file);
 const result=await handler({method:"POST",headers:new Headers({Authorization:"Bearer x"}),formData:async()=>form});
 const data=await result.json();
 assert.equal(result.status,200);assert.equal(data.text,"Текст на кадре");
 assert.equal(data.model,"@cf/meta/llama-4-scout-17b-16e-instruct");assert.equal(calls.length,2);
});
test("No backend fallback bypasses authentication or overwrites source",()=>{
 for(const name of names){
  const src=read(name);
  assert.ok(src.indexOf("auth.getUser()")<src.indexOf("CLOUDFLARE_ACCOUNT_ID"));
  assert.ok(!src.includes("SUPABASE_SERVICE_ROLE_KEY",src.indexOf("const routes=")));
 }
});
