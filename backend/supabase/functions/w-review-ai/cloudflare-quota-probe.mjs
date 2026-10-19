// Small, read-only Cloudflare Workers AI free-tier diagnostic.
// Max five probes; no operator content, no production writes, no large output.
import {writeFileSync,mkdirSync,appendFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
export const PROBES=[
  {id:"llama1b64",model:"@cf/meta/llama-3.2-1b-instruct",max_tokens:64},
  {id:"oss120_64",model:"@cf/openai/gpt-oss-120b",max_tokens:64},
  {id:"nemotron120_64",model:"@cf/nvidia/nemotron-3-120b-a12b",max_tokens:64},
  {id:"oss120_512",model:"@cf/openai/gpt-oss-120b",max_tokens:512},
  {id:"nemotron120_512",model:"@cf/nvidia/nemotron-3-120b-a12b",max_tokens:512}
];
export function safeProviderFailure(http,statusBody){
  const err=statusBody?.errors?.[0]??statusBody?.error??{};
  const code=Number(err.code);
  const message=String(err.message??"").toLowerCase();
  return {
    code:Number.isSafeInteger(code)?code:0,
    message_class:/daily free allocation|used up.*neurons|free allocation of 10,000|neuron.{0,20}(limit|quota)/i.test(message)
       ?"daily_neurons"
      :/temporarily at capacity|out of capacity|capacity temporarily exceeded|service.*capacity/i.test(message)
       ?"capacity"
      :/rate limit|too many requests/i.test(message)?"rate_limit":"unspecified",
    http_status:http
  };
}
export async function probeOne(spec,keys,fetchImpl=fetch){
  const started=Date.now(),row={id:spec.id,model:spec.model,max_tokens:spec.max_tokens};
  if(!keys.account||!keys.token)return {...row,status:0,error_category:"missing_secret",elapsed_ms:0};
  const controller=new AbortController();
  const t=setTimeout(()=>controller.abort(),25000);
  try{
    const body={messages:[{role:"user",content:"Reply with exactly the word OK."}],
      max_tokens:spec.max_tokens,temperature:0};
    if(spec.model.includes("gpt-oss"))body.reasoning_effort="low";
    if(spec.model.includes("nemotron"))body.chat_template_kwargs={enable_thinking:false};
    const response=await fetchImpl("https://api.cloudflare.com/client/v4/accounts/"+
      encodeURIComponent(keys.account)+"/ai/run/"+spec.model,{
        method:"POST",headers:{"authorization":"Bearer "+keys.token,"content-type":"application/json"},
        body:JSON.stringify(body),signal:controller.signal});
    row.status=response.status;
    const ray=response.headers.get("cf-ray");
    const aiReq=response.headers.get("cf-ai-req-id");
    // IDs are server-generated request metadata, never API keys.
    if(ray)row.cf_ray=ray.replace(/[^A-Za-z0-9._-]/g,"").slice(0,90);
    if(aiReq)row.cf_ai_req_id=aiReq.replace(/[^A-Za-z0-9._-]/g,"").slice(0,100);
    let data=null;try{data=await response.json();}catch{}
    if(!response.ok)Object.assign(row,safeProviderFailure(response.status,data));
    else{
      row.message_class="success";
      const usage=data?.result?.usage??data?.usage??{};
      row.input_tokens=Number(usage.prompt_tokens||0);
      row.output_tokens=Number(usage.completion_tokens||0);
      row.has_content=Boolean(
        data?.result?.response||data?.result?.choices?.[0]?.message?.content
        ||data?.result?.output_text||data?.response);
    }
  }catch(error){row.status=0;row.error_category=String(error?.name||"transport").slice(0,45);}
  finally{clearTimeout(t);row.elapsed_ms=Date.now()-started;}
  return row;
}
export async function runProbes({keys,fetchImpl=fetch,output="out/cloudflare-4006-probe"}){
  const rows=[];
  // Always try three distinct models with a tiny payload. If all are denied,
  // stop; don't waste free quota on higher output limits.
  for(const p of PROBES.slice(0,3)){
    const result=await probeOne(p,keys,fetchImpl);
    rows.push(result);console.log("CF_PROBE "+JSON.stringify(result));
  }
  const largeWorthTrying=rows.some(x=>x.status===200);
  if(largeWorthTrying){
    for(const p of PROBES.slice(3)){
      // Allow two bounded 512-token probes only where the 64-token variant succeeded.
      const baseId=p.id.split("_")[0]+"_64";
      if(!rows.some(x=>x.id===baseId&&x.status===200))continue;
      const result=await probeOne(p,keys,fetchImpl);
      rows.push(result);console.log("CF_PROBE "+JSON.stringify(result));
    }
  }
  mkdirSync(output,{recursive:true});
  const all={created_at:new Date().toISOString(),model_count:rows.length,rows,
    hints:{
      all_4006_daily:rows.length>=3&&rows.slice(0,3).every(x=>x.code===4006&&x.message_class==="daily_neurons"),
      all_4006_capacity:rows.length>=3&&rows.slice(0,3).every(x=>x.code===4006&&x.message_class==="capacity"),
      small_success_but_large_error:rows.some(x=>x.status===200)&&rows.some(x=>x.max_tokens===512&&x.status===429)
    }};
  writeFileSync(output+"/results.json",JSON.stringify(all,null,2)+"\n");
  const table=[
    "# Cloudflare 4006 minimal diagnostic",
    "", "Only artificial 2-word prompts, max 5 requests. Never tests actual editorial data.",
    "", "| Model | Max tokens | HTTP | Internal code | Message category | Time ms |",
    "|---|---:|---:|---:|---|---:|",
    ...rows.map(x=>"| "+[x.model,x.max_tokens,x.status??0,x.code??"-",x.message_class??x.error_category??"-",x.elapsed_ms].join(" | ")+" |"),
    "","The numeric code 4006 alone is ambiguous; classify by the provider's message category. No raw provider messages or credentials are stored.",
    "","Cloudflare account usage in dashboard may be calendar-day, while admission limits could use a rolling 24h window."
  ].join("\n")+"\n";
  writeFileSync(output+"/report.md",table);
  if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,table);
  return all;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  runProbes({keys:{account:process.env.CLOUDFLARE_ACCOUNT_ID||"",
    token:process.env.CLOUDFLARE_API_TOKEN||""}})
    .catch(e=>{console.error("PROBE_FAILED:"+String(e?.name||"internal"));process.exitCode=1;});
}
