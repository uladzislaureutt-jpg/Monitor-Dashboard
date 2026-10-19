// Controlled W-Review final-synthesis A/B. Two direct API calls, one per
// configured synthesis route, without any Supabase or operator/workroom access.
// Uses the original 18-article/167-Evidence synthetic pool and real v3 dossier
// planning/JSON block decoding, source-label protection and length corridor.
// Not an evaluation of the operator's actual uploaded author examples.
import {mkdirSync,writeFileSync,appendFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {fixtureCards,GOLD_FACETS} from "./trend-model-benchmark.mjs";
import {evidenceIndex,normalizeDossier,makeSynthesisDossier}
  from "./editorial-dossier.ts";
import {synthesisResponseSchema,readSynthesisBlocks} from "./synthesis-blocks.ts";
import {parseModelJsonObject} from "./gemini-routing.ts";
import {normalizeReviewSourceLabels,poolSourceNames} from "./review-output-guard.ts";

export const TARGET_CHARS=6000;
export const TARGETS_FOR_OFFLINE=[3000,4000,5000,6000,8000];
export const BENCHMARK_ROUTES=["cloudflare_first","gemini_first"];
const timeoutMs={cloudflare_first:103000,gemini_first:80000};
const syntheticStyle={
  profile:"Сдержанный аналитический обзор международных и региональных СМИ на русском языке. Абзацы связываются причинно-следственной логикой, сравнивают разные оценки и устанавливают пределы выводов. Никакой сухой инвентаризации публикаций и автоматических заключений.",
  excerpts:[
    {role:"opening",text:"Несколько редакций одновременно обратились к вопросу бюджетных приоритетов, однако совпадение темы не означало совпадения оценок. Одни авторы рассматривали затраты как необходимое условие развития, другие предупреждали об ограничениях методики. В центре спора оказались не столько сами цифры, сколько основания для долгосрочного прогноза."},
    {role:"comparison",text:"Различие состояло не в признании потребности обновить инфраструктуру, а в трактовке распределения будущих расходов. Одно издание выделяло механизмы привлечения средств, другое концентрировалось на уязвимости домохозяйств. Эти акценты не исключали друг друга, но задавали разные критерии оценки программы."},
    {role:"ending",text:"Дальнейшее развитие темы будет зависеть от появления проверяемых данных о затратах и результатах, а также от возможности сопоставить первоначальные обещания с ходом работ. Пока часть публикаций описывает ожидаемые преимущества, независимые оценки прежде всего обращают внимание на условия, при которых эти преимущества действительно могут проявиться."}
  ],
  composition:{sampleCount:3,medianParagraphChars:550,openingMedianChars:300,endingMedianChars:260,shortParagraphPct:20,attributionParagraphPct:70,comparisonParagraphPct:65}
};
const sourceId=n=>"P"+String(n).padStart(2,"0");
const firstRecord=pub=>pub+":E01";
const altRecord=pub=>pub+":E05";
export function synthesisFixture(target=TARGET_CHARS){
 if(!TARGETS_FOR_OFFLINE.includes(target))throw Error("INVALID_BENCHMARK_TARGET");
 const cards=fixtureCards(18),ix=evidenceIndex(cards);
 if(ix.entries.length!==167)throw Error("BAD_FIXTURE_EVIDENCE_COUNT");
 const trends=GOLD_FACETS.map((facet,i)=>{
   const pubs=facet.publications;
   // Each analytic line contains cross-source evidence and a real paired
   // disagreement; these references come from the synthetic gold corpus.
   const primary=pubs.map(firstRecord);
   const pair=[[1,4],[5,6],[8,10],[12,13],[16,18]][i];
   const opposite=altRecord(sourceId(pair[1]));
   const branchA={
     id:"B1",title:facet.name+" — аргументы и разные трактовки",
     claim:"Редакции обсуждают "+facet.name.toLocaleLowerCase("ru")+
       " и приводят несовпадающие оценки последствий проекта.",
     mechanism:"Проверка обоснованности планов, расходов и заявленных результатов.",
     counterpoint:"Сопоставимые издания и эксперты приводят противоположные оценки одного аспекта.",
     limitation:"Различные прогнозы требуют дополнительных подтверждений.",
     significance:"Различие оценок влияет на трактовку самостоятельной линии медиаполя.",
     priority:"high",required:true,
     evidence_ids:[...primary,altRecord(sourceId(pair[0]))],
     contrary_evidence_ids:[opposite]
   };
   return {
     id:"T"+(i+1),title:facet.name,
     summary:"Различные редакции анализируют "+facet.name.toLocaleLowerCase("ru")+
       " и не всегда сходятся в оценках.",
     thesis:"Сюжет предполагает сравнение нескольких самостоятельных источников.",
     operator_optional:false,optional_reason:"",
     branches:[branchA],
     sources:pubs.map(pub=>ix.entries.find(e=>e.publication===pub)?.source||"")
   };
 });
 const raw={trends,coverage:Array.from({length:18},(_,i)=>({
   publication_id:sourceId(i+1),status:"used",
   reason:"Подтверждено существующим источниковым Evidence в соответствующей аналитической линии."
 })),inventory:{quotes:0,headlines:18,experts:18}};
 const accepted=normalizeDossier(raw,cards,{requireEveryDistinctSource:true});
 if(accepted.error||!accepted.dossier)throw Error("INVALID_SYNTHETIC_DOSSIER:"+accepted.error);
 const plan=makeSynthesisDossier(accepted.dossier,trends.map(t=>t.id),target,cards,syntheticStyle.composition.medianParagraphChars);
 const sourceNames=[...poolSourceNames(cards).values()],registry=[...poolSourceNames(cards).entries()]
   .map(([id,name])=>id+" = «"+name+"»").join("; ");
 const evidenceText=cards.map((card,i)=>sourceId(i+1)+"\n"+card).join("\n\n");
 const lengthMinimum=Math.round(target*0.95),lengthMaximum=Math.round(target*1.05);
 const densityRule="Цитаты: умеренно, несколько лучших по ходу текста. Выразительные заголовки: умеренно. Эксперты: насыщенно, но только подтверждённые.";
 const system=[
   "Навык: РЕДАКЦИОННЫЙ МЕДИАОБЗОР W-REVIEW 1.0.",
   "Напиши ОДИН связный аналитический обзор тенденций медиаполя в индивидуальном стиле автора, не каталог изданий и не набор аннотаций.",
   "ЖАНР. Раскрой каждую выбранную тенденцию, все обязательные ветки, факты, механизмы и реальные контрпозиции по проверенному досье. Соедини публикации нескольких СМИ в содержательный рассказ; не пересказывай источники один за другим.",
   "ИСТОЧНИКИ. Учитывай ВСЕ Evidence Cards. Отделяй собственную оценку редакции от слов эксперта или чиновника. Нельзя утверждать, что СМИ поддерживает цитируемую позицию без доказательства.",
   "АТРИБУЦИЯ. Все видимые названия СМИ в кавычках « », никогда не используй Pxx/Eyy в тексте. Проверяй подлинные имена по SOURCE_REGISTRY. Не выдумывай цитат или чисел, не подменяй факты из STYLE_ONLY.",
   "ЯЗЫК. Основной текст, цитаты и заголовки — на русском языке, кроме цитат на белорусском; оригинальные названия организаций допустимы. Используй « », тире –. Скобки со СМИ ставь перед заключительной точкой: «... факт («СМИ»).».",
   "СОПОСТАВЛЕНИЕ. Достоверные противоположные оценки из разных изданий раскрывай как столкновение аргументов, а не как общий консенсус. Редкая содержательная деталь тоже заслуживает внимания.",
   "МАНЕРА. Соблюдай STYLE_PROFILE и примеры композиции как ритмический ориентир, не копируй факты из них. Не повторяй шаблонный финал. Избегай Markdown, списков, искусственных рубрик.",
   "РЕЗУЛЬТАТ. Верни ОДИН JSON с blocks, section_titles, bold_phrases. Каждый blocks содержит block_id и paragraphs; расположи блоки по единому плану: opening, line_1 ... line_N, ending. Не добавляй лишних блоков. Общий текст должен укладываться в "+lengthMinimum+"–"+lengthMaximum+" знаков с пробелами.",
   densityRule,
   "SOURCE_REGISTRY: "+registry,
   "STYLE_PROFILE: "+syntheticStyle.profile,
   "КОМПОЗИЦИОННАЯ СТАТИСТИКА: медианный абзац 550 знаков.",
   "STYLE_ONLY (примеры манеры, НЕ источник фактов):\n"+syntheticStyle.excerpts.map(e=>
     "["+e.role+"] "+e.text).join("\n")
 ].join("\n\n");
 const task="Подготовь аналитический обзор медиаполя о модернизации инфраструктуры вымышленного Новограда. Сопоставь пять направлений: финансирование, тарифы, логистику, экологию и контроль контрактов. Все 18 материалов и Evidence синтетические, не относятся к реальным событиям.";
 const user="ЗАДАНИЕ ОПЕРАТОРА:\n"+task+
   "\n\nРЕДАКЦИОННОЕ ДОСЬЕ И РАСПРЕДЕЛЕНИЕ ОБЪЁМА:\n"+plan.text+
   "\n\nИНСТРУКЦИЯ ДЛЯ ЭТАПА:\nРаскрывай подтверждённые сопоставления разных редакций."+
   "\n\nEVIDENCE CARDS:\n"+evidenceText+
   "\n\nФИНАЛЬНОЕ ЗАДАНИЕ: создай единый русский авторский обзор в blocks. Объём "+
     target+" знаков, допустимый коридор "+lengthMinimum+"–"+lengthMaximum+
     ". Каждый блок развивает соответствующую смысловую линию. Не дополняй недостающие факты выдумками. Сравни реальную аргументацию разных источников, используй только SOURCE_REGISTRY; не показывай Pxx и Eyy. Без Markdown и искусственных разделов.";
 return {cards,plan,target,sourceNames,system,user,bodyChars:system.length+user.length,
   expectedRefs:trends.flatMap(t=>t.branches.flatMap(b=>b.evidence_ids.concat(b.contrary_evidence_ids))),
   evidenceChars:evidenceText.length};
}
export function outputBudget(target){
 const visible=Math.ceil(target/1.25),reasoning=Math.max(1000,Math.min(3000,Math.ceil(visible*0.4)));
 return Math.min(11000,Math.max(1500,Math.ceil((visible+reasoning+450)/500)*500));
}
const extractCloudflare=payload=>{
 const a=payload?.result||payload||{};
 const v=a.response||a.choices?.[0]?.message?.content||a.output_text||
   a.output?.filter(x=>x.type==="message").flatMap(x=>x.content||[])
     .filter(x=>x.type==="output_text").map(x=>x.text).join("\n");
 return typeof v==="string"?v:v&&typeof v==="object"?JSON.stringify(v):"";
};
const geminiText=payload=>Array.isArray(payload?.candidates?.[0]?.content?.parts)
 ?payload.candidates[0].content.parts.filter(x=>!x.thought).map(x=>x.text||"").join(""):"";
const safeErr=e=>/AbortError|TimeoutError/i.test(String(e?.name))?"timeout":"transport";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function checkReview(content,fixture){
 const raw=parseModelJsonObject(content);
 const decoded=readSynthesisBlocks(raw,fixture.plan.blocks);
 const text=decoded.paragraphs.length?decoded.paragraphs.join("\n\n"):
   typeof raw?.review_text==="string"?raw.review_text:"";
 const guarded=normalizeReviewSourceLabels(text.trim(),fixture.cards);
 const polished=guarded.text.trim(),n=polished.length;
 const names=[...poolSourceNames(fixture.cards).values()];
 const sourceNamesFound=names.filter(name=>polished.includes("«"+name+"»"));
 const usedThemes=GOLD_FACETS.filter(f=>f.publications.some(pub=>
   sourceNamesFound.some(name=>name===poolSourceNames(fixture.cards).get(pub))));
 const paragraphs=polished.split(/\n\s*\n/).filter(Boolean);
 const englishSentences=(polished.match(/\b(?:The|This|There|According to|However|Moreover)\s+[a-z]{3,}(?:\s+[a-z]{3,}){3,}/gi)||[]).length;
 const suspiciousBareIds=(polished.match(/\bP\d{2}(?::E\d+)?\b/g)||[]).length;
 const markers=(polished.match(/\((?:«[^»]+»(?:,\s*)?)+\)/g)||[]).length;
 const duplicateParagraphs=new Set(paragraphs.map(p=>p.toLocaleLowerCase("ru").replace(/\s+/g," "))).size;
 return {json_parsed:!!raw,
   blocks_expected:fixture.plan.blocks.length,
   blocks_measured:decoded.metrics.length,
   blocks_underfilled:decoded.metrics.filter(x=>x.actual_chars<Math.round(x.target_chars*0.8)).length,
   block_warnings:decoded.warnings,
   actual_chars:n,chars_min:Math.round(fixture.target*.95),chars_max:Math.round(fixture.target*1.05),
   within_tolerance:n>=Math.round(fixture.target*.95)&&n<=Math.round(fixture.target*1.05),
   paragraphs:paragraphs.length,exact_duplicate_paragraphs:paragraphs.length-duplicateParagraphs,
   sources_named:sourceNamesFound.length,total_sources:names.length,
   themes_with_named_sources:usedThemes.length,total_themes:GOLD_FACETS.length,
   media_parenthetical_attributions:markers,
   unresolved_source_ids:guarded.unresolved.length,
   internal_id_leaks:suspiciousBareIds,
   untranslated_english_sentence_candidates:englishSentences,
   attribution_warnings:guarded.attributionWarnings.length,
   // Automated lexical proxies cannot prove factual/semantic fidelity,
   // authorial voice, expert attribution or real argumentative contrasts.
   qualitative_review_required:true};
}
export async function callProvider(route,fixture,keys,fetchImpl=fetch,timeoutOverrideMs=null){
 const started=Date.now(),controller=new AbortController();
 const t=setTimeout(()=>controller.abort(),Math.min(
   timeoutOverrideMs||timeoutMs[route],timeoutMs[route]));
 const out={route,model:route==="cloudflare_first"?"@cf/openai/gpt-oss-120b":"gemini-3.5-flash-lite",
   http_status:0,error_category:"",elapsed_ms:0,
   request_chars:0,target_chars:fixture.target,
   output_token_ceiling:route==="cloudflare_first"?outputBudget(fixture.target):16000,
   generated_text:"",raw_response:""};
 try{
  if(route==="cloudflare_first"&&!(keys?.cfAccount&&keys?.cfToken)||
    route==="gemini_first"&&!keys?.gemini){out.error_category="missing_secret";return out;}
  let url,body,headers;
  if(route==="cloudflare_first"){
   url="https://api.cloudflare.com/client/v4/accounts/"+
     encodeURIComponent(keys.cfAccount)+"/ai/run/@cf/openai/gpt-oss-120b";
   body={messages:[{role:"system",content:fixture.system},{role:"user",content:fixture.user}],
     temperature:0.36,reasoning_effort:"medium",max_tokens:out.output_token_ceiling,
     response_format:{type:"json_schema",json_schema:{
       name:"w_review_blocks_v1",strict:true,
       schema:synthesisResponseSchema(fixture.plan.blocks)}}};
   headers={Authorization:"Bearer "+keys.cfToken,"Content-Type":"application/json"};
  }else{
   url="https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";
   const prompt="ИНСТРУКЦИИ РЕДАКТОРА:\n"+fixture.system+
     "\n\nДАННЫЕ ДЛЯ ОБЗОРА:\n"+fixture.user+
     "\n\nВерни только один полный JSON-объект со структурой blocks, section_titles, bold_phrases. Без Markdown.";
   body={contents:[{role:"user",parts:[{text:prompt}]}],
     generationConfig:{responseMimeType:"application/json",maxOutputTokens:16000,
       thinkingConfig:{thinkingLevel:"low"}}};
   headers={"x-goog-api-key":keys.gemini,"Content-Type":"application/json"};
  }
  out.request_chars=JSON.stringify(body).length;
  const response=await fetchImpl(url,{method:"POST",headers,
    body:JSON.stringify(body),signal:controller.signal});
  out.http_status=response.status;
  const json=await response.json().catch(()=>null);
  if(!response.ok){
   out.error_category=response.status===429?"quota_or_capacity":response.status===413?
     "request_too_large":response.status===400?"invalid_request":"provider_http_failure";
   const code=Number(json?.errors?.[0]?.code||0);
   out.provider_error_code=Number.isSafeInteger(code)?code:0;
   return out;
  }
  const answer=route==="cloudflare_first"?json?.result||json:json;
  const content=route==="cloudflare_first"?extractCloudflare(json):geminiText(json);
  out.raw_response=content;
  const usage=route==="cloudflare_first"?answer?.usage:answer?.usageMetadata;
  out.input_tokens=Number(usage?.prompt_tokens??usage?.promptTokenCount??0);
  out.output_tokens=Number(usage?.completion_tokens??usage?.candidatesTokenCount??0);
  out.finish_reason=String(route==="cloudflare_first"?
    answer?.choices?.[0]?.finish_reason||answer?.finish_reason||"unknown":
    answer?.candidates?.[0]?.finishReason||"unknown").slice(0,32);
  out.content_chars=content.length;
  const metrics=checkReview(content,fixture);
  Object.assign(out,metrics);
  out.generated_text=(parseModelJsonObject(content)?.blocks||[])
    .flatMap(b=>Array.isArray(b.paragraphs)?b.paragraphs:[])
    .filter(x=>typeof x==="string").join("\n\n");
  out.error_category=metrics.json_parsed?"none":"invalid_synthesis_json";
 }catch(e){out.error_category=safeErr(e);}
 finally{clearTimeout(t);out.elapsed_ms=Date.now()-started;}
 return out;
}
export function markdownReport(results,fixture){
 const head=[
   "# W-Review synthetic 18/167 — final synthesis controlled provider comparison",
   "",
   "One standalone call to each configured route. Exact same SYNTHETIC 18 publications, 167 Evidence, v3 dossier, five editorial lines, common style samples and 6000-character target.",
   "This emulates the current production synthesis contract and calls real provider APIs, but DOES NOT execute Supabase quota, actual operator author style, DOCX export or local real user pool.",
   "",
   "| Route | HTTP | Seconds | Output tokens | Review chars | 5700–6300 | Blocks underfilled | Source names | Themes | Attribution warnings |",
   "|---|---:|---:|---:|---:|---|---:|---:|---:|---:|",
   ...results.map(x=>[
     "|",x.route,"|",x.http_status,"|",(x.elapsed_ms/1000).toFixed(1),"|",x.output_tokens||0,
     "|",x.actual_chars??0,"|",x.within_tolerance?"YES":"NO","|",x.blocks_underfilled??"-",
     "|",(x.sources_named??0)+"/18","|",(x.themes_with_named_sources??0)+"/5",
     "|",x.attribution_warnings??"-","|"
   ].join(" ")),
   "","## Per-route diagnostics"
 ];
 for(const x of results){
  head.push("","### "+x.route,
    "- HTTP "+x.http_status+", category "+x.error_category+", elapsed "+(x.elapsed_ms/1000).toFixed(2)+"s",
    "- Completion "+(x.finish_reason||"unknown")+", tokens "+(x.output_tokens??"?")+" of ceiling "+x.output_token_ceiling,
    "- JSON "+Boolean(x.json_parsed)+", blocks "+(x.blocks_measured??0)+"/"+fixture.plan.blocks.length,
    "- Characters "+(x.actual_chars??0)+", target "+fixture.target+" ±5%",
    "- Quoted source mentions "+(x.sources_named??0)+"/18; attributed parenthetical mentions "+(x.media_parenthetical_attributions??0),
    "- English sentence candidates "+(x.untranslated_english_sentence_candidates??0)+
     "; internal ID leaks "+(x.internal_id_leaks??0)+
     "; duplicate paragraphs "+(x.exact_duplicate_paragraphs??0),
    "- Content and individual arguments STILL require human reading; raw synthetic response and normalized prose saved as artifacts.");
 }
 return head.join("\n")+"\n";
}
export async function runBenchmark({keys,fetchImpl=fetch,output="out/w-review-synthesis-comparison",delayMs=5000}={}){
 const fixture=synthesisFixture();
 const results=[];
 for(const route of BENCHMARK_ROUTES){
  if(results.length&&delayMs>0)await sleep(delayMs);
  const full=await callProvider(route,fixture,keys,fetchImpl);
  const {raw_response,generated_text,...safe}=full;
  results.push(safe);
  mkdirSync(output+"/synthetic_outputs",{recursive:true});
  if(raw_response)writeFileSync(output+"/synthetic_outputs/"+route+"-raw.txt",raw_response+"\n");
  if(generated_text)writeFileSync(output+"/synthetic_outputs/"+route+"-review.txt",generated_text+"\n");
  console.info(JSON.stringify({route,status:safe.http_status,elapsed_ms:safe.elapsed_ms,
    chars:safe.actual_chars,within_tolerance:safe.within_tolerance,
    output_tokens:safe.output_tokens,error_category:safe.error_category}));
 }
 const report=markdownReport(results,fixture);
 mkdirSync(output,{recursive:true});
 writeFileSync(output+"/metrics.json",JSON.stringify({
  synthetic_only:true,created_at:new Date().toISOString(),
  source_publications:18,evidence_total:167,
  target_chars:TARGET_CHARS,source_input_chars:fixture.evidenceChars,
  dossier_chars:fixture.plan.text.length,
  provider_requests:results.filter(x=>x.error_category!=="missing_secret").length,
  results},null,2)+"\n");
 writeFileSync(output+"/report.md",report);
 if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,report);
 return results;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 runBenchmark({keys:{
  gemini:process.env.GEMINI_API_KEY||process.env.GOOGLE_GEMINI_API_KEY||"",
  cfAccount:process.env.CLOUDFLARE_ACCOUNT_ID||"",cfToken:process.env.CLOUDFLARE_API_TOKEN||""
 }}).catch(e=>{console.error("BENCHMARK_FAILURE "+String(e?.name||"internal"));process.exitCode=1;});
}
