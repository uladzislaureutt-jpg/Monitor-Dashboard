import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { makeEventReport } from "../../src/eventReport.ts";

const original = "https://tvn24.pl/polska/karol-nawrocki-prezent-dla-donalda-trumpa-tron-z-bursztynu-przekazany-w-tajemnicy-st9344391";
const followup = "https://tvn24.pl/polska/bursztynowy-a-skromny-tron-dla-donalda-trumpa-politycy-komentuja-st9344747";
const copy = "https://hromadske.ua/en/world/274598-polands-president-secretly-gifted-trump-an-amber-decorated-throne-media-report";
const part = (fields) => ({ excerpt:"", updated:null, outsideWindow:false, access:"readable", originKind:"media", citations:[], ...fields });
const entries = [
  part({id:"S01", url:original, publisher:"TVN24+", country:"PL", title:"Tron z bursztynu dla Trumpa. Od Nawrockiego, w tajemnicy",
    published:"2026-11-18T07:47:00Z", access:"lead", publicationEvidence:"Метаданные статьи"}),
  part({id:"S02", url:followup, publisher:"TVN24", country:"PL", title:"Politycy komentują prezent Karola Nawrockiego",
    published:"2026-11-18T10:30:00Z", citations:[{sourceId:"S01",evidence:"Телеканал указал на материал своего репортёра."}]}),
  part({id:"S03", url:copy, publisher:"hromadske", country:"UA", title:"Polish president gave Trump secret amber throne, TVN24 reports",
    published:"2026-11-18T15:08:00Z", citations:[{sourceId:"S01",evidence:"Издание непосредственно ссылается на TVN24."}]}),
];
const report = makeEventReport({
  id:"sample-amber", task:"Освещение истории с янтарным креслом для Дональда Трампа",
  status:"complete", stage:"done", options:{from:"2026-11-18",through:"2026-11-19"},
  created_at:"2026-11-19T09:00:00Z",
  result:{entries, earliestId:"S01", citedSourceIds:["S01"], checked:3, search:{tavily:0,brightData:0}, warnings:[],
    checkedAt:"2026-11-19T09:20:00Z",
    summary:"TVN24+ сообщил о подарке Кароля Навроцкого. Украинское издание hromadske пересказало эту публикацию со ссылкой на оригинал.",
    summarySources:["S01","S03"], observations:[
      {sourceId:"S03", kind:"detail", excerpt:"Poland's president secretly gifted Trump an amber-decorated throne, media report"},
    ]},
}, "ru");
assert.equal(report.sections.length, 7);
assert.deepEqual(report.sections[2].table.headers, ["Время","Страна и издание","Роль","Что добавилось","Откуда сведения"]);
assert.equal(report.sections[2].table.rows[2][4][0].url, original);
assert.match(report.sections[2].table.rows[0][0][0].text, /10:47/);
assert.ok(report.sections[3].paragraphs.some(items => items[0].text.includes("Украина")));
assert.equal(report.sections.at(-1).table.rows[2][1][0].url, copy);
writeFileSync(process.argv[2] || "amber-event-report.json", JSON.stringify(report), "utf8");
