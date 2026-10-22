import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function versionAtLeast(current: string, minimum: string) {
  const parse = (value: string) => value.split(".").map((part) => Number(part.replace(/\D.*$/, "")) || 0);
  const a = parse(current), b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length, 3); i += 1) {
    const left = a[i] || 0, right = b[i] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") || "";

  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: authData, error: authError } = await client.auth.getUser();
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);

  const { data: profile, error: profileError } = await admin.from("monitor_profiles")
    .select("status")
    .eq("id", authData.user.id)
    .maybeSingle();
  if (profileError || !profile || profile.status !== "active") return json({ error: "access_denied" }, 403);

  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: "invalid_multipart" }, 400); }

  const file = form.get("file");
  // The desktop client carries a Groq 429 circuit only for the CURRENT video.
  // Fallback works as before, but later fragments do not repeatedly hit RPM.
  const skipGroq = String(form.get("skip_groq")||"") === "true";
  const appVersion = String(form.get("app_version") || "0.0.0");
  if (!(file instanceof File)) return json({ error: "file_required" }, 400);

  const { data: runtime, error: runtimeError } = await admin.from("monitor_runtime_config")
    .select("minimum_allowed_version,latest_version,update_mode")
    .eq("id", true)
    .maybeSingle();
  if (runtimeError) return json({ error: "version_check_failed" }, 503);
  const minimumSupported = String(runtime?.minimum_allowed_version || "0.0.0");
  const latest = String(runtime?.latest_version || minimumSupported);
  const effectiveMinimum = runtime?.update_mode === "required" ? latest : minimumSupported;
  if (!versionAtLeast(appVersion, effectiveMinimum)) {
    return json({ error: "APP_UPDATE_REQUIRED", effective_minimum_version: effectiveMinimum, latest_version: latest }, 426);
  }

  const maxBytes = 22 * 1024 * 1024;
  if (file.size <= 0) return json({ error: "empty_media" }, 400);
  if (file.size > maxBytes) return json({ error: "media_too_large", max_bytes: maxBytes, actual_bytes: file.size }, 413);

  const groqKey = Deno.env.get("GROQ_TRANSCRIPTION_API_KEY") || "";
  const routes=[
    {name:"groq_whisper",id:"",key:groqKey,model:"whisper-large-v3"},
    {name:"cloudflare_whisper_primary",id:Deno.env.get("CLOUDFLARE_ACCOUNT_ID")||"",key:Deno.env.get("CLOUDFLARE_API_TOKEN")||"",model:"@cf/openai/whisper-large-v3-turbo"},
    {name:"cloudflare_whisper_backup",id:Deno.env.get("CLOUDFLARE_BACKUP_ACCOUNT_ID")||"",key:Deno.env.get("CLOUDFLARE_BACKUP_API_TOKEN")||"",model:"@cf/openai/whisper-large-v3-turbo"}
  ];
  const deadline=Date.now()+137000;
  let lastError="transcription_not_configured";
  let groqRateLimited=false;
  // Desktop already sends short, overlapping MP3 excerpts (usually 45 seconds).
  // Do not convert long original videos inside Supabase. Preserve time segments
  // so its midpoint-based de-duplication across fragments remains functional.
  for(const route of routes){
    if(route.name==="groq_whisper"&&skipGroq)continue;
    if(!route.key||(route.name!=="groq_whisper"&&(!route.id||
       (route.name==="cloudflare_whisper_backup"&&route.id===routes[1].id))))continue;
    // A Cloudflare request needs base64 audio; avoid expansion of 22MB multipart.
    if(route.name!=="groq_whisper"&&file.size>8*1024*1024)continue;
    const available=deadline-Date.now()-8000;
    const timeout=Math.min(route.name==="groq_whisper"?44000:56000,available);
    if(timeout<8000)break;
    try{
      let response:Response;
      if(route.name==="groq_whisper"){
        const outgoing=new FormData();
        outgoing.append("file",file,file.name||"audio.mp3");
        outgoing.append("model",route.model);
        outgoing.append("response_format","verbose_json");
        outgoing.append("timestamp_granularities[]","segment");
        outgoing.append("temperature","0");
        response=await fetch("https://api.groq.com/openai/v1/audio/transcriptions",
          {method:"POST",signal:AbortSignal.timeout(timeout),headers:{Authorization:"Bearer "+route.key},body:outgoing});
      }else{
        const bytes=new Uint8Array(await file.arrayBuffer());
        const chunks:string[]=[];
        for(let i=0;i<bytes.length;i+=8192)
          chunks.push(String.fromCharCode(...bytes.subarray(i,i+8192)));
        const audio=btoa(chunks.join(""));
        response=await fetch("https://api.cloudflare.com/client/v4/accounts/"+encodeURIComponent(route.id)+"/ai/run/"+route.model,
          {method:"POST",signal:AbortSignal.timeout(timeout),
           headers:{Authorization:"Bearer "+route.key,"Content-Type":"application/json"},
           body:JSON.stringify({audio,task:"transcribe",vad_filter:false})});
      }
      const raw=await response.text();let result:any={};
      try{result=JSON.parse(raw)}catch{}
      const payload=route.name==="groq_whisper"?result:(result.result||result);
      const transcript=String(payload?.text||"").trim();
      if(response.ok&&result?.success!==false&&transcript){
        const rawSegments=Array.isArray(payload?.segments)?payload.segments.slice(0,500):[];
        const duration=Number(payload?.duration||payload?.transcription_info?.duration||0);
        // Cloudflare/Groq use seconds, but occasionally supply no or unusable
        // segment metadata. Never pretend that missing timing means missing text.
        const segments=rawSegments.map((s:any)=>({
          start:Number(s?.start),end:Number(s?.end),text:String(s?.text||"").trim()
        })).filter((s:{start:number;end:number;text:string})=>
          Boolean(s.text)&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&
          s.start>=0&&s.end>=s.start&&
          (!Number.isFinite(duration)||duration<=0||s.end<=duration+3));
        const timingStatus=segments.length>0?"valid":rawSegments.length>0?"invalid":"missing";
        const language=String(payload?.language||payload?.transcription_info?.language||"");
        console.info("media_transcribe_route "+JSON.stringify({
          route:route.name,bytes:file.size,segments:segments.length,
          raw_segments:rawSegments.length,timing_status:timingStatus,
          skipped_groq:skipGroq,groq_limited:groqRateLimited
        }));
        return json({text:transcript,language,duration,segments,model:route.model,
          provider:route.name,bytes:file.size,timing_status:timingStatus,
          raw_segment_count:rawSegments.length,groq_rate_limited:groqRateLimited});
      }
      if(route.name==="groq_whisper"&&response.status===429)groqRateLimited=true;
      lastError=response.ok?"transcription_invalid_output":route.name+"_http_"+response.status;
      console.warn("media_transcribe_provider_failure "+JSON.stringify({route:route.name,status:response.status,reason:lastError}));
    }catch(e){
      lastError=route.name+"_transport_or_timeout";
      console.warn("media_transcribe_provider_failure "+JSON.stringify({route:route.name,reason:lastError,kind:e instanceof Error?e.name:"unknown"}));
    }
  }
  return json({error:"transcription_providers_unavailable",detail:lastError,groq_rate_limited:groqRateLimited},503);
});