// Synthetic-only W-Review dossier model comparison. Does not call Supabase
// or touch saved operator Evidence. Live calls run only on manual workflow_dispatch.
import {mkdirSync,writeFileSync,appendFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {compactDossierCards,dossierOutputContract,DOSSIER_INSTRUCTIONS,
  normalizeDossier,dossierShape,evidenceIndex} from "./editorial-dossier.ts";
import {reconcileDossierDraft} from "./dossier-reconciliation.ts";
import {parseModelJsonObject} from "./gemini-routing.ts";

export const MODEL_SPECS=[
  {id:"gemini35",provider:"gemini",model:"gemini-3.5-flash-lite",tier:"Google Free (separate quota)"},
  {id:"oss120",provider:"cloudflare",model:"@cf/openai/gpt-oss-120b",tier:"Workers AI free allocation"},
  {id:"nemotron120",provider:"cloudflare",model:"@cf/nvidia/nemotron-3-120b-a12b",tier:"Workers AI free allocation"},
  {id:"gemma4",provider:"cloudflare",model:"@cf/google/gemma-4-26b-a4b-it",tier:"Workers AI free allocation"},
  {id:"glm47",provider:"cloudflare",model:"@cf/zai-org/glm-4.7-flash",tier:"Workers AI free allocation"}
];
export const COHORTS=["small","full"];
const SOURCES=[
 ["Северная деловая редакция","Финансирование региональной модернизации","Рост бюджетного участия"],
 ["Бюджетное обозрение","Долговое обеспечение проектов","Потребность в новых гарантиях"],
 ["Аналитика инфраструктуры","Задержки капитальных программ","Опасения срыва сроков"],
 ["Региональный экономист","Альтернативные источники инвестиций","Возможность частного софинансирования"],
 ["Социальная панорама","Тарифы и доступность услуг","Рост расходов семей"],
 ["Новости районов","Поддержка уязвимых потребителей","Недостаток адресных компенсаций"],
 ["Общественная трибуна","Разные оценки тарифной политики","Спор о распределении расходов"],
 ["Торговый обзор","Экспортные маршруты и узкие места","Пределы транспортных возможностей"],
 ["Логистический вестник","Смена транзитных коридоров","Преимущества альтернативного пути"],
 ["Зарубежная экономика","Перспективы торговых связей","Сомнения в прогнозе экспорта"],
 ["Промышленный журнал","Готовность предприятий к перестройке","Дефицит оборудования"],
 ["Экологическая редакция","Ущерб окружающей среде","Риск ухудшения качества воды"],
 ["Научный бюллетень","Замеры качества воздуха","Потребность в независимых измерениях"],
 ["Ресурсный обзор","Энергопотребление модернизации","Рост спроса на электричество"],
 ["Зелёные исследования","Споры о климатическом эффекте","Ограничения экологических прогнозов"],
 ["Муниципальный контроль","Открытость государственных контрактов","Недостаток публикации данных"],
 ["Местная независимая газета","Обратная связь жителей","Ограниченное участие населения"],
 ["Отраслевой аналитик","Сомнения в официальных прогнозах","Редкая контраргументация"]
];
const TEMPLATES=[
 "Редакция сообщает, что обсуждается проект модернизации инфраструктуры вымышленной территории Новоград.",
 "Публикация приводит отдельную оценку расходов и предупреждает об ограничениях расчетной методики.",
 "Авторы различают позицию государственных органов и самостоятельные оценки приглашенных специалистов.",
 "Журналист выделяет механизм изменения условий проекта и риск задержки выполнения программы.",
 "Эксперт, которого цитирует издание, выдвигает проверяемый контраргумент против ведущего прогноза.",
 "В материале отмечена уникальная подробность, которую другие редакции пока не рассматривали.",
 "Приведен отдельный количественный пример: величина показателя выросла на 7 процентов по сравнению с исходным сценарием.",
 "Авторы указывают на неопределенность сроков и различие между первоначальным и скорректированным планами.",
 "В заключении содержится прогноз: модернизация может дать выигрыш только при контроле расходов и независимой экспертизе.",
 "Редакция ставит под сомнение достаточность опубликованных гарантий и предлагает расширить общественный контроль."
];
const KIND=["fact","detail","media_angle","explanation","counterposition","expert","fact","limitation","expert","editorial_stance"];
export function fixtureCards(size=8){
 if(size!==8&&size!==18)throw Error("FIXTURE_SIZE_MUST_BE_8_OR_18");
 return SOURCES.slice(0,size).map(([source,title,angle],i)=>{
   const pub="P"+String(i+1).padStart(2,"0");
   // Full cohort has exactly 167 Evidence (5 x 10, 13 x 9), matching the
   // latest production pool's size, but with no production/user content.
   const count=size===18?(i<5?10:9):10;
   const entries=TEMPLATES.slice(0,count).map((statement,j)=>{
     const unique=statement+" Источник «"+source+"» делает акцент: "+angle+". "+
       "Вариант интерпретации "+(j+1)+" относится исключительно к этому публикационному материалу.";
     const id="E"+String(j+1).padStart(2,"0");
     return id+" ["+KIND[j]+"/P"+String(j+1).padStart(3,"0")+"] "+unique+
       " | SOURCE: «Синтетическая выдержка для проверки маршрутизации.»";
   });
   return ["ID: "+pub,"ИСТОЧНИК: «"+source+"»","ЗАГОЛОВОК: "+title,
     "КАТАЛОЖНЫЙ_РЕГИОН: Тестовый регион",
     "URL: https://synthetic.invalid/w-review-"+(i+1),
     ...entries].join("\n");
 });
}
export function fixtureSet(cohort="small"){
 const cards=fixtureCards(cohort==="small"?8:18);
 const compact=compactDossierCards(cards);
 const evidenceText=compact.join("\n\n");
 const task="Подготовь редакционное досье о том, как независимые СМИ освещают "+
   "модернизацию инфраструктуры в вымышленной территории Новоград: "+
   "группы тенденций, аргументы и контраргументы, различия в позициях и "+
   "редкие самостоятельные сюжеты. Все публикации являются искусственными тестовыми данными.";
 const mapUserInput="ЗАДАНИЕ ОПЕРАТОРА:\n"+task+
   "\n\nДОКАЗАТЕЛЬНАЯ БАЗА (P01:E01 — E01 в статье P01):\n"+evidenceText+
   "\n\n"+dossierOutputContract(cards.length);
 const prompt=DOSSIER_INSTRUCTIONS+"\n\n"+mapUserInput;
 const index=evidenceIndex(cards);
 return {cohort,cards,compact,prompt,evidenceText,source_count:cards.length,
   evidence_count:index.entries.length,rareSource:cohort==="small"?"P08":"P18",
   input_characters:prompt.length};
}
const safeError=err=>{
 const raw=String(err||"");
 if(/abort|timeout/i.test(raw))return "timeout";
 if(/fetch failed|network|ECONN|ENOTFOUND|TLS/i.test(raw))return "network";
 return "transport_error";
};
export function evaluateDossier(content,cards,rareSource){
 const raw=parseModelJsonObject(content||"");
 const strict=normalizeDossier(raw,cards,{requireEveryDistinctSource:true});
 let repaired=null,repair=null;
 if(strict.error&&raw){
   repair=reconcileDossierDraft(raw,cards);
   if(repair)repaired=normalizeDossier(repair.draft,cards,{requireEveryDistinctSource:true});
 }
 const chosen=strict.dossier||repaired?.dossier||null;
 const fromRaw=Array.isArray(raw?.trends)?raw.trends:[];
 const refs=fromRaw.flatMap(t=>Array.isArray(t?.branches)?t.branches.flatMap(b=>
   [...(Array.isArray(b?.evidence_ids)?b.evidence_ids:[]),
    ...(Array.isArray(b?.contrary_evidence_ids)?b.contrary_evidence_ids:[])]):[]);
 const index=evidenceIndex(cards);
 const validRefs=new Set(refs.filter(id=>typeof id==="string"&&index.byId.has(id)));
 const usedPubs=new Set([...validRefs].map(id=>index.byId.get(id).publication));
 const counterRefs=fromRaw.flatMap(t=>Array.isArray(t?.branches)?
   t.branches.flatMap(b=>Array.isArray(b?.contrary_evidence_ids)?b.contrary_evidence_ids:[]):[]);
 const data=chosen||raw;
 return {
   parsed_json:Boolean(raw),
   strict_valid:Boolean(strict.dossier),
   repaired_valid:Boolean(repaired?.dossier),
   strict_error:String(strict.error||"").slice(0,100),
   repaired_error:String(repaired?.error||"").slice(0,100),
   trends:dossierShape(data).trends_count,
   branches:dossierShape(data).branch_counts.reduce((a,b)=>a+b,0),
   coverage_entries:dossierShape(data).coverage_count,
   valid_references:validRefs.size,
   invalid_references:refs.length-refs.filter(id=>index.byId.has(id)).length,
   linked_publications:usedPubs.size,
   rare_source_linked:usedPubs.has(rareSource),
   contrary_references:counterRefs.filter(id=>index.byId.has(id)).length,
   total_evidence_ids:index.entries.length,
   coverage_complete:Boolean(chosen)&&chosen.coverage.length===cards.length,
   recovered_sources:repair?.additionalSources??0,
   discarded_branches:repair?.removedBranches??0
 };
}
export function extractCloudflareText(payload){
 const ans=payload?.result??payload??{};
 const candidate=ans?.response??ans?.choices?.[0]?.message?.content??ans?.output_text??
   ans?.output?.filter(x=>x.type==="message").flatMap(x=>x.content||[])
     .filter(x=>x.type==="output_text").map(x=>x.text).join("\n")??null;
 if(typeof candidate==="string")return candidate;
 if(candidate&&typeof candidate==="object")return JSON.stringify(candidate);
 return "";
}
function parseGoogleText(payload){
 return (payload?.candidates?.[0]?.content?.parts||[]).filter(x=>x?.thought!==true)
   .map(x=>String(x?.text||"")).join("");
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function callCandidate(spec,fixture,keys,fetchImpl=fetch,timeoutMs=100000){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 let row={model_id:spec.id,model:spec.model,cohort:fixture.cohort,provider:spec.provider,
   source_count:fixture.source_count,evidence_count:fixture.evidence_count,
   input_characters:fixture.input_characters,http_status:0,elapsed_ms:0,
   request_timeout_ms:timeoutMs,model_eligible:"unverified"};
 const started=Date.now();
 try{
   if(spec.provider==="gemini"&&!keys.gemini){
     row.error_category="missing_gemini_secret";row.model_eligible="not_tested";return row;
   }
   if(spec.provider==="cloudflare"&&(!keys.cfAccount||!keys.cfToken)){
     row.error_category="missing_cloudflare_secret";row.model_eligible="not_tested";return row;
   }
   let url,headers,body;
   if(spec.provider==="gemini"){
     url="https://generativelanguage.googleapis.com/v1beta/models/"+
       encodeURIComponent(spec.model)+":generateContent";
     headers={"x-goog-api-key":keys.gemini,"content-type":"application/json"};
     body={contents:[{role:"user",parts:[{text:fixture.prompt}]}],
       generationConfig:{responseMimeType:"application/json",maxOutputTokens:8000,
         thinkingConfig:{thinkingLevel:"low"}}};
   }else{
     url="https://api.cloudflare.com/client/v4/accounts/"+
       encodeURIComponent(keys.cfAccount)+"/ai/run/"+spec.model;
     headers={"Authorization":"Bearer "+keys.cfToken,"Content-Type":"application/json"};
     body={messages:[{role:"system",content:DOSSIER_INSTRUCTIONS},
       {role:"user",content:fixture.prompt.slice(DOSSIER_INSTRUCTIONS.length+2)}],
       max_tokens:8000,temperature:0.1};
     if(spec.id==="oss120"){
       body.reasoning_effort="low";
       body.response_format={type:"json_object"};
     }
     if(spec.id==="nemotron120"){
       body.chat_template_kwargs={enable_thinking:false};
     }
   }
   const response=await fetchImpl(url,{method:"POST",headers,
     body:JSON.stringify(body),signal:controller.signal});
   row.http_status=response.status;
   let payload;
   try{payload=await response.json()}catch{payload=null}
   row.model_eligible=response.status===403?"free_tier_rejected":
     response.status===429?"rate_or_free_neuron_limit":
     response.status===200?"available":"unverified";
   if(!response.ok){
     row.error_category=response.status===400?"invalid_request":
       response.status===403?"free_tier_or_permission":
       response.status===429?"rate_or_daily_limit":
       response.status===413?"request_too_large":"provider_http_error";
     return row;
   }
   const content=spec.provider==="gemini"?parseGoogleText(payload):extractCloudflareText(payload);
   const stats=evaluateDossier(content,fixture.cards,fixture.rareSource);
   const u=spec.provider==="gemini"?payload?.usageMetadata:payload?.result?.usage??payload?.usage;
   Object.assign(row,stats,{output_characters:content.length,
     output_tokens:Number(u?.candidatesTokenCount??u?.completion_tokens??0),
     input_tokens:Number(u?.promptTokenCount??u?.prompt_tokens??0),
     finish_reason:String(spec.provider==="gemini"?payload?.candidates?.[0]?.finishReason:
       payload?.result?.choices?.[0]?.finish_reason??payload?.result?.finish_reason??"").slice(0,25)});
   return row;
 }catch(err){
   row.error_category=safeError(err?.name||err);return row;
 }finally{
   clearTimeout(timer);
   row.elapsed_ms=Date.now()-started;
 }
}
const report=(res)=>{
 const rows=res.rows;
 const h=["# W-Review — trend-model comparison (synthetic corpus)","",
   "No operator data. No production model switches. Results measure structural and Evidence-reference correctness, not expert semantic quality.",
   "All models receive the current W-Review dossier instructions, the same verified compact Evidence and the same per-publication coverage obligation.",
   "",
   "| Model | Cohort | HTTP | Seconds | Strict valid | Reconciled | Trends | Branches | Sources linked | Valid IDs | Invalid IDs | Rare source |",
   "|---|---|---:|---:|---|---|---:|---:|---:|---:|---:|---|"];
 for(const r of rows)h.push("| "+[r.model_id,r.cohort,r.http_status,
   ((r.elapsed_ms||0)/1000).toFixed(1),r.strict_valid?"yes":"no",
   r.repaired_valid?"yes":"no",r.trends??0,r.branches??0,
   (r.linked_publications??0)+"/"+r.source_count,r.valid_references??0,
   r.invalid_references??0,r.rare_source_linked?"yes":"no"].join(" | ")+" |");
 h.push("","## Free-tier and API eligibility","",
   "| Model | Provider | Eligibility | Error category |",
   "|---|---|---|---|");
 for(const r of rows)h.push("| "+[r.model_id,r.provider,r.model_eligible,
   r.error_category??(r.strict_error||"-")].join(" | ")+" |");
 h.push("","Each Cloudflare Workers AI request consumes neurons from a shared account-wide daily allowance. A successful request does not prove unlimited free usage.",
   "Missing GitHub Actions secrets produce NOT_TESTED, not a successful benchmark.",
   "Real production pools and secrets never enter the output artifact.");
 return h.join("\n")+"\n";
};
export async function runComparison({keys,cohorts=["small","full"],
 models=MODEL_SPECS,delayMs=8000,fetchImpl=fetch,
 output="out/w-review-trends-model-compare",maxCalls=10}){
 if(!Array.isArray(cohorts)||cohorts.some(c=>!COHORTS.includes(c)))throw Error("INVALID_COHORT");
 if(models.length*cohorts.length>maxCalls)throw Error("TEST_CALL_LIMIT_EXCEEDED");
 const rows=[];let n=0;
 for(const cohort of cohorts){
   const fixture=fixtureSet(cohort);
   for(const spec of models){
     if(n++>0&&delayMs>0)await sleep(delayMs);
     const row=await callCandidate(spec,fixture,keys,fetchImpl,cohort==="full"?115000:85000);
     rows.push(row);
     console.info(JSON.stringify({model_id:row.model_id,cohort:row.cohort,
       http_status:row.http_status,elapsed_ms:row.elapsed_ms,strict_valid:row.strict_valid,
       repaired_valid:row.repaired_valid,linked_publications:row.linked_publications,
       valid_references:row.valid_references,error_category:row.error_category}));
   }
 }
 const result={date:new Date().toISOString(),synthetic_only:true,models:models.map(x=>x.id),
   cohorts,requests:rows.filter(x=>x.model_eligible!=="not_tested").length,rows};
 mkdirSync(output,{recursive:true});
 writeFileSync(output+"/metrics.json",JSON.stringify(result,null,2)+"\n");
 writeFileSync(output+"/report.md",report(result));
 if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,report(result));
 return result;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const cohort=process.env.TEST_COHORT||"both";
 runComparison({
   keys:{gemini:process.env.GEMINI_API_KEY||process.env.GOOGLE_GEMINI_API_KEY||"",
     cfAccount:process.env.CLOUDFLARE_ACCOUNT_ID||"",
     cfToken:process.env.CLOUDFLARE_API_TOKEN||""},
   cohorts:cohort==="both"?["small","full"]:[cohort],
   delayMs:8000
 }).catch(err=>{console.error("DIAGNOSTIC_FAILED "+safeError(err?.message||err));process.exitCode=1;});
}
