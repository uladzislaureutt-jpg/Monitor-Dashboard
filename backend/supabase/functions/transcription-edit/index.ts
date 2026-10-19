import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json"}});
Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="POST")return json({error:"method_not_allowed"},405);
  const url=Deno.env.get("SUPABASE_URL")!,anon=Deno.env.get("SUPABASE_ANON_KEY")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth=req.headers.get("Authorization")||"";
  const userClient=createClient(url,anon,{global:{headers:{Authorization:auth}},auth:{persistSession:false}});
  const admin=createClient(url,service,{auth:{persistSession:false}});
  const {data:session,error:authError}=await userClient.auth.getUser();
  if(authError||!session.user)return json({error:"unauthorized"},401);
  const {data:profile,error:profileError}=await admin.from("monitor_profiles").select("status").eq("id",session.user.id).maybeSingle();
  if(profileError||profile?.status!=="active")return json({error:"access_denied"},403);
  let body:{text?:string;app_version?:string};
  try{body=await req.json()}catch{return json({error:"invalid_json"},400)}
  const text=String(body.text||"").trim();
  if(text.length<50||text.length>30000)return json({error:"invalid_length"},400);
  const {data:config,error:configError}=await admin.from("monitor_runtime_config").select("minimum_allowed_version,latest_version,update_mode").eq("id",true).maybeSingle();
  if(configError)return json({error:"version_check_failed"},503);
  const atLeast=(a:string,b:string)=>{const x=a.split(".").map(Number),y=b.split(".").map(Number);for(let i=0;i<3;i++){if((x[i]||0)>(y[i]||0))return true;if((x[i]||0)<(y[i]||0))return false}return true};
  const required=String(config?.update_mode==="required"?config.latest_version:config?.minimum_allowed_version||"0.0.0");
  if(!atLeast(String(body.app_version||"0.0.0"),required))return json({error:"APP_UPDATE_REQUIRED"},426);
  const prompt="Ты профессиональный редактор устной речи. Исправь только достоверные ошибки распознавания, орфографию, пунктуацию и грамматику. Убирай слова-паразиты лишь когда это не меняет смысла. Сохраняй все имена, даты, числа, факты, интонацию и смысл, не добавляй новые сведения. Не добавляй заголовок, ник автора и внешние кавычки. Не сокращай материал содержательно. Верни JSON с единственным полем edited_text.\n\nИсходная транскрипция:\n"+text;
  const geminiKey=Deno.env.get("GEMINI_API_KEY")||Deno.env.get("GOOGLE_GEMINI_API_KEY")||Deno.env.get("GOOGLE_API_KEY")||"";
  const cf=[
   {route:"cloudflare_primary",id:Deno.env.get("CLOUDFLARE_ACCOUNT_ID")||"",key:Deno.env.get("CLOUDFLARE_API_TOKEN")||""},
   {route:"cloudflare_backup",id:Deno.env.get("CLOUDFLARE_BACKUP_ACCOUNT_ID")||"",key:Deno.env.get("CLOUDFLARE_BACKUP_API_TOKEN")||""}
  ];
  const routes=[{route:"gemini",id:"",key:geminiKey},...cf];
  const deadline=Date.now()+137000;
  let lastError="no_configured_provider";
  for(const route of routes){
   if(!route.key||(route.route!=="gemini"&&(!route.id||
      (route.route==="cloudflare_backup"&&route.id===cf[0].id))))continue;
   const remaining=deadline-Date.now()-8000;
   const budget=Math.min(route.route==="gemini"?40000:route.route==="cloudflare_primary"?64000:35000,remaining);
   if(budget<8000)break;
   try{
    let res:Response,body:any={},edited="",model="",usage:any={};
    if(route.route==="gemini"){
     model="gemini-3.5-flash-lite";
     res=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent",
      {method:"POST",signal:AbortSignal.timeout(budget),headers:{"x-goog-api-key":route.key,"Content-Type":"application/json"},
       body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.1,
        maxOutputTokens:14000,responseMimeType:"application/json",responseSchema:{type:"OBJECT",properties:{edited_text:{type:"STRING"}},required:["edited_text"]}}})});
     const raw=await res.text();try{body=JSON.parse(raw)}catch{}
     if(res.ok&&body.candidates?.[0]?.finishReason!=="MAX_TOKENS"){
      const answer=(body.candidates?.[0]?.content?.parts||[]).map((p:{text?:string})=>p.text||"").join("");
      try{edited=String(JSON.parse(answer).edited_text||"").trim()}catch{}
     }
    }else{
     model="@cf/openai/gpt-oss-120b";
     res=await fetch("https://api.cloudflare.com/client/v4/accounts/"+encodeURIComponent(route.id)+"/ai/run/"+model,
      {method:"POST",signal:AbortSignal.timeout(budget),headers:{"Authorization":"Bearer "+route.key,"Content-Type":"application/json"},
       body:JSON.stringify({messages:[{role:"system",content:"Редактируй транскрипцию строго без сокращения, добавления фактов или смены смысла. Верни только JSON с edited_text."},{role:"user",content:prompt}],
        temperature:0.1,reasoning_effort:"low",max_tokens:11000,response_format:{type:"json_object"}})});
     const raw=await res.text();try{body=JSON.parse(raw)}catch{}
     if(res.ok&&body.success!==false){
      const response=body.result||body;
      const content=response.response||response.choices?.[0]?.message?.content||response.output_text||"";
      try{const obj=typeof content==="string"?JSON.parse(content):content;edited=String(obj?.edited_text||"").trim()}catch{}
      if(response.choices?.[0]?.finish_reason==="length")edited="";
      usage=response.usage||{};
     }
    }
    if(res.ok&&edited.length>=text.length*0.5&&edited.length<=text.length*1.4){
     console.info("transcription_edit_route "+JSON.stringify({route:route.route,model,input_chars:text.length,output_chars:edited.length}));
     return json({edited_text:edited,model,provider:route.route==="gemini"?"gemini":"cloudflare",route:route.route,usage});
    }
    lastError=res.ok?"edit_incomplete_or_invalid_length":route.route+"_http_"+res.status;
    console.warn("transcription_edit_provider_failure "+JSON.stringify({route:route.route,status:res.status,reason:lastError}));
   }catch(e){
    lastError=route.route+"_transport_or_timeout";
    console.warn("transcription_edit_provider_failure "+JSON.stringify({route:route.route,reason:lastError,kind:e instanceof Error?e.name:"unknown"}));
   }
  }
  return json({error:"transcription_edit_providers_unavailable",detail:lastError},503);
});