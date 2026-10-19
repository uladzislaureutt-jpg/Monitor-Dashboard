import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "jsr:@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(x:unknown,status=200)=>new Response(JSON.stringify(x),{status,headers:{...cors,"Content-Type":"application/json"}});
Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return json({error:"method_not_allowed"},405);
 const u=Deno.env.get("SUPABASE_URL")!,a=Deno.env.get("SUPABASE_ANON_KEY")!,sr=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
 const auth=req.headers.get("Authorization")||"";
 const client=createClient(u,a,{global:{headers:{Authorization:auth}},auth:{persistSession:false}});
 const admin=createClient(u,sr,{auth:{persistSession:false}});
 const {data:session,error:authError}=await client.auth.getUser();
 if(authError||!session.user)return json({error:"unauthorized"},401);
 const {data:profile}=await admin.from("monitor_profiles").select("status").eq("id",session.user.id).maybeSingle();
 if(profile?.status!=="active")return json({error:"access_denied"},403);
 let body:any;try{body=await req.json()}catch{return json({error:"invalid_json"},400)}
 const text=String(body.text||"").trim(),title=String(body.title||"").slice(0,300);
 if(text.length<80||text.length>15000)return json({error:"invalid_text_length",minimum:80,maximum:15000},400);
 const provider=body.provider==="gemini"?"gemini":"qwen";
 const prompt="Переведи полный текст публикации на русский язык. Строго сохрани каждый абзац, все факты, цифры, фамилии, цитаты, оговорки и порядок. Не сокращай, не комментируй и не дополняй. Ответ — только перевод. Если часть невозможно перевести, оставь её на исходном языке. Заголовок (контекст): "+title+"\n\n"+text;
 const geminiKey=Deno.env.get("GEMINI_API_KEY")||Deno.env.get("GOOGLE_GEMINI_API_KEY")||Deno.env.get("GOOGLE_API_KEY")||"";
 const cf=[
  {route:"cloudflare_primary",id:Deno.env.get("CLOUDFLARE_ACCOUNT_ID")||"",key:Deno.env.get("CLOUDFLARE_API_TOKEN")||""},
  {route:"cloudflare_backup",id:Deno.env.get("CLOUDFLARE_BACKUP_ACCOUNT_ID")||"",key:Deno.env.get("CLOUDFLARE_BACKUP_API_TOKEN")||""}
 ];
 const groqKey=Deno.env.get("GROQ_L_TRANSLATION_API_KEY")||Deno.env.get("GROQ_W_REVIEW_API_KEY")||"";
 const routes=provider==="gemini"?["gemini",...cf]:["qwen",...cf];
 const deadline=Date.now()+137000;
 let lastError="translation_providers_unavailable";
 // Use an independent fallback only on failure, truncation or invalid output.
 // Never concatenate drafts or consume operator's source text as a completion.
 for(const route of routes){
  const label=typeof route==="string"?route:route.route;
  if(typeof route==="object"&&(!route.id||!route.key||
   (label==="cloudflare_backup"&&route.id===cf[0].id)))continue;
  if(label==="gemini"&&!geminiKey||label==="qwen"&&!groqKey)continue;
  const remaining=deadline-Date.now()-8000;
  const budget=Math.min(label==="gemini"?45000:label==="qwen"?55000:58000,remaining);
  if(budget<9000)break;
  try{
   const signal=AbortSignal.timeout(budget);
   let res:Response,parsed:any,translated="",model="",usage:any={},limits:any={};
   if(label==="gemini"){
    model="gemini-3.5-flash-lite";
    res=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent",
     {method:"POST",signal,headers:{"x-goog-api-key":geminiKey,"Content-Type":"application/json"},
      body:JSON.stringify({contents:[{parts:[{text:prompt}]}],
       generationConfig:{temperature:0.1,maxOutputTokens:12000}})});
    const raw=await res.text();try{parsed=JSON.parse(raw)}catch{parsed={}};
    if(res.ok){
     translated=String((parsed.candidates?.[0]?.content?.parts||[]).map((p:any)=>p.text||"").join("")).trim();
     if(parsed.candidates?.[0]?.finishReason==="MAX_TOKENS")translated="";
     const u=parsed.usageMetadata||{};
     usage={prompt_tokens:Number(u.promptTokenCount||0),completion_tokens:Number(u.candidatesTokenCount||0),total_tokens:Number(u.totalTokenCount||0)};
    }
   }else if(label==="qwen"){
    model="qwen/qwen3.8-27b";
    res=await fetch("https://api.groq.com/openai/v1/chat/completions",
     {method:"POST",signal,headers:{"Authorization":"Bearer "+groqKey,"Content-Type":"application/json"},
      body:JSON.stringify({model,messages:[{role:"user",content:prompt}],temperature:0.2,reasoning_effort:"none",max_completion_tokens:6500})});
    const raw=await res.text();try{parsed=JSON.parse(raw)}catch{parsed={}};
    if(res.ok&&parsed?.choices?.[0]?.finish_reason!=="length")translated=String(parsed?.choices?.[0]?.message?.content||"").trim();
    usage=parsed?.usage||{};
    limits={remaining_requests:res.headers.get("x-ratelimit-remaining-requests"),remaining_tokens:res.headers.get("x-ratelimit-remaining-tokens"),
     limit_requests:res.headers.get("x-ratelimit-limit-requests"),limit_tokens:res.headers.get("x-ratelimit-limit-tokens"),
     reset_requests:res.headers.get("x-ratelimit-reset-requests"),reset_tokens:res.headers.get("x-ratelimit-reset-tokens")};
   }else{
    model="@cf/openai/gpt-oss-120b";
    const cfRoute=route as {route:string;id:string;key:string};
    res=await fetch("https://api.cloudflare.com/client/v4/accounts/"+encodeURIComponent(cfRoute.id)+"/ai/run/"+model,
     {method:"POST",signal,headers:{"Authorization":"Bearer "+cfRoute.key,"Content-Type":"application/json"},
      body:JSON.stringify({messages:[{role:"system",content:"Ты переводчик. Верни только JSON объект с ключом translated_text. Сохрани полный порядок абзацев. Не сокращай, не добавляй фактов."},{role:"user",content:prompt}],
       temperature:0.1,reasoning_effort:"low",max_tokens:11000,response_format:{type:"json_object"}})});
    const raw=await res.text();try{parsed=JSON.parse(raw)}catch{parsed={}};
    if(res.ok&&parsed?.success!==false){
     const result=parsed.result||parsed;
     const value=result.response||result.choices?.[0]?.message?.content||result.output_text||"";
     let obj:any={};try{obj=typeof value==="string"?JSON.parse(value):value}catch{}
     translated=String(obj?.translated_text||"").trim();
     if(result.choices?.[0]?.finish_reason==="length")translated="";
     const u=result.usage||{};usage={prompt_tokens:Number(u.prompt_tokens||0),completion_tokens:Number(u.completion_tokens||0),total_tokens:Number(u.total_tokens||0)};
    }
   }
   if(res.ok&&translated.length>=text.length*0.45){
    console.info("l_translate_fallback_route "+JSON.stringify({requested:provider,selected:label,model,input_chars:text.length,output_chars:translated.length}));
    return json({translated_text:translated,provider:label==="gemini"?"gemini":label==="qwen"?"qwen":"cloudflare",requested_provider:provider,
      route:label,model,usage,limits});
   }
   lastError=res.ok?"translation_incomplete":label+"_http_"+res.status;
   console.warn("l_translate_provider_failure "+JSON.stringify({route:label,status:res.status,reason:lastError}));
  }catch(e){
   lastError=label+"_transport_or_timeout";
   console.warn("l_translate_provider_failure "+JSON.stringify({route:label,reason:lastError,kind:e instanceof Error?e.name:"unknown"}));
  }
 }
 return json({error:"translation_providers_unavailable",detail:lastError},503);
});