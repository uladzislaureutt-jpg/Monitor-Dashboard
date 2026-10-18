import test from "node:test";
import assert from "node:assert/strict";
import {normalizeReviewSourceLabels,poolSourceNames,inspectReviewAttribution,minimumParagraphChars}
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
test("detects category error: US CFR / British Guardian cannot be labelled Russian media",()=>{
  const bad="Российские медиа, включая аналитические статьи «The Guardian» и CFR, представляют Трампа...\n\n"+
    "В российских медиа обсуждают отдельную тему.";
  const warnings=inspectReviewAttribution(bad);
  assert.equal(warnings.filter(w=>w.includes("российских медиа")).length,1);
  assert.ok(warnings[0].includes("Абзац 1"));
  assert.equal(inspectReviewAttribution("Британская «The Guardian» и американский CFR пишут о санкциях.").length,0);
});
test("paragraph floor targets 95% length in one pass, without padding",()=>{
  for(const [target,count] of [[8000,16],[6000,13],[4000,8]]){
    const minimum=minimumParagraphChars(target,count);
    assert.ok(count*minimum+2*(count-1)>=Math.round(target*.95));
    assert.ok(minimum>80);
  }
});
