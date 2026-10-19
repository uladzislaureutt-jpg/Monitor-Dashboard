// Isolated A/B/C Gemini 3.5 Evidence experiment. NEVER touches user workspaces.
// Read-only synthetic sources, no telemetry of raw prompts or generated text.
import {mkdirSync,writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {makeEvidenceDocuments,renderEvidenceMaterials,evidenceV2Instructions,
  verifyEvidenceCardsIndividually,evidenceQualityWarnings} from "./evidence-v2.ts";
import {parseEvidenceJson} from "./evidence-json-recovery.ts";

export const MODEL="gemini-3.5-flash-lite";
export const VARIANTS=["A_json","B_minimal","C_extended"];
const stringField={type:"string"};
const recordFields={
  kind:stringField,statement_ru:stringField,anchor_id:stringField,
  source_excerpt:stringField,original_quote:stringField,quote_ru:stringField,
  speaker:stringField,role:stringField
};
const recordRequired=Object.keys(recordFields);
const cardFields={
  index:{type:"integer"},title_ru:stringField,
  records:{type:"array",items:{type:"object",properties:recordFields,required:recordRequired}}
};
export function benchmarkSchema(variant,count=2){
  if(variant==="A_json")return null;
  if(variant==="B_minimal")return {
    type:"object",properties:{cards:{type:"array",items:{
      type:"object",properties:cardFields,required:["index","title_ru","records"]
    }}},required:["cards"]
  };
  if(variant!=="C_extended")throw new Error("UNKNOWN_VARIANT");
  const kinds=["fact","quote","headline","expert","counterposition",
    "explanation","detail","editorial_stance","media_angle","limitation"];
  const richRecord={
    type:"object",
    properties:{
      kind:{type:"string",enum:kinds,description:"Вид проверяемого наблюдения"},
      statement_ru:{type:"string",description:"Точный смысл исходной публикации по-русски"},
      anchor_id:{type:"string",description:"ID исходного фрагмента P001, P002 или TITLE"},
      source_excerpt:{type:"string",description:"Дословная непрерывная выдержка исходного фрагмента"},
      original_quote:{type:"string",description:"Дословная цитата либо пустая строка"},
      quote_ru:{type:"string",description:"Русский перевод цитаты либо пустая строка"},
      speaker:{type:"string",description:"Говорящий либо пустая строка"},
      role:{type:"string",description:"Роль говорящего либо пустая строка"}
    },required:recordRequired,additionalProperties:false
  };
  return {
    type:"object",additionalProperties:false,
    properties:{cards:{
      type:"array",minItems:count,maxItems:count,
      items:{type:"object",additionalProperties:false,required:["index","title_ru","records"],
        properties:{
          index:{type:"integer",minimum:0,maximum:count-1},
          title_ru:{type:"string",description:"Русский заголовок этой публикации"},
          records:{type:"array",minItems:1,maxItems:45,items:richRecord}
        }}
    }},required:["cards"]
  };
}
const leadA=[
  "Муниципалитет Североград сообщил об увеличении расходов на общественный транспорт на 18 процентов по сравнению с предыдущим годом. Средства направят на обновление автобусного парка и закупку запасных частей.",
  "Начальник транспортного отдела Мария Лукина пояснила: «Из 40 машин двенадцать нуждаются в капитальном ремонте». По ее словам, первые шесть автобусов планируют вернуть на маршруты до декабря.",
  "Представитель общественного совета Андрей Соколов выступил с критикой решения. Он считает, что опубликованная смета не объясняет, почему расходы на ремонт одного автобуса выросли на четверть.",
  "В ответ финансовое управление сообщило о повышении стоимости комплектующих и о новой гарантии для пассажирских перевозок. Подробные расчеты власти обещают обнародовать после проверки контрактов."
];
const leadB=[
  "Газета сообщила о программе ремонта трех районных поликлиник в Центральном округе. На строительные работы выделено 24 миллиона условных рублей, завершить ремонт планируется в два этапа.",
  "Главный врач Ольга Дмитриева заявила, что приоритетом станет оборудование диагностических кабинетов. «Очереди сократятся, когда заработают оба новых аппарата», — сказала она.",
  "Общественная организация пациентов приветствовала обновление, но указала на временную нехватку специалистов. По ее расчетам, поставка оборудования не устранит ожидание приема без дополнительного набора врачей.",
  "Региональное управление здравоохранения пообещало опубликовать график перемещения пациентов между учреждениями. На первом этапе ремонтируют корпуса в двух районах, третий корпус откроют позже."
];
const longA=[
  "Финансовое управление Новомирска представило проект регионального бюджета на следующий год: собственные доходы прогнозируются в объеме 82 миллионов условных рублей, трансферты — 36 миллионов.",
  "Документ предусматривает 17 миллионов на ремонт мостов, 11 миллионов на водоснабжение и 8 миллионов на цифровизацию коммунальных услуг. Отдельной строкой записан резерв на непредвиденные расходы в 3 миллиона.",
  "Председатель бюджетной комиссии Павел Орлов объяснил рост транспортных расходов износом дорожных сооружений. Он привел данные обследования: из 26 мостов семь требуют дополнительных испытаний.",
  "Экономист Ирина Белова возразила, что расходы не обеспечены подтвержденными контрактами. По ее словам, проект предполагает увеличение неналоговых доходов на 14 процентов без опубликованной методики расчета.",
  "В пояснительной записке власти признают риск удорожания строительных материалов и сохраняют возможность переноса двух проектов на следующий период. Приоритетом объявлен ремонт наиболее аварийных участков.",
  "Муниципальная газета цитирует представителей предпринимателей, которые предлагают раньше начать обновление водопровода на промышленной территории. Их аргумент — частые остановки производства во время аварий.",
  "Ведомство в отдельном ответе подчеркивает, что повышение тарифов не включено в базовый вариант бюджета. Альтернативный сценарий предусматривает снижение капитальных расходов на 9 процентов.",
  "Обсуждение проекта продлится до 28 октября. Городской совет намерен провести три публичных заседания; итоговую таблицу замечаний опубликуют на официальном портале."
];
const longB=[
  "Областной научный центр выпустил отчет о состоянии водных ресурсов в пяти районах. Авторы использовали данные 47 контрольных точек, собранные в течение восьми месяцев.",
  "Отчет указывает, что концентрация железа выросла в 11 пробах, тогда как показатели по большинству других контрольных точек остались в пределах прежнего диапазона.",
  "Руководитель исследования Сергей Петров отметил: «Данные показывают локальный характер изменений, а не ухудшение по всей области». Он призвал не делать выводов по одному месяцу измерений.",
  "Представитель экологической группы Анна Васина не согласилась с темпами реакции органов власти. По ее словам, два поселка должны получить временные фильтры до конца года.",
  "Областная администрация объявила конкурс на модернизацию трех очистных сооружений. Максимальная цена контракта установлена в 19 миллионов условных рублей.",
  "Исследователи уточняют, что сезонные колебания уровня воды влияют на сравнимость результатов. Для проверки тренда они рекомендуют продолжить измерения минимум еще шесть месяцев.",
  "Редакция отдельно напоминает о предыдущей модернизации в соседнем районе, завершенной с опозданием на четыре месяца. Власти называют причиной задержки повторную экспертизу оборудования.",
  "Представители жителей просят опубликовать первичные таблицы по всем контрольным точкам. Авторы исследования заявили, что обезличенные данные будут размещены в открытом доступе."
];
const article=(id,source,title,paragraphs)=>({
  publication_id:id,index:0,source,title,region:"Тестовый регион",text:paragraphs.join("\n\n")
});
export function fixtureSets(){
  const short=makeEvidenceDocuments([
    {...article("fixture-short-1","Тестовая редакция «Город»","Ремонт автобусов и бюджет",leadA),index:0},
    {...article("fixture-short-2","Тестовая редакция «Район»","Ремонт поликлиник",leadB),index:1}
  ]);
  const long=makeEvidenceDocuments([
    {...article("fixture-long-1","Тестовая редакция «Экономика»","Бюджет Новомирска",longA),index:0},
    {...article("fixture-long-2","Тестовая редакция «Экология»","Отчет о водных ресурсах",longB),index:1}
  ]);
  return [{name:"balanced_pair",docs:short},{name:"long_pair",docs:long}];
}
export function requestBody(variant,docs){
  const instructions=evidenceV2Instructions+
    "\n\nВерни ровно "+docs.length+" карточки; index начиная с нуля.\n\n"+
    renderEvidenceMaterials(docs);
  const generationConfig={
    responseMimeType:"application/json",
    maxOutputTokens:16000,thinkingConfig:{thinkingLevel:"low"}
  };
  const schema=benchmarkSchema(variant,docs.length);
  if(schema)generationConfig.responseJsonSchema=schema;
  return {contents:[{role:"user",parts:[{text:instructions}]}],generationConfig};
}
function analyzeResponse(response,docs){
  const body=response.body;
  const parts=body?.candidates?.[0]?.content?.parts||[];
  const content=parts.filter(p=>p?.thought!==true).map(p=>String(p?.text||"")).join("");
  const decoded=parseEvidenceJson(content,docs.length);
  const checked=verifyEvidenceCardsIndividually(decoded.payload,docs);
  const accepted=checked.accepted;
  const acceptedRecords=accepted.reduce((n,e)=>n+e.card.validation.accepted,0);
  const rejectedRecords=accepted.reduce((n,e)=>n+e.card.validation.rejected,0);
  const totalPassages=docs.reduce((n,d)=>n+d.passages.length,0);
  const coveredPassages=accepted.reduce((n,e)=>n+e.card.validation.covered_passages,0);
  return {
    finish_reason:String(body?.candidates?.[0]?.finishReason||"").slice(0,32),
    completion_tokens:Number(body?.usageMetadata?.candidatesTokenCount||0),
    prompt_tokens:Number(body?.usageMetadata?.promptTokenCount||0),
    parsed_by:decoded.method,recovered_cards:decoded.recovered_cards,
    accepted_cards:accepted.length,accepted_records:acceptedRecords,
    rejected_records:rejectedRecords,covered_passages:coveredPassages,
    total_passages:totalPassages,
    weak_cards:accepted.filter(e=>evidenceQualityWarnings(e.card,docs[e.index]).length>0).length,
    failed_card_reasons:checked.failed.map(e=>String(e.reason).slice(0,70)),
    response_characters:content.length
  };
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function resultSummary(rows){
  return VARIANTS.map(variant=>{
    const list=rows.filter(x=>x.variant===variant);
    const sum=field=>list.reduce((acc,x)=>acc+Number(x[field]||0),0);
    const successes=list.filter(x=>x.http_status===200);
    return {
      variant,runs:list.length,http_200:successes.length,
      http_400:list.filter(x=>x.http_status===400).length,
      other_http:list.filter(x=>x.http_status!==200&&x.http_status!==400).length,
      accepted_cards:sum("accepted_cards"),accepted_records:sum("accepted_records"),
      covered_passages:sum("covered_passages"),weak_cards:sum("weak_cards"),
      mean_elapsed_ms:list.length?Math.round(sum("elapsed_ms")/list.length):0,
      mean_http200_elapsed_ms:successes.length?Math.round(successes.reduce((n,x)=>n+x.elapsed_ms,0)/successes.length):0
    };
  });
}
function markdownReport(rows,summary){
  const md=[
    "# W-Review / Gemini 3.5 Evidence — A/B/C experiment",
    "",
    "Synthetic fixtures only; no operator data, no changes to production routing.",
    "Each candidate used the exact same prompt and source texts. One API call per cell, no automatic retry.",
    "",
    "| Variant | Calls | HTTP 200 | HTTP 400 | Accepted cards | Verified records | Covered passages | Mean latency (ms) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|"
  ];
  summary.forEach(x=>md.push("| "+[x.variant,x.runs,x.http_200,x.http_400,x.accepted_cards,x.accepted_records,x.covered_passages,x.mean_elapsed_ms].join(" | ")+" |"));
  md.push("","## Per-case diagnostic", "",
    "| Fixture | Repeat | Variant | HTTP | Finish | Cards | Records | Coverage | JSON recovery | Milliseconds |",
    "|---|---:|---|---:|---|---:|---:|---:|---|---:|");
  rows.forEach(x=>md.push("| "+[x.fixture,x.repeat,x.variant,x.http_status,x.finish_reason||"-",
    x.accepted_cards||0,x.accepted_records||0,(x.covered_passages||0)+"/"+(x.total_passages||0),
    x.parsed_by||"-",x.elapsed_ms].join(" | ")+" |"));
  md.push("","Results are diagnostic, not proof that a schema improves semantic quality. All recovered content was checked against source passages.");
  return md.join("\n")+"\n";
}
export async function runExperiment({key,repeats=2,output="out/gemini-schema-abc",delayMs=12500,fetchImpl=fetch}){
  if(!key)throw new Error("GEMINI_API_KEY_IS_REQUIRED_FOR_REAL_API_TEST");
  if(!Number.isInteger(repeats)||repeats<1||repeats>2)throw new Error("REPEATS_MUST_BE_1_OR_2");
  const rows=[];const sets=fixtureSets();
  for(let repeat=0;repeat<repeats;repeat++){
    for(let fi=0;fi<sets.length;fi++){
      const fixture=sets[fi];
      const offset=(repeat+fi)%3;
      const order=VARIANTS.map((_,index)=>VARIANTS[(index+offset)%3]);
      for(const variant of order){
        if(rows.length)await sleep(delayMs);
        const request=requestBody(variant,fixture.docs);
        const controller=new AbortController();
        const timeout=setTimeout(()=>controller.abort(),100000);
        const started=Date.now();
        let row={fixture:fixture.name,repeat:repeat+1,variant,
          model:MODEL,http_status:0,elapsed_ms:0,total_passages:
          fixture.docs.reduce((n,d)=>n+d.passages.length,0)};
        try{
          const response=await fetchImpl("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(MODEL)+":generateContent",{
            method:"POST",
            headers:{"x-goog-api-key":key,"content-type":"application/json"},
            body:JSON.stringify(request),signal:controller.signal
          });
          row.http_status=response.status;
          const payload=await response.json();
          if(response.ok){
            row={...row,...analyzeResponse({body:payload},fixture.docs)};
          }else{
            row.error_status=String(payload?.error?.status||"").slice(0,55);
            row.error_category=response.status===400?"invalid_schema_or_argument":
              response.status===429?"quota":response.status===503?"overloaded":"provider_error";
          }
        }catch(e){
          row.error_category=e?.name==="AbortError"?"request_timeout":"transport_error";
        }finally{
          clearTimeout(timeout);
          row.elapsed_ms=Date.now()-started;
        }
        rows.push(row);
        console.log(JSON.stringify(row)); // metrics only; never prompt, credentials or response text
      }
    }
  }
  const summary=resultSummary(rows);
  const result={model:MODEL,generated_at:new Date().toISOString(),synthetic_only:true,
    repeats,variants:VARIANTS,requests:rows.length,summary,rows};
  mkdirSync(output,{recursive:true});
  writeFileSync(output+"/metrics.json",JSON.stringify(result,null,2)+"\n");
  writeFileSync(output+"/report.md",markdownReport(rows,summary));
  if(process.env.GITHUB_STEP_SUMMARY){
    const {appendFileSync}=await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,markdownReport(rows,summary));
  }
  console.log("Completed "+rows.length+" A/B/C requests; reports written to "+output);
  return result;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  runExperiment({key:process.env.GEMINI_API_KEY||process.env.GOOGLE_GEMINI_API_KEY||process.env.GOOGLE_API_KEY,
    repeats:Number(process.env.EXPERIMENT_REPEATS||2)}).catch(e=>{
    console.error("BENCHMARK_FAILED: "+String(e?.message||e).slice(0,140));
    process.exitCode=1;
  });
}
