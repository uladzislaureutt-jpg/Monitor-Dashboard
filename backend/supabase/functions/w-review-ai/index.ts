import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { DOSSIER_INSTRUCTIONS, dossierSchema, normalizeDossier, makeSynthesisDossier } from "./editorial-dossier.ts";
import { W_REVIEW_GEMINI_PRIMARY, W_REVIEW_GEMINI_FALLBACK, W_REVIEW_GEMINI_ROUTES, wGeminiGenerationConfig } from "./gemini-routing.ts";
import { evidenceRouteKey, routesWithoutCircuit, suspendStructuralFailure, circuitExpiry } from "./provider-circuit.ts";
import { evidenceV2Instructions, evidenceV2Schema, makeEvidenceDocuments, renderEvidenceMaterials, verifyEvidenceCards, verifyEvidenceCardsIndividually, formatEvidenceCard, type EvidenceCard } from "./evidence-v2.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

async function enforceVersion(admin: any, appVersion: string) {
  const { data, error } = await admin.from("monitor_runtime_config")
    .select("minimum_allowed_version,latest_version,update_mode")
    .eq("id", true)
    .maybeSingle();
  if (error) return { ok: false, response: json({ error: "VERSION_CHECK_FAILED" }, 503) };
  const minimumSupported = String(data?.minimum_allowed_version || "0.0.0");
  const latest = String(data?.latest_version || minimumSupported);
  const updateMode = data?.update_mode === "required" ? "required" : "optional";
  const effectiveMinimum = updateMode === "required" ? latest : minimumSupported;
  if (!versionAtLeast(appVersion, effectiveMinimum)) {
    return { ok: false, response: json({
      error: "APP_UPDATE_REQUIRED",
      minimum_supported_version: minimumSupported,
      latest_version: latest,
      update_mode: updateMode,
      effective_minimum_version: effectiveMinimum,
    }, 426) };
  }
  return { ok: true, minimumSupported, latest, updateMode, effectiveMinimum };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
type ProviderDiagnostic = {kind:string;http_status:number;google_status:string;quota_metric:string;quota_id:string;retry_after:string|null;retryable:boolean;field_hint?:string};
type AiFailure = { ok: false; status: number; retryAfter: string | null; detail: string; diagnostic?: ProviderDiagnostic };
type AiSuccess = { ok: true; content: string; usage: Usage; finish_reason?: string; reasoning_tokens?: number };
type AiResult = AiFailure | AiSuccess;

async function callGroq(apiKey: string, payload: unknown): Promise<AiResult> {
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const raw = await response.text();
    if (!response.ok) return { ok: false, status: response.status, retryAfter: response.headers.get("retry-after"), detail: raw.slice(0, 1400) };
    let decoded: any;
    try { decoded = JSON.parse(raw); } catch { return { ok: false, status: 502, retryAfter: null, detail: "groq_invalid_response" }; }
    const content = decoded?.choices?.[0]?.message?.content;
    if (!content) return { ok: false, status: 502, retryAfter: null, detail: "groq_empty_response" };
    const usage = decoded?.usage || {};
    return { ok: true, content: String(content), usage: {
      prompt_tokens: Number(usage.prompt_tokens || 0),
      completion_tokens: Number(usage.completion_tokens || 0),
      total_tokens: Number(usage.total_tokens || 0),
    }, finish_reason: String(decoded?.choices?.[0]?.finish_reason || "").slice(0,30),
      reasoning_tokens: Number(usage?.completion_tokens_details?.reasoning_tokens ?? 0) };
  } catch (error) {
    return { ok: false, status: 502, retryAfter: null, detail: `groq_network_error: ${String(error).slice(0, 240)}` };
  }
}
// Cloudflare's raw Workers AI endpoint expects a plain schema; Groq accepts
// the OpenAI named schema wrapper. Enable schema only after endpoint testing:
// this GPT-OSS variant is absent from Cloudflare's documented supported list.
function cloudflareResponseFormat(payload:any) {
  if (Deno.env.get("W_REVIEW_CF_SCHEMA_MODE") !== "true") return {type:"json_object"};
  const requested=payload?.response_format;
  if (requested?.type !== "json_schema" || !requested?.json_schema) return {type:"json_object"};
  return {type:"json_schema",json_schema:requested.json_schema.schema || requested.json_schema};
}
async function callCloudflare(accountId: string, token: string, payload: any, timeoutMs=0): Promise<AiResult> {
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/accounts/"+encodeURIComponent(accountId)+"/ai/run/@cf/openai/gpt-oss-120b", {
      method:"POST",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},
      signal:timeoutMs>0?AbortSignal.timeout(timeoutMs):undefined,
      body:JSON.stringify({messages:payload.messages,temperature:Math.max(0,Math.min(1,Number(payload.temperature??0.1))),reasoning_effort:["low","medium","high"].includes(String(payload.reasoning_effort))?payload.reasoning_effort:"low",max_tokens:Math.max(800,Math.min(11000,payload.max_tokens||Math.min(4500,payload.max_completion_tokens||2400))),response_format:cloudflareResponseFormat(payload)})
    });
    const raw=await r.text();
    if(!r.ok)return {ok:false,status:r.status,retryAfter:r.headers.get("retry-after"),detail:raw.slice(0,900)};
    let data:any;try{data=JSON.parse(raw)}catch{return {ok:false,status:502,retryAfter:null,detail:"cloudflare_invalid_json"}}
    const answer=data.result||data;
    const rawContent=answer.response||answer.choices?.[0]?.message?.content||answer.output_text||answer.output?.filter((item:any)=>item.type==="message").flatMap((item:any)=>item.content||[]).filter((item:any)=>item.type==="output_text").map((item:any)=>item.text).join("\n")||answer.output?.[0]?.content?.[0]?.text;
    const content=typeof rawContent==="object" && rawContent!==null ? JSON.stringify(rawContent) : rawContent;
    if(typeof content!=="string"||!content.trim())return {ok:false,status:502,retryAfter:null,detail:"cloudflare_empty_reply: "+JSON.stringify({keys:Object.keys(answer||{}).slice(0,12),status:answer.status,finish_reason:answer.choices?.[0]?.finish_reason,usage:answer.usage,output_types:Array.isArray(answer.output)?answer.output.map((v:any)=>v.type).slice(0,5):undefined,errors:data.errors}).slice(0,500)};
    const u=answer.usage||{};
    return {ok:true,content,usage:{prompt_tokens:Number(u.prompt_tokens||0),completion_tokens:Number(u.completion_tokens||0),total_tokens:Number(u.total_tokens||0)},finish_reason:String(answer?.choices?.[0]?.finish_reason||answer?.finish_reason||"" ).slice(0,30),reasoning_tokens:Number(u?.completion_tokens_details?.reasoning_tokens||u?.output_tokens_details?.reasoning_tokens||0)};
  }catch(e){
    const kind=e instanceof Error?e.name:"unknown";
    if(kind==="TimeoutError"||kind==="AbortError")
      return {ok:false,status:504,retryAfter:null,detail:"cloudflare_local_timeout"};
    return {ok:false,status:502,retryAfter:null,detail:"cloudflare_transport_"+providerField(kind)};
  }
}
// Safe provider metadata only: never record model input, raw HTTP body, user ID or keys.
function providerField(v:unknown){return String(v||"").replace(/[^A-Za-z0-9._:/-]/g,"").slice(0,150);}
function geminiDiagnostic(status:number, raw:string, header:string|null):ProviderDiagnostic{
  let parsed:any={};try{parsed=JSON.parse(raw)}catch{ /* non-JSON upstream response */ }
  const err=parsed&&typeof parsed.error==="object"?parsed.error:{};
  const details=Array.isArray(err.details)?err.details:[];
  const violations=details.flatMap((x:any)=>Array.isArray(x?.violations)?x.violations:[]);
  const v=violations[0]||{};
  const quota_metric=providerField(v.quotaMetric||v.quota_metric);
  const quota_id=providerField(v.quotaId||v.quota_id);
  const msg=[String(err.message||""),quota_metric,quota_id,...violations.map((x:any)=>String(x.description||""))].join(" ").toLowerCase();
  let kind="provider_error";
  if(status===429){
    if(/rpd|daily|per.?day|perday|per_day|requests.?per.?day/i.test(msg))kind="daily_quota";
    else if(/tpm|token.{0,20}minute|minute.{0,20}token|tokensperminute|tokens_per_minute/i.test(msg))kind="minute_tokens";
    else if(/rpm|per.?minute|requests.{0,20}minute|requestsperminute|requests_per_minute/i.test(msg))kind="minute_requests";
    else if(/spend.?cap|prepay.{0,20}(deplet|exhaust)|billing.?account.{0,20}(disabled|suspended)|credit.?balance.{0,20}(deplet|exhaust)/i.test(msg))kind="billing_limit";
    else kind="quota_unknown";
  }else if([500,502,503].includes(status)&&/overload|high.?demand|capacity|model.?busy/i.test(msg))kind="overloaded";
  else if([500,502,503,504].includes(status))kind="unavailable";
  // Safe field names only, not Google's free-form error details (which could
  // reflect model inputs). This distinguishes schema errors from capacity.
  const fieldHint=String(err.message||"").match(/(?:responseFormat|responseSchema|responseMimeType|generationConfig|schema|type|propertyOrdering)/i)?.[0]||"";
  const retryInfo=details.find((x:any)=>typeof x?.retryDelay==="string");
  const hint=String(header||retryInfo?.retryDelay||"").trim();
  const retry_after=/^\d+(?:\.\d+)?s?$/.test(hint)?hint:null;
  return {kind,http_status:status,google_status:providerField(err.status),quota_metric,quota_id,retry_after,
    retryable:kind==="minute_tokens"||kind==="minute_requests",field_hint:providerField(fieldHint)};
}
function reportGeminiFailure(stage:string,model:string,diagnostic:ProviderDiagnostic){
  console.warn("w_review_provider_failure "+JSON.stringify({provider:"gemini",stage,model:providerField(model),...diagnostic}));
}

