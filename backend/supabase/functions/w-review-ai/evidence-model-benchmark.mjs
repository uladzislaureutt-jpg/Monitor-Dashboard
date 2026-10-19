// W-Review Evidence model A/B/C: isolated REAL API diagnostic on synthetic texts.
// No Supabase, operator workspaces, automatic production changes or uploaded articles.
// A/B/C model comparison is independent of the JSON-schema experiment.
import {mkdirSync,writeFileSync,appendFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {
  makeEvidenceDocuments,renderEvidenceMaterials,evidenceV2Instructions,
  verifyEvidenceCardsIndividually,evidenceQualityWarnings,formatEvidenceCard
} from "./evidence-v2.ts";
import {parseEvidenceJson} from "./evidence-json-recovery.ts";
import {fixtureSets} from "./schema-benchmark.mjs";
import {extractCloudflareText} from "./trend-model-benchmark.mjs";

export const EVIDENCE_MODELS=[
  {id:"gemini35",provider:"gemini",model:"gemini-3.5-flash-lite"},
  {id:"oss120",provider:"cloudflare",model:"@cf/openai/gpt-oss-120b"},
  {id:"nemotron120",provider:"cloudflare",model:"@cf/nvidia/nemotron-3-120b-a12b"}
];
const EXTENSIONS=[
 "Согласно проекту, договоры должны учитывать стоимость обслуживания на протяжении пяти лет. Отдельно будет представлена таблица гарантийных обязательств для оборудования.",
 "Представители совета сообщают, что в отчетности смешаны капитальные и текущие затраты. Это не позволяет понять, почему прогноз отличается от прошлогоднего.",
 "Исследователь Елена Васильева уточняет: «Предыдущая оценка была предварительной и включала лишь два района». Выборка должна быть расширена до пяти районов.",
 "В проекте назван риск задержек из-за длительных процедур закупок. Ведомство предполагает сократить срок согласования, но не представило окончательных решений.",
 "Независимый финансовый аналитик полагает, что бюджетные предположения слишком оптимистичны. Он ссылается на возможное повышение стоимости строительных материалов.",
 "Председатель комиссии возражает критикам: «Все дополнительные расходы будут отдельно согласованы до подписания контрактов». Других численных гарантий он не назвал.",
 "Редакция обращает внимание на несовпадение двух таблиц плановых расходов. Первая включает семь объектов, вторая — девять, причины расхождения пока не объяснены.",
 "Представители местных жителей приветствуют проект, но просят разместить его полную документацию для общественного обсуждения до заключения договоров.",
 "В документе содержится второй сценарий: при ограничении финансирования часть мероприятий перенесут на следующий год, при этом будут сохранены текущие услуги.",
 "Эксперт по контролю качества считает, что результат нельзя измерять только количеством закупленной техники. Требуется также проверить доступность услуг для жителей.",
 "Организаторы сообщили о консультациях с тремя научными учреждениями. Их письменные заключения планируется включить в окончательный вариант проектной документации.",
 "Региональное управление признает, что для некоторых показателей отсутствует исходный ряд измерений. Указанный пробел ограничивает надежность долгосрочного прогноза.",
 "Публикация отдельно сопоставляет опыт двух соседних городов. В одном подрядчик уложился в срок, в другом приемку работ перенесли на четыре месяца.",
 "В заключении редакция приводит мнение представителей малого бизнеса. Они предлагают учитывать простои организаций в расчетах ожидаемого экономического эффекта."
];
export function testCorpus(){
 const base=fixtureSets();
 const short=base[0].docs.map((d,index)=>({...d,index}));
 const long=base[1].docs.map((d,index)=>{
   const addition=EXTENSIONS.map((part,i)=>
     part+" Дополнение к пункту "+(i+1)+": редакционные оценки приводятся только в рамках этой тестовой статьи.");
   return makeEvidenceDocuments([{
     publication_id:d.publication_id,index,source:d.source,title:d.title,region:d.region,
     text:d.passages.map(x=>x.text).concat(addition).join("\n\n")
   }])[0];
 });
 return [{name:"short_pair",docs:short},{name:"long_pair",docs:long}];
}
export function identicalEvidencePrompt(docs){
 return evidenceV2Instructions+"\n\n"+
  "Верни ровно "+docs.length+" карточки. CARD_INDEX исходного документа: 0 или 1. "+
  "Опирайся только на доказуемые выдержки.\n\n"+
  renderEvidenceMaterials(docs);
}
const pause=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const classifyError=(value)=>/AbortError|TimeoutError|timeout/i.test(String(value))?"timeout":"transport_error";
export function evaluateEvidence(content,docs){
 const recovery=parseEvidenceJson(content,docs.length);
 const checked=verifyEvidenceCardsIndividually(recovery.payload,docs);
 const accepted=checked.accepted;
 const acceptedRecords=accepted.reduce((a,x)=>a+x.card.validation.accepted,0);
 const rejectedRecords=accepted.reduce((a,x)=>a+x.card.validation.rejected,0);
 const totalPassages=docs.reduce((a,d)=>a+d.passages.length,0);
 const coveredPassages=accepted.reduce((a,x)=>a+x.card.validation.covered_passages,0);
 const kinds={};
 let confirmedQuotes=0,experts=0,oppositions=0,coveredFinalThird=0;
 const perArticle=accepted.map(item=>{
   const d=docs[item.index];
   const count=item.card.validation.accepted;
   const passages=new Set(item.card.records.map(rec=>rec.anchor_id));
   const trailing=d.passages.slice(Math.floor(d.passages.length*2/3));
   const lastThird=trailing.some(p=>passages.has(p.id));
   if(lastThird)coveredFinalThird++;
   for(const record of item.card.records){
     kinds[record.kind]=(kinds[record.kind]||0)+1;
     if(record.kind==="quote")confirmedQuotes++;
     if(record.kind==="expert")experts++;
     if(record.kind==="counterposition")oppositions++;
   }
   return {
     publication_id:d.publication_id,index:item.index,records:count,
     covered_passages:item.card.validation.covered_passages,
     total_passages:item.card.validation.total_passages,
     rejected:item.card.validation.rejected,
     warnings:evidenceQualityWarnings(item.card,d),
     final_third_covered:lastThird
   };
 });
 return {
   json_recovery:recovery.method,
   cards_accepted:accepted.length,
   cards_requested:docs.length,
   records_accepted:acceptedRecords,
   records_rejected:rejectedRecords,
   passages_covered:coveredPassages,
   passages_total:totalPassages,
   coverage_fraction:totalPassages?Number((coveredPassages/totalPassages).toFixed(3)):0,
   cards_with_weak_coverage:perArticle.filter(x=>x.warnings.length>0).length,
   final_third_covered:coveredFinalThird,
   kinds,confirmed_quotes:confirmedQuotes,expert_records:experts,
   counterposition_records:oppositions,
   per_article:perArticle,
   failures:checked.failed.map(x=>({index:x.index,reason:x.reason})),
   synthetic_cards:accepted.map(x=>({index:x.index,card:formatEvidenceCard(x.card)}))
 };
}
export async function callEvidenceModel(spec,docs,keys,fetchImpl=fetch,timeoutMs=110000,onRaw=()=>{}){
 const started=Date.now(),controller=new AbortController(),
   timer=setTimeout(()=>controller.abort(),timeoutMs);
 const result={
   model_id:spec.id,model:spec.model,provider:spec.provider,
   status:0,elapsed_ms:0,prompt_characters:identicalEvidencePrompt(docs).length,
   source_characters:docs.reduce((n,d)=>n+d.passages.reduce((m,p)=>m+p.text.length,0),0),
   passages_total:docs.reduce((n,d)=>n+d.passages.length,0),
   cards_requested:docs.length,request_timeout_ms:timeoutMs,eligibility:"unverified"
 };
 try{
   const prompt=identicalEvidencePrompt(docs);
   if(spec.provider==="gemini"&&!keys.gemini){result.error_category="missing_key";result.eligibility="not_tested";return result;}
   if(spec.provider==="cloudflare"&&!(keys.cfAccount&&keys.cfToken)){
     result.error_category="missing_key";result.eligibility="not_tested";return result;
   }
   let url,headers,body;
   if(spec.provider==="gemini"){
     url="https://generativelanguage.googleapis.com/v1beta/models/"+
       encodeURIComponent(spec.model)+":generateContent";
     headers={"x-goog-api-key":keys.gemini,"content-type":"application/json"};
     body={contents:[{role:"user",parts:[{text:prompt}]}],
       generationConfig:{responseMimeType:"application/json",maxOutputTokens:12000,
         thinkingConfig:{thinkingLevel:"low"}}};
   }else{
     url="https://api.cloudflare.com/client/v4/accounts/"+
       encodeURIComponent(keys.cfAccount)+"/ai/run/"+spec.model;
     headers={"authorization":"Bearer "+keys.cfToken,"content-type":"application/json"};
     body={messages:[{role:"user",content:prompt}],temperature:0.1,max_tokens:12000};
     if(spec.id==="oss120"){
       body.response_format={type:"json_object"};body.reasoning_effort="low";
     }
     if(spec.id==="nemotron120")body.chat_template_kwargs={enable_thinking:false};
   }
   const response=await fetchImpl(url,{method:"POST",headers,body:JSON.stringify(body),signal:controller.signal});
   result.status=response.status;
   let bodyResponse;
   try{bodyResponse=await response.json();}catch{bodyResponse=null;}
   result.eligibility=response.status===200?"available":response.status===403?
     "paid_or_permission_restricted":response.status===429?"quota_or_capacity":"unverified";
   if(!response.ok){
     // Cloudflare 429/3036 means daily neurons; 4006 requires message classification; 429/3040 is
     // temporary capacity. Do NOT log provider free-text error messages.
     const code=Number(bodyResponse?.errors?.[0]?.code??bodyResponse?.error?.code??0);
     result.provider_error_code=Number.isSafeInteger(code)?code:0;
     const detail=String(bodyResponse?.errors?.[0]?.message??bodyResponse?.error?.message??"").toLowerCase();
     result.provider_error_category=/daily free allocation|used up.{0,50}neurons|10,000 neurons|free allocation/i.test(detail)
       ?"daily_neurons":/temporarily at capacity|out of capacity|capacity temporarily/i.test(detail)
       ?"capacity":"unclassified";
     const retry=response.headers.get("retry-after")||"";
     if(/^\d{1,4}$/.test(retry))result.retry_after_seconds=Number(retry);
     result.error_category=response.status===400?"invalid_request":response.status===403?
       "free_tier_or_auth":response.status===429&&(code===3036||
         (code===4006&&result.provider_error_category==="daily_neurons"))?"daily_neuron_quota":
       response.status===429&&(code===3040||
         (code===4006&&result.provider_error_category==="capacity"))?"cloudflare_out_of_capacity":
       response.status===429?"cloudflare_429_other":
       response.status===413?"request_too_large":"provider_error";
     return result;
   }
   const content=spec.provider==="gemini"?
     (bodyResponse?.candidates?.[0]?.content?.parts||[])
       .filter(part=>part.thought!==true).map(part=>String(part.text||"")).join("")
     :extractCloudflareText(bodyResponse);
   onRaw({model_id:spec.id,content:content.slice(0,250000)});
   const metrics=evaluateEvidence(content,docs);
   const u=spec.provider==="gemini"?bodyResponse?.usageMetadata:
     bodyResponse?.result?.usage||bodyResponse?.usage||{};
   Object.assign(result,{...metrics,input_tokens:Number(u?.promptTokenCount??u?.prompt_tokens??0),
     output_tokens:Number(u?.candidatesTokenCount??u?.completion_tokens??0),
     output_characters:content.length,
     finish_reason:String(spec.provider==="gemini"?bodyResponse?.candidates?.[0]?.finishReason:
       bodyResponse?.result?.choices?.[0]?.finish_reason||"").slice(0,32)});
   delete result.synthetic_cards;
   return result;
 }catch(error){
   result.error_category=classifyError(error?.name||error);return result;
 }finally{
   clearTimeout(timer);result.elapsed_ms=Date.now()-started;
 }
}
const report=(rows)=>{
 const result=["# Evidence extraction — Gemini 3.5 vs Cloudflare 120B vs Nemotron 120B",
   "","Synthetic articles only, original Evidence v2 prompt and server-side verification.",
   "One call per model per cohort. Counts describe verified records; no model result is promoted to production.",
   "","| Cohort | Model | HTTP | Seconds | Cards | Verified records | Passage coverage | Weak cards | Final third | Quotes | Experts | Counterpositions |",
   "|---|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|"];
 for(const row of rows)result.push("| "+[
   row.cohort,row.model_id,row.status,((row.elapsed_ms||0)/1000).toFixed(1),
   (row.cards_accepted??0)+"/"+row.cards_requested,row.records_accepted??0,
   (row.passages_covered??0)+"/"+row.passages_total,row.cards_with_weak_coverage??"-",
   row.final_third_covered??"-",row.confirmed_quotes??0,row.expert_records??0,row.counterposition_records??0
 ].join(" | ")+" |");
 result.push("","Each Cloudflare model uses the same account's Workers AI free daily allocation.",
   "No automatic retries; 4006/3036 indicates Cloudflare account free-Neurons denial; 3040 means temporary capacity. Neither is a measure of extraction quality.",
   "The synthetic complete Evidence cards are saved for editorial inspection; the model order in Monitor remains unchanged.");
 return result.join("\n")+"\n";
};
export async function runEvidenceComparison({keys,models=EVIDENCE_MODELS,
 cohorts=testCorpus(),fetchImpl=fetch,output="out/w-review-evidence-models",delayMs=9000,maxCalls=6}){
 if(cohorts.length*models.length>maxCalls)throw Error("REQUEST_LIMIT_EXCEEDED");
 const rows=[];let count=0;const outputs=[];
 let dailyNeuronBlocked=false;
 for(const cohort of cohorts)for(const spec of models){
   if(count++&&delayMs>0)await pause(delayMs);
   const row=spec.provider==="cloudflare"&&dailyNeuronBlocked
     ?{model_id:spec.id,provider:spec.provider,status:0,elapsed_ms:0,
       cards_requested:cohort.docs.length,passages_total:cohort.docs.reduce((n,d)=>n+d.passages.length,0),
       eligibility:"not_tested",error_category:"skipped_cloudflare_daily_neuron_quota"}
     :await callEvidenceModel(spec,cohort.docs,keys,fetchImpl,110000,
       raw=>outputs.push({...raw,cohort:cohort.name}));
   if(row.error_category==="daily_neuron_quota")dailyNeuronBlocked=true;
   row.cohort=cohort.name;rows.push(row);
   console.info(JSON.stringify({cohort:row.cohort,model_id:row.model_id,status:row.status,
     elapsed_ms:row.elapsed_ms,cards_accepted:row.cards_accepted,
     records_accepted:row.records_accepted,passages_covered:row.passages_covered,
     error_category:row.error_category,provider_error_code:row.provider_error_code}));
 }
 mkdirSync(output,{recursive:true});
 writeFileSync(output+"/metrics.json",JSON.stringify({
   time:new Date().toISOString(),synthetic_only:true,rows,requests:rows.filter(r=>r.eligibility!=="not_tested").length
 },null,2)+"\n");
 writeFileSync(output+"/report.md",report(rows));
 mkdirSync(output+"/synthetic_outputs",{recursive:true});
 for(const x of outputs)writeFileSync(output+"/synthetic_outputs/"+x.cohort+"-"+x.model_id+".txt",x.content+"\n");
 if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,report(rows));
 return rows;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 runEvidenceComparison({keys:{
   gemini:process.env.GEMINI_API_KEY||process.env.GOOGLE_GEMINI_API_KEY||"",
   cfAccount:process.env.CLOUDFLARE_ACCOUNT_ID||"",
   cfToken:process.env.CLOUDFLARE_API_TOKEN||""
 }}).catch(error=>{console.error("BENCHMARK_FAILED:"+classifyError(error?.message||error));process.exitCode=1;});
}
