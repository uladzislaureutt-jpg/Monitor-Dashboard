import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const mustInclude = (path, text) => {
  if (!read(path).includes(text)) throw new Error(`${path}: expected ${JSON.stringify(text)}`);
};

mustInclude("backend/supabase/functions/editorial-compress/index.ts", "reduction_out_of_range");
mustInclude("backend/supabase/functions/editorial-compress/index.ts", "for (const retry of [false, true])");
mustInclude("backend/supabase/functions/editorial-compress/index.ts", "effective_mode: validation.effective");
mustInclude("src/editorialAi.ts", "AI_CLIENT_REJECTED_RANGE");
mustInclude("src/editorialAi.ts", "compressionReduction(input.text, compressedText)");
mustInclude("src/views/ReportView.tsx", "result.attempts");
console.log("editorial compression 0.6.3 static validation: OK");
