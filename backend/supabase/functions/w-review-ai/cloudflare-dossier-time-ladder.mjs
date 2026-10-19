// ONE real Cloudflare inference; six observed deadlines without six paid calls.
// Synthetic 18 publication / 167 Evidence fixture, production-shape dossier prompt.
import {mkdirSync,writeFileSync,appendFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {fixtureCards,evaluateDossier,extractCloudflareText} from "./trend-model-benchmark.mjs";
import {compactDossierCards,dossierOutputContract,DOSSIER_INSTRUCTIONS} from "./editorial-dossier.ts";
export const WAIT_SECONDS=[70,80,90,100,120,140];
export function buildProductionFixture(){
 const cards=fixtureCards(18),evidence=compactDossierCards(cards).join("\n\n");
 const task="Подготовь редакционное досье о том, как СМИ освещают проекты модернизации вымышленного Новограда, включая тенденции, редакционные оценки, разные аргументы и контрпозиции. Все статьи синтетические.";
 const user="ЗАДАНИЕ ОПЕРАТОРА:\n"+task+
   "\n\nДОКАЗАТЕЛЬНАЯ БАЗА (P01:E01 — E01 в статье P01):\n"+
   evidence+"\n\n"+dossierOutputContract(cards.length);
 const body={
   messages:[
     {role:"system",content:DOSSIER_INSTRUCTIONS+
       "\nОбязательное условие: JSON содержит trends, coverage по всем "+cards.length+
       " материалам и inventory. Каждый evidence_id должен встречаться в переданной базе."+
       "\nКОМПАКТНОСТЬ: краткие русские поля без повторов; используй все действительно значимые доказательства, а не фиксированное число 2–5 ссылок. Не подменяй аналитический вывод перечислением ID. Источники из разных СМИ независимы."+
       "\nАдреса Evidence КОПИРУЙ строго из списка выше, не придумывай и не округляй номера. Форма исключительно P01:E01; для любой Pxx должен существовать хотя бы один содержательный evidence_id в ветках."},
     {role:"user",content:user}
   ],
   temperature:0.1,reasoning_effort:"low",max_tokens:7500,
   response_format:{type:"json_object"}
 };
 return {cards,body,inputChars:JSON.stringify(body).length,evidenceChars:evidence.length,
   evidenceCount:cards.reduce((n,c)=>n+(c.match(/^E\d+\s+\[/gm)||[]).length,0)};
}
export function timeLadder(elapsedMs,strict,repaired){
 return WAIT_SECONDS.map(seconds=>({
   seconds,
   response_received:elapsedMs!==null&&elapsedMs<=seconds*1000,
   strict_valid:elapsedMs!==null&&elapsedMs<=seconds*1000&&Boolean(strict),
   reconciled_valid:elapsedMs!==null&&elapsedMs<=seconds*1000&&Boolean(repaired)
 }));
}
const safeError=e=>["TimeoutError","AbortError"].includes(String(e?.name))?"timeout":"network_or_transport";
function report(m){
 const yes=v=>v?"да":"нет";
 const lines=[
   "# Cloudflare GPT-OSS-120B dossier — 70/80/90/100/120/140 секунд",
   "",
   "ОДИН реальный запрос, синтетические 18 публикаций и 167 Evidence, рабочий промпт расчёта тенденций. Ожидание измеряется до получения полного тела ответа.",
   "",
   "| Лимит | Ответ получен | Строгий контракт | Исправленный контракт |",
   "|---:|---|---|---|"
 ];
 for(const x of m.ladder)lines.push("| "+[x.seconds+" c",yes(x.response_received),
   yes(x.strict_valid),yes(x.reconciled_valid)].join(" | ")+" |");
 lines.push("","Время: "+(m.elapsed_ms/1000).toFixed(2)+" сек.",
   "HTTP: "+m.http_status+"; ошибка: "+m.error_category,
   "Входных символов: "+m.input_chars+"; Evidence: "+m.evidence_count+
      "; компактная база: "+m.evidence_chars+" символов.",
   "Выход: "+m.output_chars+" символов; finish_reason: "+m.finish_reason,
   "Строгая проверка: "+yes(m.strict_valid)+"; после безопасной сверки: "+yes(m.repaired_valid),
   "Публикации с привязанными Evidence: "+m.linked_publications+"/18",
   "Использовано уникальных Evidence: "+(m.valid_references??0)+"/"+m.evidence_count+
     "; контраргументов: "+(m.contrary_evidence_distinct??0),
   "Экспертных записей процитировано: "+(m.expert_cited??0)+
     "; самостоятельных позиций редакций: "+(m.editorial_stance_cited??0),
   "Группировка тематических линий: "+(m.facets_grouped??0)+"/5"+
     "; известные противоречия сопоставлены: "+(m.gold_opposition_pairs_contrasted??0)+
     "/"+(m.gold_opposition_pairs_total??0),
   "Подозрительно похожие пары веток по тексту: "+(m.suspicious_duplicate_text_pairs??0)+
     "; по ID: "+(m.suspicious_duplicate_evidence_pairs??0),
   "Внимание: успешность на синтетической базе не гарантирует успешность на локальном пуле пользователя, который недоступен для GitHub.",
   "Тест вне Supabase: 140 секунд — только время одной модели, а не полный бюджет серверной функции.","");
 return lines.join("\n")+"\n";
}
export async function runTimeLadder({keys,fetchImpl=fetch,
  maxMs=140000,output="out/w-review-cloudflare-time-ladder",log=console.info}={}){
 const fixture=buildProductionFixture();
 if(maxMs>140000||maxMs<1)throw Error("INVALID_TIMEOUT");
 if(fixture.cards.length!==18||fixture.evidenceCount!==167)throw Error("UNEXPECTED_FIXTURE");
 const m={
   model:"@cf/openai/gpt-oss-120b",
   input_chars:fixture.inputChars,evidence_chars:fixture.evidenceChars,evidence_count:167,
   http_status:0,elapsed_ms:0,error_category:"not_started",
   strict_valid:false,repaired_valid:false,valid_references:0,invalid_references:0,
   linked_publications:0,output_chars:0,finish_reason:"unknown"
 };
 let outputText="",completedMs=null;
 if(!(keys?.cfAccount&&keys?.cfToken))m.error_category="missing_secrets";
 else{
   const start=Date.now(),controller=new AbortController();
   const timeout=setTimeout(()=>controller.abort(),maxMs);
   const checkpointTimers=WAIT_SECONDS.filter(s=>s*1000<maxMs).map(seconds=>
     setTimeout(()=>{if(m.error_category==="not_started")
       log("CHECKPOINT "+JSON.stringify({seconds,still_waiting:true}));},seconds*1000));
   try{
     const url="https://api.cloudflare.com/client/v4/accounts/"+
       encodeURIComponent(keys.cfAccount)+"/ai/run/@cf/openai/gpt-oss-120b";
     const r=await fetchImpl(url,{method:"POST",
       headers:{"Authorization":"Bearer "+keys.cfToken,"Content-Type":"application/json"},
       body:JSON.stringify(fixture.body),signal:controller.signal});
     m.http_status=r.status;
     const raw=await r.text();
     completedMs=Date.now()-start;
     if(!r.ok){
       m.error_category="provider_http_"+r.status;
       try{const code=Number(JSON.parse(raw)?.errors?.[0]?.code||0);
         m.provider_error_code=Number.isSafeInteger(code)?code:0;
       }catch{}
     }else{
       let data=null;try{data=JSON.parse(raw)}catch{}
       m.error_category=data?"none":"invalid_provider_json";
       outputText=extractCloudflareText(data);
       m.output_chars=outputText.length;
       const answer=data?.result||data||{};
       m.finish_reason=String(answer?.choices?.[0]?.finish_reason||
         answer?.finish_reason||"unknown").slice(0,30);
       m.input_tokens=Number(answer?.usage?.prompt_tokens||0);
       m.output_tokens=Number(answer?.usage?.completion_tokens||0);
       const checked=evaluateDossier(outputText,fixture.cards,"P18");
       Object.assign(m,checked);
     }
   }catch(e){m.error_category=safeError(e);}
   finally{
     clearTimeout(timeout);
     for(const timer of checkpointTimers)clearTimeout(timer);
     m.elapsed_ms=Date.now()-start;
   }
 }
 m.ladder=timeLadder(completedMs,m.http_status===200&&m.strict_valid,
   m.http_status===200&&m.repaired_valid);
 m.synthetic_only=true;m.request_count=keys?.cfAccount&&keys?.cfToken?1:0;
 m.observed_at=new Date().toISOString();
 mkdirSync(output,{recursive:true});
 const md=report(m);
 writeFileSync(output+"/metrics.json",JSON.stringify(m,null,2)+"\n");
 writeFileSync(output+"/report.md",md);
 if(outputText)writeFileSync(output+"/synthetic_dossier.txt",outputText+"\n");
 if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,md);
 log("FINAL "+JSON.stringify({
   http_status:m.http_status,elapsed_ms:m.elapsed_ms,
   error_category:m.error_category,strict_valid:m.strict_valid,
   repaired_valid:m.repaired_valid,linked_publications:m.linked_publications
 }));
 return m;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 runTimeLadder({keys:{
   cfAccount:process.env.CLOUDFLARE_ACCOUNT_ID||"",
   cfToken:process.env.CLOUDFLARE_API_TOKEN||""
 }}).catch(e=>{console.error("TEST_ERROR "+safeError(e));process.exitCode=1;});
}