async function callGemini(apiKey: string, model: string, prompt: string, schema: unknown, _temperature = 0.1, stage = "unknown", timeoutMs=0, options?:{maxOutputTokens?:number;thinkingLevel?:"minimal"|"low"|"medium"|"high"}): Promise<AiResult> {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      signal: timeoutMs>0?AbortSignal.timeout(timeoutMs):undefined,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: wGeminiGenerationConfig(schema,options),
      }),
    });
    const raw = await response.text();
    if (!response.ok) {
      const diagnostic=geminiDiagnostic(response.status,raw,response.headers.get("retry-after"));
      reportGeminiFailure(stage,model,diagnostic);
      return {ok:false,status:response.status,retryAfter:diagnostic.retry_after,detail:"gemini_"+diagnostic.kind,diagnostic};
    }
    let decoded: any;
    try { decoded = JSON.parse(raw); } catch {
      const diagnostic:ProviderDiagnostic={kind:"invalid_response",http_status:200,google_status:"",
        quota_metric:"",quota_id:"",retry_after:null,retryable:false};
      reportGeminiFailure(stage,model,diagnostic);
      return {ok:false,status:502,retryAfter:null,detail:"gemini_invalid_response",diagnostic};
    }
    const parts = decoded?.candidates?.[0]?.content?.parts;
    const content = Array.isArray(parts) ? parts.map((part: any) => String(part?.text || "")).join("").trim() : "";
    if (!content) {
      const diagnostic:ProviderDiagnostic={kind:"empty_response",http_status:200,google_status:"",
        quota_metric:"",quota_id:"",retry_after:null,retryable:false};
      reportGeminiFailure(stage,model,diagnostic);
      return {ok:false,status:502,retryAfter:null,detail:"gemini_empty_response",diagnostic};
    }
    const usage = decoded?.usageMetadata || {};
    return { ok: true, content, usage: {
      prompt_tokens: Number(usage.promptTokenCount || 0),
      completion_tokens: Number(usage.candidatesTokenCount || 0),
      total_tokens: Number(usage.totalTokenCount || 0),
    },finish_reason:String(decoded?.candidates?.[0]?.finishReason||"").slice(0,30),
    reasoning_tokens:Number(usage.thoughtsTokenCount||0) };
  } catch (_error) {
    const diagnostic:ProviderDiagnostic={kind:"network_error",http_status:502,google_status:"",
      quota_metric:"",quota_id:"",retry_after:null,retryable:false};
    reportGeminiFailure(stage,model,diagnostic);
    return {ok:false,status:502,retryAfter:null,detail:"gemini_network_error",diagnostic};
  }
}
function density(value: unknown) { return value === "minimum" || value === "many" || value === "all" ? value : "moderate"; }
function normalizeAnchor(value: string) {
  return value.toLocaleLowerCase("ru-RU").replace(/[\s\u00a0]+/g, " ").trim();
}
function suspiciousAnchors(review: string, evidence: string) {
  const found = new Set<string>();
  const candidates = [
    ...(review.match(/\b\d[\d\s.,%–—-]{0,24}\b/g) || []),
    ...(review.match(/«[^»]{10,220}»/g) || []),
  ];
  const haystack = normalizeAnchor(evidence);
  for (const raw of candidates) {
    const value = raw.trim();
    if (value.length < 2) continue;
    if (!haystack.includes(normalizeAnchor(value))) found.add(value);
    if (found.size >= 30) break;
  }
  return Array.from(found);
}

function lightPreflightWarnings(review: string, evidence: string): string[] {
  // No second model call: inexpensive diagnostic checks before returning the one generated draft.
  // Signals are advisory, never block the editor or DOCX export.
  const warnings: string[] = [];
  const numbers = (value: string) => Array.from(value.matchAll(/\b\d+(?:[ \u00a0]\d{3})*(?:[.,]\d+)?\b/g))
    .map((entry) => entry[0].replace(/[\s\u00a0]/g, "").replace(",", "."));
  const knownNumbers = new Set(numbers(evidence));
  for (const number of new Set(numbers(review))) {
    if (!knownNumbers.has(number)) warnings.push("число " + number);
    if (warnings.length >= 4) break;
  }
  // Check only plausible personal names; inflected surnames are compared by a stable root.
  const haystack = evidence.toLocaleLowerCase("ru-RU");
  const properNames = Array.from(new Set(review.match(/[А-ЯЁ][а-яё]{2,}\s+[А-ЯЁ][а-яё]{3,}/g) || []));
  for (const fullName of properNames) {
    const surname = fullName.split(/\s+/).at(-1)!.toLocaleLowerCase("ru-RU");
    const root = surname.slice(0, Math.max(4, surname.length - 2));
    if (root.length >= 4 && !haystack.includes(root)) warnings.push("имя/название «" + fullName + "»");
    if (warnings.length >= 6) break;
  }
  return warnings.slice(0, 6);
}

function parseModelJson(result: { content: string }) { try { return JSON.parse(result.content); } catch { return null; } }
function aiError(provider: "groq" | "gemini" | "cloudflare", result: AiFailure) {
  const rate = result.status === 429;
  return json({
    error: rate ? `${provider}_rate_limit` : `${provider}_error`,
    detail: result.detail,
    retry_after: result.retryAfter,
    provider,
  }, rate ? 429 : 502);
}

