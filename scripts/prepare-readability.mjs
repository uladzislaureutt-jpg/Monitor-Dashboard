import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const url = "https://unpkg.com/@mozilla/readability@0.6.0/Readability.js";
const out = resolve("src/generated/readability.js");
const typesOut = resolve("src/generated/readability.d.ts");

const response = await fetch(url, { redirect: "follow" });
if (!response.ok) {
  throw new Error(`Failed to download Mozilla Readability 0.6.0: HTTP ${response.status}`);
}
const source = await response.text();
if (!source.includes("function Readability") || !source.includes("Readability.prototype")) {
  throw new Error("Unexpected Readability.js payload");
}
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${source}\nexport { Readability };\n`, "utf8");
await writeFile(typesOut, `export type ReadabilityArticle = {
  title: string;
  byline: string | null;
  content: string;
  textContent: string;
  length: number;
  excerpt: string | null;
  siteName: string | null;
  publishedTime: string | null;
};

export class Readability {
  constructor(doc: Document, options?: { charThreshold?: number; maxElemsToParse?: number });
  parse(): ReadabilityArticle | null;
}
`, "utf8");
console.log(`Prepared Mozilla Readability 0.6.0 -> ${out}`);
