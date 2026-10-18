import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const index=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
const start=index.indexOf('if (action === "evidence_batch")');
const end=index.indexOf('if (action === "style_profile")',start);
const evidence=index.slice(start,end);
test("Gemini Evidence excludes model-thought parts when parsing final JSON",()=>{
  assert.ok(index.includes(".filter((part:any)=>part?.thought!==true)"));
  assert.ok(index.includes('const content = Array.isArray(parts)'));
});
