import test from "node:test";
import assert from "node:assert/strict";
import {resolvePoolMarkersForExport,canonicalWReviewSourceName} from "./wReviewSourceLabels.ts";
const items=[
  {source:"BBC News"},{source:"The Guardian"},{source:"cfr.org/"},{source:"Лента.ру"}
];
test("retrofits existing DOCX export without mutating the editor master copy",()=>{
  const original="Материал «P02» и «P03» («P01», P04).";
  const r=resolvePoolMarkersForExport(original,items);
  assert.equal(r.text,"Материал «The Guardian» и «CFR.org» («BBC News», «Лента.ру»).");
  assert.equal(r.replaced,4);
  assert.equal(original,"Материал «P02» и «P03» («P01», P04).");
});
test("unknown source IDs prevent silent publication of broken citations",()=>{
  const r=resolvePoolMarkersForExport("По версии «P18», факт P03:E02 не подтверждён.",items);
  assert.deepEqual(r.unresolved,["P18","P03:E02"]);
});
test("unrelated digits and regular quotations are preserved",()=>{
  const r=resolvePoolMarkersForExport("В 2026 году выросли цены, заявил «CNN».",items);
  assert.equal(r.text,"В 2026 году выросли цены, заявил «CNN».");
  assert.equal(r.replaced,0);
});

test("export canonicalizes already saved CFR variants, preserving link URLs",()=>{
 const original="Результат «cfr.org/» («Cfr.org», «P03»). https://www.cfr.org/articles/a/";
 const result=resolvePoolMarkersForExport(original,items);
 assert.equal(result.text,"Результат «CFR.org» («CFR.org», «CFR.org»). https://www.cfr.org/articles/a/");
 assert.equal(canonicalWReviewSourceName("cfr.org/"),"CFR.org");
 assert.equal(canonicalWReviewSourceName("CFR.org"),"CFR.org");
 assert.equal(canonicalWReviewSourceName("The Guardian"),"The Guardian");
 assert.equal(original,"Результат «cfr.org/» («Cfr.org», «P03»). https://www.cfr.org/articles/a/");
});
