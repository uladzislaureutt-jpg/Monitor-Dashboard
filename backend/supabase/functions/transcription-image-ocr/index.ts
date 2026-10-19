import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return json({error:"method_not_allowed"},405);
 const url=Deno.env.get("SUPABASE_URL")!,anon=Deno.env.get("SUPABASE_ANON_KEY")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
 const token=req.headers.get("Authorization")||"";
 const client=createClient(url,anon,{global:{headers:{Authorization:token}},auth:{persistSession:false}});
 const admin=createClient(url,service,{auth:{persistSession:false}});
 const {data:auth,error:authError}=await client.auth.getUser();if(authError||!auth.user)return json({error:"unauthorized"},401);
 const {data:profile,error:profileError}=await admin.from("monitor_profiles").select("status").eq("id",auth.user.id).maybeSingle();
 if(profileError||profile?.status!=="active")return json({error:"access_denied"},403);
 let form:FormData;try{form=await req.formData()}catch{return json({error:"invalid_multipart"},400)}
 const file=form.get("image");if(!(file instanceof File))return json({error:"image_required"},400);
 const types=["image/png","image/jpeg","image/webp"];
 if(!types.includes(file.type)||file.size<=0||file.size>8*1024*1024)return json({error:"unsupported_image_or_size",max_bytes:8*1024*1024},400);
 const key=Deno.env.get("GEMINI_API_KEY")||Deno.env.get("GOOGLE_GEMINI_API_KEY")||Deno.env.get("GOOGLE_API_KEY")||"";
 const cf=[
   {route:"cloudflare_vision_primary",id:Deno.env.get("CLOUDFLARE_ACCOUNT_ID")||"",key:Deno.env.get("CLOUDFLARE_API_TOKEN")||""},
   {route:"cloudflare_vision_backup",id:Deno.env.get("CLOUDFLARE_BACKUP_ACCOUNT_ID")||"",key:Deno.env.get("CLOUDFLARE_BACKUP_API_TOKEN")||""}
 ];
 const bytes=new Uint8Array(await file.arrayBuffer());
 const chunks:string[]=[];for(let i=0;i<bytes.length;i+=8192)chunks.push(String.fromCharCode(...bytes.subarray(i,i+8192)));
 const image=btoa(chunks.join(""));
 const prompt="Дословно распознай только видимый текст, написанный поверх видеокадра или присутствующий в изображении. Не пересказывай, не дополняй пропущенные слова по смыслу и не описывай изображение. Сохраняй язык, строки, имена и числа. Неразборчивое помечай [неразборчиво]. Верни только распознанный текст.";
 const routes=[{route:"gemini",id:"",key},...cf];
 const deadline=Date.now()+137000;
 let lastError="ocr_not_configured";
 for(const route of routes){
   if(!route.key||(route.route!=="gemini"&&(!route.id||(route.route==="cloudflare_vision_backup"&&route.id===cf[0].id))))continue;
   const remaining=deadline-Date.now()-8000;
   const budget=Math.min(route.route==="gemini"?40000:55000,remaining);
   if(budget<8000)break;
   try{
     let res:Response,result:any={};
     let model="",text="";
     if(route.route==="gemini"){
       model="gemini-3.5-flash-lite";
       res=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent",{
         method:"POST",signal:AbortSignal.timeout(budget),headers:{"x-goog-api-key":route.key,"Content-Type":"application/json"},
         body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt},{inline_data:{mime_type:file.type,data:image}}]}],generationConfig:{temperature:0,maxOutputTokens:3000}})});
       const raw=await res.text();try{result=JSON.parse(raw)}catch{}
       if(res.ok)text=String((result.candidates?.[0]?.content?.parts||[]).map((p:{text?:string})=>p.text||"").join("")).trim();
       if(result.candidates?.[0]?.finishReason==="MAX_TOKENS")text="";
     }else{
       model="@cf/meta/llama-4-scout-17b-16e-instruct";
       res=await fetch("https://api.cloudflare.com/client/v4/accounts/"+encodeURIComponent(route.id)+"/ai/run/"+model,{
         method:"POST",signal:AbortSignal.timeout(budget),headers:{"Authorization":"Bearer "+route.key,"Content-Type":"application/json"},
         body:JSON.stringify({messages:[{role:"user",content:[{type:"text",text:prompt},{type:"image_url",image_url:{url:"data:"+file.type+";base64,"+image}}]}],temperature:0,max_tokens:3500})});
       const raw=await res.text();try{result=JSON.parse(raw)}catch{}
       if(res.ok&&result.success!==false){
         const p=result.result||result;
         text=String(p.response||p.choices?.[0]?.message?.content||p.output_text||"").trim();
       }
     }
     if(res.ok&&text){
       console.info("screenshot_ocr_route "+JSON.stringify({route:route.route,model,bytes:file.size,chars:text.length}));
       return json({text,model,provider:route.route});
     }
     lastError=res.ok?"ocr_empty_or_invalid_output":route.route+"_http_"+res.status;
     console.warn("screenshot_ocr_provider_failure "+JSON.stringify({route:route.route,status:res.status,reason:lastError}));
   }catch(e){
     lastError=route.route+"_transport_or_timeout";
     console.warn("screenshot_ocr_provider_failure "+JSON.stringify({route:route.route,reason:lastError,kind:e instanceof Error?e.name:"unknown"}));
   }
 }
 return json({error:"ocr_providers_unavailable",detail:lastError},503);
});