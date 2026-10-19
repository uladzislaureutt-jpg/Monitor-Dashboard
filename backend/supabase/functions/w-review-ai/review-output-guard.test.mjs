import test from "node:test";
import assert from "node:assert/strict";
import {normalizeReviewSourceLabels,poolSourceNames,inspectReviewAttribution,minimumParagraphChars,inspectStyleOnlyCopy}
 from "./review-output-guard.ts";
const cards=[
  "ID: P01\nИСТОЧНИК: «The Guardian»\nЗАГОЛОВОК: Материал",
  "ID: P02\nИСТОЧНИК: «CNN»\nЗАГОЛОВОК: Материал",
  "ID: P03\nИСТОЧНИК: «cfr.org/»\nЗАГОЛОВОК: Материал"
];
test("Pxx is internal and replaced by exact real outlet identity, in prose and source list",()=>{
  assert.equal(poolSourceNames(cards).get("P03"),"cfr.org");
  const x=normalizeReviewSourceLabels(
    "Указывает «P01»; подробнее P03 («P01», «P02», «P03»).",cards);
  assert.equal(x.text,'Указывает «The Guardian»; подробнее «cfr.org» («The Guardian», «CNN», «cfr.org»).');
  assert.equal(x.substitutions,5);
  assert.deepEqual(x.unresolved,[]);
});
test("invalid evidence reference does not turn into an outlet or a fabricated citation",()=>{
  const x=normalizeReviewSourceLabels("Доказательство P01:E03 и источник «P08».",cards);
  assert.equal(x.text,"Доказательство P01:E03 и источник «P08».");
  assert.ok(x.unresolved.includes("P01:E03"));
  assert.ok(x.unresolved.includes("P08"));
});
test("country-group warnings apply to any supported catalog region, not hardcoded publishers",()=>{
  const withOrigins=[
    "ID: P01\nИСТОЧНИК: «The Guardian»\nКАТАЛОЖНЫЙ_РЕГИОН: Великобритания",
    "ID: P02\nИСТОЧНИК: «Gazeta Wyborcza»\nКАТАЛОЖНЫЙ_РЕГИОН: Польша",
    "ID: P03\nИСТОЧНИК: «CFR»\nКАТАЛОЖНЫЙ_РЕГИОН: США"
  ];
  const bad="Российские медиа, включая «The Guardian» и CFR, приводят оценки.\n\n"+
    "Немецкие издания, включая «Gazeta Wyborcza», обсуждают ситуацию.";
  const warnings=inspectReviewAttribution(bad,withOrigins);
  assert.equal(warnings.length,3);
  assert.ok(warnings.some(w=>w.includes("The Guardian")&&w.includes("Великобритания")));
  assert.ok(warnings.some(w=>w.includes("CFR")&&w.includes("США")));
  assert.ok(warnings.some(w=>w.includes("Gazeta Wyborcza")&&w.includes("Польша")));
  assert.equal(inspectReviewAttribution("Британские СМИ, включая «The Guardian», опубликовали анализ.",withOrigins).length,0);
});
test("unknown origin never becomes a fabricated country attribution",()=>{
  const unknown=["ID: P01\nИСТОЧНИК: «Неизвестное медиа»\nКАТАЛОЖНЫЙ_РЕГИОН: не указан"];
  assert.deepEqual(inspectReviewAttribution("Российские СМИ, включая «Неизвестное медиа», пишут о переговорах.",unknown),[]);
});
test("paragraph floor targets 95% length in one pass, without padding",()=>{
  for(const [target,count] of [[8000,16],[6000,13],[4000,8]]){
    const minimum=minimumParagraphChars(target,count);
    assert.ok(count*minimum+2*(count-1)>=Math.round(target*.95));
    assert.ok(minimum>80);
  }
});

test("warning detects actual long passage copied from STYLE_ONLY, without rewriting draft",()=>{
 const excerpt="Дальнейшее развитие темы будет зависеть от появления проверяемых данных о затратах и результатах, а также от возможности сопоставить первоначальные обещания с ходом работ.";
 const review="Материалы опираются на разные оценки исполнения бюджета.\n\n"+
   "Дальнейшее развитие темы будет зависеть от появления проверяемых данных о затратах и результатах, а также от возможности сопоставить первоначальные обещания с реальным ходом работ.";
 const warnings=inspectStyleOnlyCopy(review,[{text:excerpt}]);
 assert.equal(warnings.length,1);
 assert.match(warnings[0],/Абзац 2/);
 assert.ok(!warnings[0].includes("Дальнейшее развитие темы"));
 assert.ok(review.includes("с реальным ходом работ"));
});
test("short generic phrases or thematic paraphrases do not trigger STYLE_ONLY copying",()=>{
 const examples=[{text:"Одни редакции выделяют недостаток информации, другие обращают внимание на открытость процедур. В этом состоит различие между описанием процесса и оценкой фактического результата."}];
 assert.deepEqual(inspectStyleOnlyCopy("Редакции по-разному оценивают прозрачность процедур и результаты общественного контроля.",examples),[]);
 assert.deepEqual(inspectStyleOnlyCopy("В этом состоит различие между описанием процесса.",examples),[]);
 assert.deepEqual(inspectStyleOnlyCopy("Синтетический фрагмент тестовой статьи.",[]),[]);
});
