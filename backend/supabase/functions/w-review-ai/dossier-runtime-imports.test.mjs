import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {evidenceIndex,normalizeDossier} from "./editorial-dossier.ts";

const src=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
const cards=["ID: P01\nИСТОЧНИК: «Reuters»\nЗАГОЛОВОК: Статья\nE01 [fact/P001] Подтверждённый факт. | SOURCE: «Оригинал»",
"ID: P02\nИСТОЧНИК: «BBC»\nЗАГОЛОВОК: Анализ\nE01 [fact/P001] Вторая позиция. | SOURCE: «Фрагмент»"];
test("dossier invalid-evidence diagnostic imports its actual index helper",()=>{
  const imported=src.match(/import\s*\{([^}]+)\}\s*from\s*["']\.\/editorial-dossier\.ts["']/);
  assert.ok(imported,"must import editorial dossier module");
  assert.ok(imported[1].split(",").map(x=>x.trim()).includes("evidenceIndex"),
    "diagnostic references evidenceIndex and must import it");
  assert.ok(src.includes("const idx=evidenceIndex(cards);"));
});
test("Evidence index detects invalid cited record without throwing ReferenceError",()=>{
  const ix=evidenceIndex(cards);
  assert.ok(ix.byId.has("P01:E01"));
  assert.ok(ix.byId.has("P02:E01"));
  assert.equal(ix.byId.has("P02:E99"),false);
  assert.equal(["P01:E01","P02:E99"].filter(id=>!ix.byId.has(id)).length,1);
});
test("rejected dossier still reports validation error before optional diagnostics",()=>{
  const invalid={trends:[],coverage:[],inventory:{quotes:0,headlines:0,experts:0}};
  const outcome=normalizeDossier(invalid,cards,{requireEveryDistinctSource:true});
  assert.ok(outcome.error);
});