const evidencePrompt = evidenceV2Instructions;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") || "";
  const client = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: authData, error: authError } = await client.auth.getUser();
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);
  const { data: profile, error: profileError } = await admin.from("monitor_profiles").select("is_admin,status").eq("id", authData.user.id).maybeSingle();
  if (profileError || !profile || profile.status !== "active") return json({ error: "access_denied" }, 403);
  if (!profile.is_admin) {
    const [{ data: moduleAccess, error: moduleError }, { data: personalAccess, error: personalError }] = await Promise.all([
      admin.from("monitor_access").select("enabled").eq("monitor_key", "w_review").maybeSingle(),
      admin.from("user_monitor_access").select("enabled").eq("user_id", authData.user.id).eq("monitor_key", "w_review").maybeSingle(),
    ]);
    if (moduleError || personalError) return json({ error: "w_review_access_check_failed" }, 503);
    if (!moduleAccess?.enabled || !personalAccess?.enabled) return json({ error: "w_review_disabled" }, 403);
  }

  const groqApiKey = Deno.env.get("GROQ_W_REVIEW_API_KEY") || "";
  const geminiApiKey = Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_GEMINI_API_KEY") || Deno.env.get("GOOGLE_API_KEY") || "";
  // Ignore a stale GEMINI_W_REVIEW_MODEL pointing to a 3.6 endpoint.
  const geminiModel = W_REVIEW_GEMINI_PRIMARY;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const versionCheck = await enforceVersion(admin, String(body?.app_version || "0.8.11"));
  if (!versionCheck.ok) return versionCheck.response;
  const action = String(body?.action || "");

  if (action === "evidence_batch") {
    // Prefer the backup account for evidence, preserving the primary account
    // for the single final 120B synthesis. One CF attempt per failed batch.
    const cfEvidenceBackupId=Deno.env.get("CLOUDFLARE_BACKUP_ACCOUNT_ID")||"";
    const cfEvidenceBackupToken=Deno.env.get("CLOUDFLARE_BACKUP_API_TOKEN")||"";
    const cfEvidencePrimaryId=Deno.env.get("CLOUDFLARE_ACCOUNT_ID")||"";
    const cfEvidencePrimaryToken=Deno.env.get("CLOUDFLARE_API_TOKEN")||"";
    const hasCfEvidenceBackup=Boolean(cfEvidenceBackupId&&cfEvidenceBackupToken);
    const cfEvidenceId=hasCfEvidenceBackup?cfEvidenceBackupId:cfEvidencePrimaryId;
    const cfEvidenceToken=hasCfEvidenceBackup?cfEvidenceBackupToken:cfEvidencePrimaryToken;
    if (!geminiApiKey && !groqApiKey && !(cfEvidenceId&&cfEvidenceToken))
      return json({ error: "w_review_evidence_providers_not_configured" }, 503);
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) return json({ error: "no_items" }, 400);
    if (items.length > 2) return json({ error:"evidence_batch_too_large", max_items:2 },400);
    let totalChars = 0;
    const normalized = items.map((item: any, index: number) => {
      const text = String(item?.text || "").trim();
      totalChars += text.length;
      return { index, publication_id:String(item?.publication_id || "batch-"+index).trim().slice(0,120),
        source: String(item?.source || "").trim().slice(0, 300), title: String(item?.title || "").trim().slice(0, 600), text };
    });
    if (normalized.some((item: any) => !item.text || item.text.length > 10000) || totalChars > 20000)
      return json({error:"evidence_article_too_long",max_article_chars:10000,max_batch_chars:20000,max_items:2},400);
    const documents = makeEvidenceDocuments(normalized);
    const materialText = renderEvidenceMaterials(documents);
    const schema = evidenceV2Schema(normalized.length);
    const prompt = evidencePrompt+"\n\nВерни ровно "+normalized.length+
      " карточек, строго в порядке MATERIAL_1, MATERIAL_2 и т. д.\n\n"+materialText;
    // A 400 INVALID_ARGUMENT is structural, not a reason to retry the same
    // payload for every two-article batch. Service-only DB circuit is shared
    // across Edge isolates and operators; failures fail open to normal routing.
    let disabledRoutes:string[]=[];
    if (geminiApiKey) {
      const {data:circuit,error:circuitError}=await admin.from("w_review_provider_circuit")
        .select("route").gt("suspended_until",new Date().toISOString())
        .like("route","evidence_batch:%");
      if (!circuitError && Array.isArray(circuit))
        disabledRoutes=circuit.map((row:any)=>String(row.route));
      else if (circuitError)
        console.warn("w_review_provider_circuit_read_failed");
    }
    const models=geminiApiKey?routesWithoutCircuit(W_REVIEW_GEMINI_ROUTES,disabledRoutes):[];
    if (disabledRoutes.length) console.info("w_review_provider_circuit_skip "+
      JSON.stringify({stage:"evidence_batch",models_skipped:W_REVIEW_GEMINI_ROUTES.length-models.length}));
    async function suspendGeminiModel(model:string,status:number,googleStatus:string) {
      if(!suspendStructuralFailure(status,googleStatus))return;
      const {error}=await admin.from("w_review_provider_circuit").upsert({
        route:evidenceRouteKey(model),suspended_until:circuitExpiry(new Date()),
        reason_code:"INVALID_ARGUMENT",http_status:400,updated_at:new Date().toISOString()
      },{onConflict:"route"});
      if(error)console.warn("w_review_provider_circuit_write_failed");
      else console.info("w_review_provider_circuit_open "+JSON.stringify({stage:"evidence_batch",model,minutes:15}));
    }
    let result: AiResult | null = null;
    let parsed: any = null;
    let verifiedCards: EvidenceCard[] = [];
    let usedModel = "";
    let lastError = "";
    let lastGeminiFailure:AiFailure|null=null;
    const attemptedRoutes:Array<{model:string;status:number;cause:string}> = [];
    type PartialResponse={accepted:Array<{index:number;card:EvidenceCard}>;result:AiSuccess;model:string};
    let bestPartial:PartialResponse|null=null;
    function considerPartial(candidate:AiSuccess,data:any,model:string){
      const attempt=verifyEvidenceCardsIndividually(data,documents);
      if(attempt.accepted.length && (!bestPartial ||
          attempt.accepted.length>bestPartial.accepted.length ||
          (attempt.accepted.length===bestPartial.accepted.length &&
           attempt.accepted.reduce((n,v)=>n+v.card.validation.accepted,0)>
           bestPartial.accepted.reduce((n,v)=>n+v.card.validation.accepted,0))))
        bestPartial={accepted:attempt.accepted,result:candidate,model};
      if(attempt.failed.length)console.info("w_review_evidence_partial_diagnostic "+JSON.stringify({
        model,accepted_articles:attempt.accepted.map(v=>v.index+1),
        failed:attempt.failed.map(v=>({article:v.index+1,reason:v.reason}))
      }));
    }
    gemini_models: for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const candidate = await callGemini(geminiApiKey, model, prompt, schema, 0.1, "evidence_batch");
        if (candidate.ok) {
          const data = parseModelJson(candidate);
          const verified=verifyEvidenceCards(data,documents);
          if(!verified.error){
            result=candidate;parsed=data;verifiedCards=verified.cards;usedModel=model;break;
          }
          lastError=model+": "+verified.error;
          considerPartial(candidate,data,model);
          attemptedRoutes.push({model,status:422,cause:verified.error});
        } else {
          lastGeminiFailure=candidate;
          lastError = model + ": HTTP " + candidate.status + " " + candidate.detail;
          attemptedRoutes.push({model,status:candidate.status,cause:candidate.diagnostic?.kind||candidate.detail.slice(0,90)});
          await suspendGeminiModel(model,candidate.status,candidate.diagnostic?.google_status||"");
          if (candidate.status === 429) break gemini_models; // Immediately use Groq instead of repeating Gemini.
          if (![500, 502, 503, 504].includes(candidate.status)) break;
        }
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 1200));
      }
      if (result) break;
    }
    if ((!result || !parsed) && cfEvidenceId && cfEvidenceToken) {
      console.info("w_review_provider_fallback "+JSON.stringify({
        stage:"evidence_batch",from:"gemini",to:"cloudflare_gpt_oss_120b",
        trigger:lastGeminiFailure?.diagnostic?.kind||"unverified_evidence"
      }));
      // JSON mode is explicitly requested, even when global schema mode is
      // disabled. Source excerpts remain subject to deterministic verification.
      const cfResult=await callCloudflare(cfEvidenceId,cfEvidenceToken,{
        reasoning_effort:"low",temperature:0.1,max_tokens:9000,
        response_format:{type:"json_object"},
        messages:[
          {role:"system",content:evidencePrompt+
            "\nКаждая дословная выдержка SOURCE должна точно встречаться в указанном фрагменте. "+
            "Не обрывай покрытие после вводных абзацев. Верни полный JSON cards."},
          {role:"user",content:prompt}
        ]
      },80000);
      if(cfResult.ok){
        const cfData=parseModelJson(cfResult);
        const verified=verifyEvidenceCards(cfData,documents);
        if(!verified.error){
          result=cfResult;parsed=cfData;verifiedCards=verified.cards;usedModel="@cf/openai/gpt-oss-120b";
        }else{
          lastError+="; cloudflare_"+verified.error;
          considerPartial(cfResult,cfData,"@cf/openai/gpt-oss-120b");
          attemptedRoutes.push({model:"@cf/openai/gpt-oss-120b",status:422,cause:verified.error});
        }
      }else{
        lastError+="; cloudflare_"+(cfResult.detail==="cloudflare_local_timeout"?"local_timeout":"HTTP_"+cfResult.status);
        const reason=cfResult.detail==="cloudflare_local_timeout"?"local_timeout":
          cfResult.detail.startsWith("cloudflare_empty_reply")?"empty_reply":"provider_or_transport";
        console.warn("w_review_cloudflare_evidence_failure "+JSON.stringify({
          reason,http_status:cfResult.status,timeout_ms:80000,
          account_route:hasCfEvidenceBackup?"backup":"primary"
        }));
        attemptedRoutes.push({model:"@cf/openai/gpt-oss-120b",status:cfResult.status,cause:reason});
      }
    }
    if ((!result || !parsed) && groqApiKey) {
      console.info("w_review_provider_fallback "+JSON.stringify({stage:"evidence_batch",from:"gemini",to:"groq",
        trigger:lastGeminiFailure?.diagnostic?.kind||"other",http_status:lastGeminiFailure?.status||null}));
      const groqResult = await callGroq(groqApiKey, {
        model: "openai/gpt-oss-20b",
        reasoning_effort: "low",
        reasoning_format: "hidden",
        temperature: 0.1,
        response_format: { type: "json_object" },
        max_completion_tokens: 7000,
        messages: [
          {role: "system", content: evidencePrompt},
          {role: "user", content: prompt}
        ]
      });
      if (groqResult.ok) {
        const data = parseModelJson(groqResult);
        const verified=verifyEvidenceCards(data,documents);
        if(!verified.error){
          result=groqResult;parsed=data;verifiedCards=verified.cards;usedModel="openai/gpt-oss-20b";
        } else {
          lastError += "; groq_"+verified.error;
          considerPartial(groqResult,data,"openai/gpt-oss-20b");
          attemptedRoutes.push({model:"openai/gpt-oss-20b",status:422,cause:verified.error});
        }
      } else {
        lastError += "; groq_HTTP_" + groqResult.status + ": " + groqResult.detail.slice(0, 200);
        attemptedRoutes.push({model:"openai/gpt-oss-20b",status:groqResult.status,cause:"provider_error"});
      }
    }
    let cardIndices=normalized.map((_,i)=>i);
    if ((!result || !parsed) && bestPartial) {
      const selected=bestPartial as PartialResponse;
      result=selected.result;
      parsed={cards:[]};
      verifiedCards=selected.accepted.map(v=>v.card);
      cardIndices=selected.accepted.map(v=>v.index);
      usedModel=selected.model;
      console.warn("w_review_evidence_partial_return "+JSON.stringify({
        accepted_article_indices:cardIndices.map(i=>i+1),
        pending_articles:normalized.length-cardIndices.length,provider:usedModel
      }));
    }
    if (!result || !parsed) return json({error:"evidence_providers_unavailable",
      detail:lastError.slice(0,350),attempts:attemptedRoutes,provider:"gemini_cloudflare_groq",issue:lastGeminiFailure?.diagnostic||null,
      retryable:false},503);
    const sourceDigests=await Promise.all(normalized.map(async (item)=>{
      const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(item.text));
      return Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,"0")).join("");
    }));
    const cards=verifiedCards.map((card,index)=>({
      index:cardIndices[index],evidence:formatEvidenceCard(card),
      evidence_data:{...card,source_sha256:sourceDigests[cardIndices[index]]}
    }));
    console.info("w_review_evidence_v2 "+JSON.stringify({
      cards:cards.length,pending_articles:normalized.length-cards.length,accepted:verifiedCards.reduce((n,c)=>n+c.validation.accepted,0),
      rejected:verifiedCards.reduce((n,c)=>n+c.validation.rejected,0),
      covered_passages:verifiedCards.reduce((n,c)=>n+c.validation.covered_passages,0),
      total_passages:verifiedCards.reduce((n,c)=>n+c.validation.total_passages,0),
      provider:usedModel
    }));
    return json({cards,partial:cards.length<normalized.length,model:usedModel,
      provider:usedModel.startsWith("@cf/")?"cloudflare":usedModel.startsWith("openai/")?"groq":"gemini",usage:result.usage});
  }

  if (action === "style_profile") {
    // Author samples are kept intact. Groq's free-tier TPM cannot reliably process 4-5 full samples.
    const samples = Array.isArray(body?.samples)
      ? body.samples.map((v: unknown) => String(v || "").trim()).filter(Boolean).slice(0, 5) : [];
    const combined = samples.join("\n\n--- SAMPLE ---\n\n");
    if (!samples.length || combined.length > 70000) return json({ error: "invalid_samples", max_chars: 70000 }, 400);
    const cfAccount = Deno.env.get("CLOUDFLARE_ACCOUNT_ID") || "";
    const cfToken = Deno.env.get("CLOUDFLARE_API_TOKEN") || "";
    if (!(cfAccount && cfToken) && !geminiApiKey) return json({error:"w_review_style_providers_not_configured"},503);
    const sections = ["OPENING","COMPOSITION","PARAGRAPH_RHYTHM","QUOTES","HEADLINES",
      "SOURCE_ATTRIBUTION","EXPERTS","FACT_VS_INTERPRETATION","TRANSITIONS","GENERALIZATION",
      "ENDING","LEXICON","AVOID","FORMATTING_CUES"];
    const styleInstruction = `Построй STYLE PROFILE V2 по авторским образцам медиаобзоров. Не пересказывай содержание образцов и не копируй длинные фразы. Базовый жанр W-Review задан отдельно: обобщающий взгляд на медиаполе через главные смысловые акценты, а не последовательный разбор источников.
Желательно раскрыть все 14 тематических разделов со следующими заголовками (допустимы заголовки на русском языке и небольшие отклонения в оформлении):
${sections.join("; ")}.
В каждом разделе опиши конкретные повторяющиеся стилистические особенности, которые видны в образцах. Пиши по-русски. Объясни, КАК автор строит обзор, а не ЧТО он сообщил. Не выдумывай признаки, которых нельзя вывести из образцов.
Целевой объём самого style_profile — 5000–8000 знаков. Верни ОДИН JSON-объект с полем style_profile (строка), без Markdown вокруг JSON.`;
    const stylePrompt = styleInstruction + "\n\nАВТОРСКИЕ ОБРАЗЦЫ:\n" + combined;
    const schema={type:"OBJECT",properties:{style_profile:{type:"STRING"}},required:["style_profile"]};
    const quality = (value:AiResult) => {
      const data = value.ok ? parseModelJson(value) : null;
      const profile = typeof data?.style_profile === "string" ? data.style_profile.trim() : "";
      const found = sections.filter((name:string) => new RegExp("(?:^|\\n)\\s*(?:\\d{1,2}[.)]\\s*)?(?:\\*\\*)?" + name + "\\b", "im").test(profile));
      // Provider output may use Russian titles, bullets or inline labels. A missing
      // literal English heading is not evidence that a substantive profile is invalid.
      // Treat section count as advisory telemetry, not a hard pass/fail condition.
      return {profile,sectionsFound:found.length,ok:profile.length>=2000 && profile.length<=10000};
    };
    let result:AiResult=cfAccount && cfToken
      ? await callCloudflare(cfAccount,cfToken,{
          messages:[{role:"system",content:styleInstruction},{role:"user",content:combined}],
          max_tokens:6500
        })
      : {ok:false,status:503,retryAfter:null,detail:"cloudflare_unconfigured"};
    let check=quality(result);
    let usedProvider="cloudflare",usedModel="@cf/openai/gpt-oss-120b";
    if (!check.ok && geminiApiKey) {
      console.info("w_review_provider_fallback "+JSON.stringify({
        stage:"style_profile",from:"cloudflare",to:"gemini",
        trigger:result.ok?"insufficient_style_profile":"provider_error",
        http_status:result.ok?200:result.status,sections_found:check.sectionsFound
      }));
      const backup=await callGemini(geminiApiKey,"gemini-3.5-flash-lite",stylePrompt,schema,0.1,"style_profile_backup");
      const checkBackup=quality(backup);
      if (checkBackup.ok || (!check.ok && checkBackup.sectionsFound>check.sectionsFound && checkBackup.profile.length>=2500)) {
        result=backup;check=checkBackup;usedProvider="gemini";usedModel="gemini-3.5-flash-lite";
      } else if (!result.ok) {
        result=backup;check=checkBackup;usedProvider="gemini";usedModel="gemini-3.5-flash-lite";
      }
    }
    if (!check.ok) {
      console.warn("w_review_style_profile_incomplete "+JSON.stringify({
        provider:usedProvider,sections_found:check.sectionsFound,chars:check.profile.length
      }));
      if (!result.ok) return json({error:"style_providers_unavailable",provider:usedProvider,
        status:result.status,detail:String(result.detail).slice(0,180)},503);
      return json({error:"invalid_style_profile",provider:usedProvider,
        sections_found:check.sectionsFound,chars:check.profile.length,min_chars:2000},502);
    }
    return json({style_profile:check.profile,model:usedModel,provider:usedProvider,
      style_chars:check.profile.length,sections_found:check.sectionsFound,
      usage:result.ok?result.usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}});
  }

  if (action === "editorial_map") {
    if (!geminiApiKey && !groqApiKey) return json({ error: "w_review_map_providers_not_configured" }, 503);
    const task = String(body?.task || "").trim();
    if (!task || task.length > 2000) return json({ error: "invalid_task", max_chars: 2000 }, 400);
    const submittedCards = Array.isArray(body?.evidence_cards) ? body.evidence_cards : [];
    if (submittedCards.length > 18) return json({error:"w_review_max_articles",limit:18},400);
    const cards = submittedCards.map((v: unknown) => String(v || "").trim()).filter(Boolean);
    if (!cards.length) return json({ error: "no_evidence_cards" }, 400);
    const evidenceText = cards.map((card: string, index: number) => `P${String(index + 1).padStart(2, "0")}\n${card}`).join("\n\n");
    if (evidenceText.length > 180000) return json({ error: "evidence_too_large", max_chars: 180000 }, 400);
    const schema=dossierSchema(cards.length);
    const prompt=DOSSIER_INSTRUCTIONS+"\n\nЗАДАНИЕ ОПЕРАТОРА:\n"+task+
      "\n\nДОКАЗАТЕЛЬНАЯ БАЗА (P01:E01 — E01 в статье P01):\n"+evidenceText;
    let result:AiResult=geminiApiKey
      ? await callGemini(geminiApiKey, geminiModel, prompt, schema, 0.1, "editorial_map", 0, {maxOutputTokens:8192})
      : {ok:false,status:503,retryAfter:null,detail:"gemini_not_configured"};
    let usedGeminiMapModel=geminiModel;
    if (!result.ok && result.status !== 429 && geminiApiKey) {
      result = await callGemini(geminiApiKey, W_REVIEW_GEMINI_FALLBACK, prompt, schema, 0.1, "editorial_map_fallback", 0, {maxOutputTokens:8192});
      usedGeminiMapModel=W_REVIEW_GEMINI_FALLBACK;
    }
    let provider="gemini";
    const geminiProblem=!result.ok?result.diagnostic||null:null;
    const parsed=result.ok?parseModelJson(result):null;
    let checked=normalizeDossier(parsed,cards);
    if((!result.ok||checked.error)&&groqApiKey){
      console.info("w_review_provider_fallback "+JSON.stringify({
        stage:"editorial_dossier",from:"gemini",to:"groq",
        trigger:checked.error||(!result.ok?result.diagnostic?.kind:"invalid_schema")||"other"
      }));
      const fallback=await callGroq(groqApiKey,{
        model:"openai/gpt-oss-20b",response_format:{type:"json_object"},
        reasoning_effort:"low",reasoning_format:"hidden",max_completion_tokens:7600,
        messages:[{role:"system",content:DOSSIER_INSTRUCTIONS},{role:"user",content:prompt}]
      });
      if(fallback.ok){
        const candidate=normalizeDossier(parseModelJson(fallback),cards);
        if(!candidate.error){result=fallback;checked=candidate;provider="groq";}
      }
    }
    if(!result.ok)return json({error:"editorial_dossier_providers_unavailable",
      provider:"gemini_groq",issue:geminiProblem,retryable:false},503);
    if(checked.error||!checked.dossier)return json({error:"invalid_editorial_dossier",
      detail:checked.error||"unknown_dossier_error",provider},502);
    const docket=checked.dossier;
    console.info("w_review_dossier_v3 "+JSON.stringify({
      trends:docket.trends.length,branches:docket.trends.reduce((n,t)=>n+t.branches.length,0),
      mandatory:docket.trends.reduce((n,t)=>n+t.branches.filter(b=>b.required).length,0),
      publications:docket.coverage.length,
      used:docket.coverage.filter(c=>["used","supporting"].includes(c.status)).length
    }));
    return json({editorial_map:docket,model:provider==="groq"?"openai/gpt-oss-20b":usedGeminiMapModel,
      provider,usage:result.usage});
  }

  if (action === "verify_review") {
    if (!geminiApiKey) return json({ error: "w_review_gemini_not_configured" }, 503);
    const review = String(body?.review_text || "").trim();
    const task = String(body?.task || "").trim();
    const cards = Array.isArray(body?.evidence_cards) ? body.evidence_cards.map((v: unknown) => String(v || "").trim()).filter(Boolean).slice(0, 30) : [];
    if (!review || !cards.length) return json({ error: "missing_verify_input" }, 400);
    const evidenceText = cards.map((card: string, index: number) => `P${String(index + 1).padStart(2, "0")}\n${card}`).join("\n\n");
    if (evidenceText.length > 180000) return json({ error: "evidence_too_large", max_chars: 180000 }, 400);
    const anchors = suspiciousAnchors(review, evidenceText);
    const schema = {
      type: "OBJECT",
      properties: {
        verified_text: { type: "STRING" },
        claims_total: { type: "INTEGER" },
        supported_claims: { type: "INTEGER" },
        partial_claims_rewritten: { type: "INTEGER" },
        unsupported_claims_removed: { type: "INTEGER" },
        issues: { type: "ARRAY", maxItems: 12, items: { type: "STRING" } }
      },
      required: ["verified_text","claims_total","supported_claims","partial_claims_rewritten","unsupported_claims_removed","issues"]
    };
    const prompt = `Ты независимый факт-верификатор W-Review. Проверяй ТОЛЬКО по Evidence Cards ниже. Запрещено использовать собственные знания, память модели, интернет или правдоподобные догадки.

ЗАДАЧА:
1. Разбей черновик на проверяемые фактические утверждения.
2. Для каждого имени, должности, числа, даты, события, прямой цитаты, причинной связи и утверждения о позиции стороны требуй опору в Evidence.
3. SUPPORTED — смысл прямо подтверждён Evidence.
4. PARTIAL — подтверждена только часть: перепиши фразу ровно до подтверждённого уровня.
5. UNSUPPORTED — подтверждения нет: полностью удали это утверждение.
6. Прямые цитаты сохраняй только если они дословно присутствуют в Evidence.
7. Не добавляй НИКАКОЙ новой фактуры при исправлении.
8. Редакционные обобщения разрешены лишь как явно аналитические формулировки ("в публикациях просматривается", "медиа акцентируют"), если они выводятся минимум из двух Evidence Cards.
9. Сохрани композицию, язык, подзаголовки и стиль насколько возможно.
10. verified_text должен содержать уже очищенный финальный текст, в котором не осталось неподтверждённых фактических утверждений.

Особенно проверь эти автоматически подозрительные якоря, которых нет дословно в Evidence; это сигнал для проверки, а не автоматический приговор:
${anchors.length ? anchors.map((v) => "- " + v).join("\n") : "нет"}

ЗАДАНИЕ ОПЕРАТОРА:
${task || "не указано"}

ЧЕРНОВИК:
${review}

EVIDENCE CARDS:
${evidenceText}`;
    const cfToken = Deno.env.get("CLOUDFLARE_API_TOKEN") || "";
    const cfAccount = Deno.env.get("CLOUDFLARE_ACCOUNT_ID") || "";
    if (!cfToken || !cfAccount) return json({error:"cloudflare_verifier_not_configured"},503);
    // Return audit findings only: never ask a verifier to rewrite the entire review.
    const auditPrompt = "Проверяй текст строго по предоставленным Evidence Cards. КРИТИЧЕСКОЕ ПРАВИЛО: для подтверждения факта, числа, цитаты или позиции достаточно ОДНОЙ Evidence Card. НЕЛЬЗЯ считать факт спорным лишь потому, что остальные источники его не повторяют. Разные издания вправе сообщать разные факты об одном событии. Проверяй также точность атрибуции: если написано, что число приводит конкретное СМИ, оно должно присутствовать именно в карточке этого СМИ. Если источник не указан, достаточно любой одной карточки. Не требуй консенсуса между СМИ. Не применяй правило двух источников к обычным фактам. Русский перевод иностранной цитаты или заголовка НЕ является вымышленной цитатой: проверяй точность передачи смысла по оригиналу Evidence Card, а не буквальное совпадение разных языков. Белорусские цитаты можно сохранять в оригинале. Не переписывай обзор. В issues включай только конкретные фактические ошибки, неверные атрибуции или сведения, которых нет ни в одной карточке. НЕ заноси в issues отсутствие повторения факта в других карточках. Числа partial_claims_rewritten и unsupported_claims_removed учитывают ТОЛЬКО такие реальные ошибки. Если не можешь доказать ошибку, не объявляй её. Верни JSON с claims_total, supported_claims, partial_claims_rewritten, unsupported_claims_removed и issues (массив строк).\\n\\nЗАДАНИЕ: "+task+"\\n\\nЧЕРНОВИК:\\n"+review+"\\n\\nEVIDENCE CARDS:\\n"+evidenceText;
    const result = await callCloudflare(cfAccount,cfToken,{
      messages:[{role:"system",content:"Ты строгий аудитор достоверности. Только JSON. Не генерируй новую редакцию обзора; только проверочные замечания и числовые показатели."},{role:"user",content:auditPrompt}],
      max_completion_tokens:3500
    });
    if (!result.ok) return json({error:"cloudflare_fact_verifier_unavailable",detail:result.detail.slice(0,700),http_status:result.status},503);
    const parsed = parseModelJson(result);
    const required = ["claims_total","supported_claims","partial_claims_rewritten","unsupported_claims_removed"];
    if (!parsed || !Array.isArray(parsed.issues) || !required.every((key)=>Number.isFinite(Number(parsed[key]))))
      return json({error:"cloudflare_invalid_audit_json",detail:"Верификатор не вернул проверочные показатели. Черновик сохранён."},502);
    const verifierModel = "@cf/openai/gpt-oss-120b";
    const provider = "cloudflare";

    // A verifier must NEVER silently rewrite the operator's reviewed draft.
    // Report questionable claims as an error instead of destructively replacing the draft.
    const reportedIssues: string[] = Array.isArray(parsed.issues) ? parsed.issues.map((v: unknown) => String(v || "").trim()).filter(Boolean).slice(0,12) : [];
    const invalidConsensusReason = (issue:string) => /(?:другие|остальные|других|остальных)\\s+(?:источник|издан|сми)|не\\s+(?:приводят|повторяют|подтверждают)\\s+(?:остальные|другие)|подтвержден[аоы]?\\s+только\\s+в\\s+P\\d+/i.test(issue) && !/неверн[аоы]?\\s+атрибуц|приписан[аоы]?\\s+не\\s+тому/i.test(issue);
    const issues = reportedIssues.filter((issue)=>!invalidConsensusReason(issue));
    const partialCount = issues.length ? Math.max(0, Number(parsed.partial_claims_rewritten || 0)) : 0;
    const removedCount = issues.length ? Math.max(0, Number(parsed.unsupported_claims_removed || 0)) : 0;
    if (partialCount > 0 || removedCount > 0 || issues.length > 0) {
      return json({verified_text:review,fact_check:{
        verified:false, claims_total:Math.max(0,Number(parsed.claims_total||0)),
        supported_claims:Math.max(0,Number(parsed.supported_claims||0)),
        partial_claims_rewritten:partialCount,unsupported_claims_removed:removedCount,
        suspicious_anchors:0,issues:issues.length?issues:["Проверка указала на спорные утверждения без детализации. Требуется дополнительная проверка."]
      },model:verifierModel,provider,usage:result.usage});
    }
    if (review.length > 500 && Number(parsed.claims_total || 0) < 1) return json({error:"fact_verification_incomplete",provider,detail:"Нет подтверждения проверки утверждений."},409);
    const verifiedText = review;
    return json({
      verified_text: verifiedText,
      fact_check: {
        verified: true,
        claims_total: Math.max(0, Number(parsed.claims_total || 0)),
        supported_claims: Math.max(0, Number(parsed.supported_claims || 0)),
        partial_claims_rewritten: Math.max(0, Number(parsed.partial_claims_rewritten || 0)),
        unsupported_claims_removed: Math.max(0, Number(parsed.unsupported_claims_removed || 0)),
        suspicious_anchors: anchors.length,
        issues: Array.isArray(parsed.issues) ? parsed.issues.map((v: unknown) => String(v || "").trim()).filter(Boolean).slice(0, 12) : [],
      },
      model: verifierModel,
      provider,
      usage: result.usage
    });
  }

  if (action === "expand_review") {
    if (!geminiApiKey) return json({ error: "w_review_gemini_not_configured" }, 503);
    const task = String(body?.task || "").trim();
    const targetChars = Math.max(1000, Math.min(12000, Number(body?.target_chars || 3000)));
    const draft = String(body?.draft || "").trim();
    const cards = Array.isArray(body?.evidence_cards) ? body.evidence_cards.map((v: unknown) => String(v || "").trim()).filter(Boolean).slice(0, 30) : [];
    const styleProfile = String(body?.style_profile || "").trim().slice(0, 10000);
    const trends = Array.isArray(body?.trends) ? body.trends.slice(0, 5) : [];
    const sourceNames = Array.isArray(body?.source_names) ? body.source_names.map((v: unknown) => String(v || "").trim()).filter(Boolean).slice(0, 30) : [];
    if (!task || !draft || !cards.length || !trends.length) return json({ error: "missing_expand_input" }, 400);
    const d = body?.density || {};
    const quoteDensity = density(d.quotes), headlineDensity = density(d.headlines), expertDensity = density(d.experts);
    const evidenceText = cards.map((card: string, index: number) => `P${String(index + 1).padStart(2, "0")}\n${card}`).join("\n\n");
    if (evidenceText.length > 180000) return json({ error: "evidence_too_large", max_chars: 180000 }, 400);
    const trendText = trends.map((trend: any, index: number) => `${index + 1}. ${String(trend?.title || "")}: ${String(trend?.summary || "")}`).join("\n");
    const canonicalSources = sourceNames.length ? sourceNames.map((name: string) => `«${name}»`).join(", ") : "используй названия из Evidence Cards";
    const densityRule = (name: string, value: string) => value === "minimum" ? `${name}: редко, только самые сильные 1–2 элемента, если доступны.` : value === "all" ? `${name}: использовать все реально найденные пригодные элементы этого типа, без выдумывания.` : value === "many" ? `${name}: насыщенно, использовать большинство сильных элементов без перегруза.` : `${name}: умеренно, несколько лучших элементов.`;
    const minChars = Math.floor(targetChars * 0.90);
    const maxChars = Math.ceil(targetChars * 1.08);

    const payload = {
      model: "openai/gpt-oss-120b",
      reasoning_effort: "low",
      reasoning_format: "hidden",
      temperature: 0.18,
      max_completion_tokens: Math.min(2600, Math.max(1400, Math.ceil(targetChars / 3.0) + 500)),
      messages: [
        { role: "system", content: `Ты редактор W-Review. Тебе дан уже написанный, но слишком короткий обзор. НЕ переписывай его в более кратком виде и НЕ начинай заново с иной концепцией. Расширь существующий текст содержательно до ${minChars}–${maxChars} знаков видимого review_text.

Добавляй только подтверждённые Evidence Cards детали, цитаты, имена, факты и аспекты уже утверждённых тенденций. Не создавай новый факт ради объёма и не повторяй уже сказанное другими словами.

EVIDENCE-ONLY CONTRACT:
- не используй внешние знания модели, память или догадки;
- каждое имя, должность, число, дата, цитата, событие и причинная связь должны подтверждаться Evidence;
- если подтверждения недостаточно — не добавляй утверждение;
- не склеивай разные детали в новый факт;
- объём никогда не важнее доказательности.

Сохрани редакционный контракт:
- обзор строится по тенденциям, а не поочерёдно по источникам;
- названия СМИ только в «ёлочках»;
- группы источников в круглых скобках только в конце законченного предложения перед точкой;
- если в Evidence есть имя эксперта, используй имя; если имени нет — не придумывай;
- не используй Markdown;
- не заканчивай автоматически «Таким образом»;
- канонические источники: ${canonicalSources};
- ${densityRule("Цитаты", quoteDensity)}
- ${densityRule("Заголовки", headlineDensity)}
- ${densityRule("Эксперты", expertDensity)}

Верни 3–4 точные фразы из итогового текста в bold_phrases и подзаголовки в section_titles. Проверка длины обязательна: review_text короче ${minChars} знаков недопустим.

STYLE PROFILE:
${styleProfile || "Живой сдержанный редакционный стиль."}` },
        { role: "user", content: `ЗАДАНИЕ:\n${task}\n\nУТВЕРЖДЁННЫЕ ТЕНДЕНЦИИ:\n${trendText}\n\nТЕКУЩИЙ СЛИШКОМ КОРОТКИЙ ОБЗОР:\n${draft}\n\nEVIDENCE CARDS:\n${evidenceText}` }
      ],
      response_format: { type: "json_schema", json_schema: { name: "w_review_expand_v1", strict: true, schema: {
        type: "object",
        properties: {
          review_text: { type: "string" },
          section_titles: { type: "array", items: { type: "string" }, maxItems: 5 },
          bold_phrases: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 4 }
        },
        required: ["review_text", "section_titles", "bold_phrases"],
        additionalProperties: false
      } } }
    };
    const synthesisModel = W_REVIEW_GEMINI_PRIMARY;
    const synthesisSchema = {type:"OBJECT",properties:{review_text:{type:"STRING"},section_titles:{type:"ARRAY",items:{type:"STRING"}},bold_phrases:{type:"ARRAY",items:{type:"STRING"}}},required:["review_text","section_titles","bold_phrases"]};
    const synthesisPrompt = payload.messages.map((m: any) => m.content).join("\n\n");
    let result = await callGemini(geminiApiKey, synthesisModel, synthesisPrompt, synthesisSchema, 0.2, "expand_review");
    let selectedModel = synthesisModel;
    let parsed = result.ok ? parseModelJson(result) : null;
    if ((!result.ok && result.status !== 429) || (result.ok && !String(parsed?.review_text || "").trim())) {
      const fallbackModel = W_REVIEW_GEMINI_FALLBACK;
      const fallback = await callGemini(geminiApiKey, fallbackModel, synthesisPrompt, synthesisSchema, 0.2, "expand_review_fallback");
      if (fallback.ok && String(parseModelJson(fallback)?.review_text || "").trim()) {
        result = fallback; parsed = parseModelJson(fallback); selectedModel = fallbackModel;
      } else if (!result.ok) result = fallback;
    }
    if (!result.ok) return aiError("gemini", result);
    if (!parsed || !String(parsed.review_text || "").trim()) return json({error:"invalid_synthesis_output"},502);
    return json({
      review_text: String(parsed.review_text || "").trim(),
      section_titles: Array.isArray(parsed.section_titles) ? parsed.section_titles.map((v: unknown) => String(v || "").trim()).filter(Boolean).slice(0, 5) : [],
      bold_phrases: Array.isArray(parsed.bold_phrases) ? parsed.bold_phrases.map((v: unknown) => String(v || "").trim()).filter(Boolean).slice(0, 4) : [],
      model: selectedModel,
      provider: "gemini",
      target_chars: targetChars,
      usage: result.usage
    });
  }

  if (action === "synthesize") {
    const cloudflareConfigured = Boolean(
      (Deno.env.get("CLOUDFLARE_API_TOKEN") && Deno.env.get("CLOUDFLARE_ACCOUNT_ID"))
      || (Deno.env.get("CLOUDFLARE_BACKUP_API_TOKEN") && Deno.env.get("CLOUDFLARE_BACKUP_ACCOUNT_ID"))
    );
    if (!cloudflareConfigured && !groqApiKey) return json({ error: "w_review_no_synthesis_provider" }, 503);
    const task = String(body?.task || "").trim();
    if (!task || task.length > 2000) return json({ error: "invalid_task", max_chars: 2000 }, 400);
    const targetChars = Math.max(1000, Math.min(8000, Number(body?.target_chars || 3000)));
    const submittedCards = Array.isArray(body?.evidence_cards) ? body.evidence_cards : [];
    if (submittedCards.length > 18) return json({error:"w_review_max_articles",limit:18},400);
    const cards = submittedCards.map((v: unknown) => String(v || "").trim()).filter(Boolean);
    const styleProfile = String(body?.style_profile || "").trim().slice(0, 10000);
    // Complete author paragraphs only. Older clients with unlabelled excerpts
    // remain accepted; this never changes source evidence or author samples.
    const roleNames=new Set(["opening","development","comparison","ending"]);
    const proposed=Array.isArray(body?.style_excerpts)?body.style_excerpts.slice(0,12):[];
    let excerptBudget=7200;
    const styleExcerpts:{name:string;role:string;text:string}[]=[];
    for(const item of proposed){
      const role=String(item?.role||"development");
      const text=String(item?.text||"").trim();
      if(!roleNames.has(role)||text.length<90||text.length>1250||text.length>excerptBudget)continue;
      styleExcerpts.push({name:String(item?.name||"Образец").slice(0,120),role,text});
      excerptBudget-=text.length; // A complete excerpt is kept or skipped; never cut.
    }
    const labels:Record<string,string>={
      opening:"ЗАЧИН",development:"РАЗВИТИЕ АРГУМЕНТА",
      comparison:"СОПОСТАВЛЕНИЕ ОЦЕНОК",ending:"ЗАВЕРШЕНИЕ"
    };
    const styleOnlyText=styleExcerpts.map((item,index)=>
      "STYLE_ONLY_"+(index+1)+" / "+item.name+" / "+labels[item.role]+
      "\nИСКЛЮЧИТЕЛЬНО ПРИМЕР КОМПОЗИЦИИ И ИНТОНАЦИИ, НЕ ИСТОЧНИК ФАКТОВ:\n"+
      item.text
    ).join("\n\n");
    const rawComposition=body?.style_composition&&typeof body.style_composition==="object"
      ?body.style_composition:{};
    const numeric=(value:unknown,max:number)=>{
      const n=Number(value);return Number.isFinite(n)?Math.max(0,Math.min(max,Math.round(n))):0;
    };
    const measuredMedian=numeric(rawComposition.medianParagraphChars,3000);
    const styleSampleCount=numeric(rawComposition.sampleCount,5);
    const compositionNote=styleSampleCount>0&&measuredMedian>=90
      ? "ПАРАМЕТРЫ АВТОРСКОГО КОРПУСА (ориентиры, НЕ требования к каждому абзацу): "+
        "образцов "+styleSampleCount+
        ", медианная длина абзаца "+measuredMedian+" знаков"+
        ", типичный зачин "+numeric(rawComposition.openingMedianChars,3000)+
        ", типичное завершение "+numeric(rawComposition.endingMedianChars,3000)+
        ", коротких абзацев "+numeric(rawComposition.shortParagraphPct,100)+"%"+
        ", абзацев с атрибуцией "+numeric(rawComposition.attributionParagraphPct,100)+"%"+
        ", с сопоставлением "+numeric(rawComposition.comparisonParagraphPct,100)+"%."
      :"Композиционные метрики не получены: опирайся на STYLE_PROFILE и связные образцы.";
    if (!styleProfile) return json({error:"w_review_style_required",detail:"Сначала сформируйте профиль авторского стиля."},400);
    const trends = Array.isArray(body?.trends) ? body.trends.slice(0, 5) : [];
    // Validate references against this exact Evidence pool before consuming any quota.
    const checkedDossier=normalizeDossier(body?.editorial_dossier,cards);
    if(checkedDossier.error||!checkedDossier.dossier)
      return json({error:"w_review_dossier_v3_required",
        detail:checkedDossier.error||"reanalyse_pool"},426);
    const selectedIds=trends.map((t:any)=>String(t?.id||""));
    if(!selectedIds.length||new Set(selectedIds).size!==selectedIds.length||
       selectedIds.some(id=>!checkedDossier.dossier!.trends.some(t=>t.id===id)))
      return json({error:"w_review_invalid_selected_dossier_lines"},400);
    const synthesisDossier=makeSynthesisDossier(checkedDossier.dossier,selectedIds,targetChars,cards);
    const sourceNames = Array.isArray(body?.source_names) ? body.source_names.map((v: unknown) => String(v || "").trim()).filter(Boolean).slice(0, 30) : [];
    if (!cards.length || !trends.length) return json({ error: "missing_synthesis_input" }, 400);
    const d = body?.density || {};
    const quoteDensity = density(d.quotes), headlineDensity = density(d.headlines), expertDensity = density(d.experts);
    // Limit synthesis context only. Original Evidence Cards remain unchanged for fact verification.
    const evidenceText = cards.map((card: string, index: number) => `P${String(index + 1).padStart(2, "0")}\n${card}`).join("\n\n");
    if (evidenceText.length > 180000) return json({ error: "evidence_too_large", max_chars: 180000 }, 400);
    const trendText=synthesisDossier.text;
    const densityRule = (name: string, value: string) => value === "minimum" ? `${name}: редко, только самые сильные 1–2 элемента, если доступны.` : value === "all" ? `${name}: использовать все реально найденные пригодные элементы этого типа, но не выдумывать и не повторять один и тот же элемент.` : value === "many" ? `${name}: насыщенно, использовать большинство сильных элементов без перегруза и повторов.` : `${name}: умеренно, несколько лучших элементов по ходу текста.`;
    const canonicalSources = sourceNames.length ? sourceNames.map((name: string) => `«${name}»`).join(", ") : "используй названия из Evidence Cards";

    const lengthMinimum=Math.round(targetChars*0.95);
    const lengthMaximum=Math.round(targetChars*1.05);
    // One generation, structured into natural adjacent paragraphs. The user
    // still receives ONE continuous editor text; not an item-by-item digest.
    const fallbackParagraphs=targetChars>=7000?12:
      targetChars>=5500?9:targetChars>=3500?7:
      targetChars>=2500?6:targetChars>=1800?4:2;
    const paragraphTarget=measuredMedian>=90
      ?Math.max(2,Math.min(22,Math.round(targetChars/Math.max(260,Math.min(950,measuredMedian)))))
      :fallbackParagraphs;
    // Natural author rhythm: allow short bridges and longer analytical blocks.
    const paragraphFloor=Math.max(2,Math.floor(paragraphTarget*0.7));
    const paragraphCeiling=paragraphTarget+Math.max(3,Math.ceil(paragraphTarget*0.4));
    const payload = {
      model: "openai/gpt-oss-120b", reasoning_effort: "low", reasoning_format: "hidden", temperature: 0.2,
      max_completion_tokens: Math.min(2500, Math.max(1300, Math.ceil(targetChars / 3.0) + 450)),
      messages: [{ role: "system", content: `Навык: РЕДАКЦИОННЫЙ МЕДИАОБЗОР W-REVIEW 1.0.
Напиши ОДИН связный аналитический обзор тенденций медиаполя в индивидуальном стиле автора. Это не каталог статей и не последовательный пересказ каждого издания.

ЖАНР. Следуй проверенному редакционному досье: раскрой все обязательные ветки, механизмы, аргументы и контрпозиции, затем объедини публикации разных СМИ в содержательное повествование. Анализируй совпадения, противоречия, акценты и аргументы. Не строй абзацы по механическому порядку карточек или названий СМИ.

ИСТОЧНИКИ. Прочитай ВСЕ Evidence Cards. Сохраняй уникальные сведения каждого содержательного материала: факты, цифры, цитаты, заголовки, аргументы, позиции реальных экспертов, дополнительные обстоятельства. Не требуется механически упоминать каждую повторную публикацию агентства; не пропускай самостоятельный ракурс менее известного СМИ.

АТРИБУЦИЯ. Различай собственную редакционную позицию, нейтральное сообщение, цитату другого СМИ, высказывание конкретного политика/эксперта и газетный заголовок. Используй подтверждённые записи с адресами E01, E02 и типами [editorial_stance/P...], [media_angle/P...], [quote/P...], [counterposition/P...] и [expert/P...]. У каждой записи после SOURCE приведена дословная выдержка, проверенная на наличие в исходной публикации; это не автоматическая проверка смысла пересказа. Газета, приведшая чужую критику, не обязательно разделяет эту критику. Не меняй знак оценки и не приписывай одному СМИ чужие слова.

ОБОБЩЕНИЯ. Содержательные аналитические выводы обязательны. Общая позиция группы изданий требует подтверждения несколькими самостоятельными источниками соответствующей группы. Один источник может подтверждать конкретный факт, но не консенсус национального медиаполя. Когда оценки противоположны, прямо раскрывай это различие без искусственного единодушия.

ТОЛЬКО ДОКАЗАТЕЛЬНАЯ ФАКТУРА. Даты, лица, цитаты, переводы, числа, экспертные оценки и причинные связи — исключительно из текущих Evidence Cards. Используй ID записей внутри публикаций как адреса доказательств, не превращай ID в видимый текст обзора. Никаких внешних сведений, догадок или фактов из STYLE_ONLY. Исключения оператора обязательны. Недостающую фактуру не восполняй выдумками или повторами.

ЯЗЫК. Весь видимый текст ОБЗОРА, включая прямую речь, заголовки и цитаты, пиши НА РУССКОМ ЯЗЫКЕ. Исключение: цитаты на белорусском языке можно оставить по-белорусски. Иностранный оригинал из поля ORIGINAL не вставляй — используй точный перевод из TITLE_RU или QUOTES_WITH_SPEAKERS.RU. Названия зарубежных СМИ, организаций и собственные имена сохраняй в принятом написании, например «CNN», «The Guardian»; это НЕ разрешение оставлять английские цитаты. Никаких непереведённых английских предложений, английских цитатных вставок, Markdown или искусственных заголовков. Кавычки « », тире –.

МАНЕРА. STYLE_PROFILE и настоящие связные абзацы STYLE_ONLY задают индивидуальный зачин, интонацию, ритм, способ сопоставления СМИ, развитие сюжета и способ смыслового завершения, а не только отдельные обороты. Метки ЗАЧИН / РАЗВИТИЕ / СОПОСТАВЛЕНИЕ / ЗАВЕРШЕНИЕ обозначают место фрагмента в авторском оригинале, а не обязательные рубрики итогового текста. Не копируй содержание образцов. Построй общую аналитику по тенденциям: раскрывай подтверждённые детали, аргументы и контрпозиции, а не последовательность публикаций. Не навязывай абзацам одинаковую длину. Следуй измеренному авторскому ритму, чередуй короткие связки и развернутые аналитические абзацы в той мере, в какой это характерно автору. Не превращай финал в механическое повторение зачина. Не начинай заключительный абзац формулами «Таким образом», «Итоговый вывод», «Суммарно», «В совокупности» или «В заключение». Не сочиняй собственную итоговую цитату, выдавая её за подлинный заголовок. Законченный обзор заверши доказательной содержательной мыслью, а не школьным повтором написанного.

АТРИБУЦИЯ В ТЕКСТЕ. Все названия СМИ — в русских кавычках «ёлочках», как в основном тексте, так и в библиографических скобках. Названия СМИ будут автоматически выделены курсивом при экспорте DOCX. Ссылки на публикации указывай перед ЗАКЛЮЧИТЕЛЬНОЙ точкой предложения, без точки непосредственно перед скобками: «... оценка («CNN», «Bloomberg»).», а НЕ «... оценка. (CNN, Bloomberg)». Приводи только те конкретные СМИ, чьи Evidence Cards подтверждают данное утверждение; не прикрывай спорные выводы перечнем всех изданий. Канонические источники: ${canonicalSources}.
Цитаты: ${densityRule("Цитаты",quoteDensity)}
Заголовки: ${densityRule("Выразительные заголовки",headlineDensity)}
Эксперты: ${densityRule("Эксперты",expertDensity)}

STYLE_PROFILE:
${styleProfile}

КОМПОЗИЦИОННАЯ СТАТИСТИКА:
${compositionNote}

STYLE_ONLY (образцы авторской манеры, НЕ ИСТОЧНИК ФАКТОВ):
${styleOnlyText || "Дополнительные фрагменты недоступны. Следуй STYLE_PROFILE."}

РЕЗУЛЬТАТ. Верни ОДИН JSON со строковым массивом paragraphs, массивами section_titles и bold_phrases. paragraphs — единое непрерывное аналитическое повествование, разбитое на естественные абзацы, НЕ набор отдельных СМИ или подзаголовков. Ориентир — около ${paragraphTarget} абзацев, допустимо ${paragraphFloor}–${paragraphCeiling} естественных абзацев разного объёма. Количество не является самоцелью; обязательны раскрытие веток и заданная ОБЩАЯ длина, а не равные куски. В пределах ОДНОГО ответа полностью раскрой все выбранные тенденции, подробные факты и противоречащие ракурсы; не заверши после краткого обзора первых источников. section_titles:[] и bold_phrases:[] допустимы. Никогда не выдумывай подзаголовки и не вставляй Markdown ** или __. Не выдавай планы и промежуточные замечания.` },
        { role: "user", content: `ЗАДАНИЕ ОПЕРАТОРА:\n${task}\n\nРЕДАКЦИОННОЕ ДОСЬЕ И РАСПРЕДЕЛЕНИЕ ОБЪЁМА:\n${trendText}\n\nИНСТРУКЦИЯ ДЛЯ ЭТАПА:\n${String(body?.stage_note || "").slice(0,500)}\n\nEVIDENCE CARDS:\n${evidenceText}\n\nФИНАЛЬНОЕ ЗАДАНИЕ: создай ОДИН непрерывный авторский аналитический обзор в массиве paragraphs, с общим объёмом после соединения абзацев ${targetChars} знаков с пробелами, допустимый коридор ${lengthMinimum}–${lengthMaximum}. Ориентир ${paragraphTarget} абзацев (допустимо ${paragraphFloor}–${paragraphCeiling}), в авторском ритме, без принудительно одинаковой длины. Каждый следующий развивает общую мысль, а не описывает следующее СМИ. После обработки всех тенденций заверши подтверждённым содержательным акцентом, не формальной сводкой. Не допускай ни одной непереведённой англоязычной цитаты (кроме официальных названий), расставляй источники только по образцу «... («CNN», «BBC News»).», не создавай собственных псевдоцитат и шаблонной итоговой концовки. Не используй Markdown, ненужные подзаголовки и списки источников.` }],
      response_format: { type:"json_schema",json_schema:{name:"w_review_v7_paragraphs",strict:true,schema:{
        type:"object",
        properties:{
          paragraphs:{type:"array",minItems:paragraphFloor,maxItems:paragraphCeiling,items:{type:"string",minLength:80}},
          section_titles:{type:"array",items:{type:"string"},maxItems:2},
          bold_phrases:{type:"array",items:{type:"string"},maxItems:4}
        },
        required:["paragraphs","section_titles","bold_phrases"],
        additionalProperties:false
      }}},
    };
    const cfToken = Deno.env.get("CLOUDFLARE_API_TOKEN") || "";
    const cfId = Deno.env.get("CLOUDFLARE_ACCOUNT_ID") || "";
    const cfBackupToken = Deno.env.get("CLOUDFLARE_BACKUP_API_TOKEN") || "";
    const cfBackupId = Deno.env.get("CLOUDFLARE_BACKUP_ACCOUNT_ID") || "";
    const cfPrimaryReady = Boolean(cfToken && cfId);
    const cfBackupReady = Boolean(cfBackupToken && cfBackupId && (!cfPrimaryReady || cfBackupId !== cfId));
    // Output ceiling != organizational TPM. Groq Free may reject this
    // context entirely; never silently discard cards to force a fallback.
    const groqSynthesisOutputTokenBudget=Math.min(7000,
      Math.max(2000,Math.ceil((targetChars/1.25+800)/250)*250));
    const groqPayload = {
      model:"openai/gpt-oss-120b",reasoning_effort:"low",reasoning_format:"hidden",temperature:0.2,
      max_completion_tokens:groqSynthesisOutputTokenBudget,
      messages:payload.messages,response_format:payload.response_format
    };
    // Dynamic output budget is tied to the requested visible Russian-language
    // character count. The budget must also accommodate model reasoning and the
    // JSON wrapper. It is a CEILING, not a guaranteed response length.
    const estimatedVisibleTokens=Math.ceil(targetChars/1.25);
    const estimatedReasoningTokens=Math.max(1000,
      Math.min(3000,Math.ceil(estimatedVisibleTokens*0.4)));
    const synthesisOutputTokenBudget=Math.min(11000,
      Math.max(1500,Math.ceil((estimatedVisibleTokens+
        estimatedReasoningTokens+450)/500)*500));
    const cloudflareSynthesisPayload = {
      ...groqPayload,
      temperature:0.36,
      reasoning_effort:"medium",
      max_tokens:synthesisOutputTokenBudget,
    };
    const topicKeyRaw = String(body?.topic_key || "legacy-workspace").trim();
    const topicKey = /^workspace-[1-3]$/.test(topicKeyRaw) ? topicKeyRaw : "legacy-workspace";
    let reservationId = "";
    if (!profile.is_admin) {
      const {data: quota, error: quotaError} = await admin.rpc("w_review_quota_reserve",
        {p_user: authData.user.id, p_topic: topicKey});
      if (quotaError || !quota || typeof quota.allowed !== "boolean")
        return json({error:"w_review_quota_check_failed"},503);
      if (!quota.allowed)
        return json({error:"w_review_daily_generation_limit",detail:"На эту тему уже сформировано 2 обзора за сегодня. Лимит обновится в 00:00 по Минску.",limit:2,used:quota.used,topic_key:topicKey},403);
      reservationId = String(quota.reservation_id || "");
      if (!reservationId) return json({error:"w_review_quota_reservation_missing"},503);
    }
    async function finishQuota(success:boolean) {
      if (!reservationId) return true;
      const {data,error} = await admin.rpc("w_review_quota_finish",{p_id:reservationId,p_success:success});
      return !error && data===true;
    }
    // GPT-OSS-120B ONLY for the final review, regardless of length:
    // independent Cloudflare account 1 -> account 2 -> Groq.
    // Gemini is deliberately excluded from synthesis because of instability.
    // No rewriting or length-driven provider switching after a usable result.
    let cloudflareRoute:"primary"|"backup"|null=
      cfPrimaryReady?"primary":cfBackupReady?"backup":null;
    let result:AiResult=cfPrimaryReady
      ? await callCloudflare(cfId,cfToken,cloudflareSynthesisPayload)
      : cfBackupReady
        ? await callCloudflare(cfBackupId,cfBackupToken,cloudflareSynthesisPayload)
        : {ok:false,status:503,retryAfter:null,detail:"cloudflare_unconfigured"};
    let selectedProvider="cloudflare";
    let selectedModel="@cf/openai/gpt-oss-120b";
    // Convert one structured completion to the existing API. No second AI
    // call, rewriting pass, audit or source-by-source postprocessing.
    const normalizeReview=(raw:any)=>{
      if(!raw||typeof raw!=="object")return raw;
      const paragraphs=Array.isArray(raw.paragraphs)?
        raw.paragraphs.map((p:any)=>String(p||"").trim()).filter(Boolean):[];
      const text=paragraphs.length?paragraphs.join("\n\n"):String(raw.review_text||"").trim();
      // Remove model control markup and fake paragraph-ending headings.
      const withoutTags=text.replace(/\s+\*\*«[^»\n]{5,95}»\*\*(?=\s*(?:\n|$))/g,"");
      const cleaned=withoutTags.replace(/\*\*/g,"").replace(/__/g,"").trim();
      return {...raw,review_text:cleaned,section_titles:[],
        bold_phrases:Array.isArray(raw.bold_phrases)?raw.bold_phrases:[]};
    };
    let parsed=result.ok?normalizeReview(parseModelJson(result)):null;
    const usable=(r:AiResult,p:any)=>r.ok&&typeof p?.review_text==="string"&&Boolean(p.review_text.trim());
    const temporaryOrAccountError=result.ok||[401,403,408,429,500,502,503,504,520,522,523,524].includes(result.status);
    if(cfPrimaryReady&&cfBackupReady&&!usable(result,parsed)&&temporaryOrAccountError){
      console.info("w_review_provider_fallback "+JSON.stringify({
        stage:"synthesis",from:"cloudflare_primary",to:"cloudflare_backup",
        http_status:result.ok?200:result.status,trigger:result.ok?"invalid_output":"provider_failure"
      }));
      result=await callCloudflare(cfBackupId,cfBackupToken,cloudflareSynthesisPayload);
      parsed=result.ok?normalizeReview(parseModelJson(result)):null;
      cloudflareRoute="backup";
    }
    if(!usable(result,parsed)&&groqApiKey){
      const groq=await callGroq(groqApiKey,groqPayload);
      const gp=groq.ok?normalizeReview(parseModelJson(groq)):null;
      if(usable(groq,gp)){
        result=groq;parsed=gp;selectedProvider="groq";
        selectedModel="openai/gpt-oss-120b";cloudflareRoute=null;
      }else if(!result.ok){result=groq;selectedProvider="groq";selectedModel="openai/gpt-oss-120b";cloudflareRoute=null;}
    }
    // SINGLE-PASS: no rewriting, expansion, independent AI audit, or deletion.
    // Fallback to a different provider is used only if the chosen provider
    // is technically unavailable or did not return usable JSON.
    if (!result.ok) {await finishQuota(false); return aiError(selectedProvider==="groq"?"groq":"cloudflare",result);}
    if (!parsed || typeof parsed.review_text!=="string" || !parsed.review_text.trim()) {
      await finishQuota(false);
      return json({error:"invalid_synthesis_output"},502);
    }
    const reviewText=parsed.review_text.trim();
    const actualChars=reviewText.length;
    const lengthOk=actualChars>=lengthMinimum
      && actualChars<=lengthMaximum;
    // Only deterministic warnings. Keep the draft even when outside tolerance.
    const preflightWarnings:string[]=[];
    if(!lengthOk) preflightWarnings.push(`Объём ${actualChars} знаков вне допуска ${lengthMinimum}–${lengthMaximum}; текст сохранён для редактирования.`);
    const rawParagraphs=Array.isArray(parsed.paragraphs)?parsed.paragraphs:[];
    if(rawParagraphs.length>0 && rawParagraphs.length<paragraphTarget)
      preflightWarnings.push(`Абзацев ${rawParagraphs.length}, ориентир ${paragraphTarget}; не добавляйте пустые абзацы ради числа.`);
    console.info("w_review_single_pass "+JSON.stringify({
      provider:selectedProvider,model:selectedModel,target_chars:targetChars,
      actual_chars:actualChars,within_tolerance:lengthOk,
      requested_output_token_budget:selectedProvider==="cloudflare"?synthesisOutputTokenBudget:
        groqSynthesisOutputTokenBudget,
      length_window:{min:lengthMinimum,max:lengthMaximum},
      paragraph_target:paragraphTarget,paragraph_min:paragraphMinChars,
      actual_paragraphs:reviewText.split(/\n\s*\n/).length,
      prompt_tokens:result.ok?result.usage.prompt_tokens:0,
      completion_tokens:result.ok?result.usage.completion_tokens:0,
      finish_reason:result.ok?result.finish_reason||"not_reported":"error",
      reasoning_tokens:result.ok?result.reasoning_tokens||0:0,
      style_chars:styleProfile.length,style_excerpt_chars:styleOnlyText.length,evidence_chars:evidenceText.length,
      source_mentions:sourceNames.filter((name:string)=>reviewText.includes("«"+name+"»")).length,
      source_names:sourceNames.length,
      cards:cards.length,trends:trends.length,required_branches:synthesisDossier.requiredBranches,
      dossier_chars:trendText.length,publications_with_selected_evidence:synthesisDossier.coveredPublications
    }));
    if (!(await finishQuota(true))) return json({error:"w_review_quota_commit_failed",detail:"Результат модели получен, но суточный учёт не завершён; повторная попытка не будет безопасной."},503);
    return json({
      review_text:reviewText,
      section_titles:Array.isArray(parsed.section_titles)
        ?parsed.section_titles.map((v:unknown)=>String(v||"").trim())
           .filter((v:string)=>v&&reviewText.includes(v)).slice(0,5):[],
      bold_phrases:Array.isArray(parsed.bold_phrases)
        ?parsed.bold_phrases.map((v:unknown)=>String(v||"").trim())
           .filter((v:string)=>v&&reviewText.includes(v)).slice(0,4):[],
      model:selectedModel,provider:selectedProvider,cloudflare_route:cloudflareRoute,
      target_chars:targetChars,actual_chars:actualChars,
      length_within_tolerance:lengthOk,usage:result.usage,preflight_warnings:preflightWarnings

    });
  }

  return json({ error: "unknown_action" }, 400);
});