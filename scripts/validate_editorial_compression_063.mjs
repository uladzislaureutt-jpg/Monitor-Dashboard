import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const mustInclude = (path, text) => {
  if (!read(path).includes(text)) throw new Error(`${path}: expected ${JSON.stringify(text)}`);
};

mustInclude("src/editorialAi.ts", "AI_CLIENT_REJECTED_RANGE");
mustInclude("src/editorialAi.ts", "compressionReduction(input.text, compressedText)");
mustInclude("src/editorialAi.ts", "payload.retried === true ? 2 : 1");
mustInclude("src/editorialAi.ts", "fallback:");
mustInclude("src/views/ReportView.tsx", "result.attempts");
mustInclude("src/views/ReportView.tsx", "result.fallback");
console.log("editorial compression client corrective 0.6.3.1 static validation: OK");
