import { strToU8, unzipSync, zipSync } from "npm:fflate@0.8.2";
import {
  fallbackArtifactId, fallbackRunFromId, fallbackPath, isValidFallbackName,
  decodeFallbackZipBase64, validateFallbackZip, sha256Hex,
} from "./bundle-fallback.ts";

const key = "social_economic";
function makeBundle({ run = 223, dry = false, duplicate = false } = {}) {
  const p = {
    document_id: "doc_test",
    publication: { url: "https://example.org/news/test", title: "Проблемы с водоснабжением" },
  };
  const manifest = {
    dashboard_contract_version: "0.2",
    monitor: { key }, run: { run_number: run, dry_run: dry },
    files: {
      publications: "publications.jsonl", source_metrics: "source_metrics.jsonl",
      run_metrics: "run_metrics.json", full_texts: "full_texts.jsonl",
      entities: "entities.jsonl", full_text_integrity: "full_text_integrity.jsonl",
    },
  };
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "run_metrics.json": strToU8(JSON.stringify({
      monitor_key: key, run_number: run, final_publications: duplicate ? 2 : 1,
    })),
    "publications.jsonl": strToU8(JSON.stringify(p) + "\n" + (duplicate ? JSON.stringify(p) + "\n" : "")),
    "source_metrics.jsonl": strToU8(""),
    "full_texts.jsonl": strToU8(""),
    "entities.jsonl": strToU8(""),
    "full_text_integrity.jsonl": strToU8(""),
  };
  return zipSync(files, { level: 5 });
}

Deno.test("fallback IDs are positive, stable and compatible with native u64", () => {
  const id = fallbackArtifactId(223);
  if (id !== 1_000_000_000_223 || fallbackRunFromId(id) !== 223 ||
      fallbackRunFromId(15_175_001_614) !== null) {
    throw new Error("fallback ID collision or mismatch");
  }
  if (fallbackPath(key, "dashboard-bundle-social-", 223) !==
      "social_economic/dashboard-bundle-social-223.zip") throw new Error("invalid private path");
  if (isValidFallbackName("dashboard-bundle-social-223.zip", "dashboard-bundle-social-") !== 223 ||
      isValidFallbackName("not-a-bundle.zip", "dashboard-bundle-social-") !== null) {
    throw new Error("incorrect exact filename extraction");
  }
});

Deno.test("valid production ZIP verifies; upload base64 roundtrip is lossless", () => {
  const bytes = makeBundle();
  const value = btoa(String.fromCharCode(...bytes));
  const decoded = decodeFallbackZipBase64(value);
  if (decoded.length !== bytes.length || !decoded.every((v, i) => v === bytes[i])) {
    throw new Error("base64 roundtrip mismatch");
  }
  const manifest = validateFallbackZip(decoded, key);
  if (manifest.run !== 223 || manifest.publications !== 1) throw new Error("wrong bundle metadata");
});

Deno.test("dry runs and repeated publication IDs are rejected", () => {
  for (const bytes of [makeBundle({ dry: true }), makeBundle({ duplicate: true })]) {
    let rejected = false;
    try { validateFallbackZip(bytes, key); } catch { rejected = true; }
    if (!rejected) throw new Error("unsafe ZIP accepted");
  }
});

Deno.test("traversal paths and wrong monitor key are rejected", () => {
  const archive = makeBundle();
  let rejected = false;
  try { validateFallbackZip(archive, "lukashenko"); } catch { rejected = true; }
  if (!rejected) throw new Error("cross-monitor substitution allowed");
  const entries = unzipSync(makeBundle());
  entries["../secret.txt"] = strToU8("unexpected");
  const evil = zipSync(entries);
  rejected = false;
  try { validateFallbackZip(evil, key); } catch { rejected = true; }
  if (!rejected) throw new Error("traversal ZIP allowed");
});

Deno.test("SHA-256 is stable for the same bundle", async () => {
  const bytes = makeBundle();
  const a = await sha256Hex(bytes);
  const b = await sha256Hex(bytes);
  if (a !== b || !/^[a-f0-9]{64}$/.test(a)) throw new Error("unstable SHA-256");
});
