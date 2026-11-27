import { strFromU8, unzipSync } from "npm:fflate@0.8.2";

export const FALLBACK_BUCKET = "monitor-dashboard-fallback";
export const FALLBACK_ID_BASE = 1_000_000_000_000;
export const FALLBACK_RUN_MAX = 1_000_000;
export const FALLBACK_MAX_BYTES = 8 * 1024 * 1024;

export function fallbackArtifactId(run: number): number {
  if (!Number.isSafeInteger(run) || run <= 0 || run >= FALLBACK_RUN_MAX) throw new Error("INVALID_FALLBACK_RUN");
  return FALLBACK_ID_BASE + run;
}
export function fallbackRunFromId(id: number): number | null {
  const run = id - FALLBACK_ID_BASE;
  return Number.isSafeInteger(id) && run > 0 && run < FALLBACK_RUN_MAX ? run : null;
}
export function fallbackPath(monitorKey: string, prefix: string, run: number) {
  fallbackArtifactId(run);
  return `${monitorKey}/${prefix}${run}.zip`;
}
export function isValidFallbackName(name: string, prefix: string): number | null {
  const m = name.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([0-9]+)\\.zip$`));
  if (!m) return null;
  const run = Number(m[1]);
  return Number.isSafeInteger(run) && run > 0 && run < FALLBACK_RUN_MAX ? run : null;
}

export function decodeFallbackZipBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value || value.length > Math.ceil(FALLBACK_MAX_BYTES * 4 / 3) + 8 ||
      value.length % 4 !== 0 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("INVALID_BUNDLE_BASE64");
  }
  let binary: string;
  try { binary = atob(value); } catch { throw new Error("INVALID_BUNDLE_BASE64"); }
  if (binary.length > FALLBACK_MAX_BYTES) throw new Error("BUNDLE_TOO_LARGE");
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function validateFallbackZip(bytes: Uint8Array, monitorKey: string): { run: number; publications: number } {
  if (bytes.length < 100 || bytes.length > FALLBACK_MAX_BYTES ||
      bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new Error("INVALID_BUNDLE_ZIP");
  }
  let archive: Record<string, Uint8Array>;
  let entries = 0;
  let uncompressed = 0;
  try {
    archive = unzipSync(bytes, { filter: (entry) => {
      entries++;
      uncompressed += Number(entry.originalSize ?? 0);
      if (entries > 20 || uncompressed > 64 * 1024 * 1024) {
        throw new Error("BUNDLE_UNCOMPRESSED_LIMIT");
      }
      return true;
    } });
  } catch { throw new Error("INVALID_BUNDLE_ZIP"); }
  const names = Object.keys(archive);
  const required = ["manifest.json", "publications.jsonl", "source_metrics.jsonl", "run_metrics.json"];
  if (names.length > 20 || required.some((n) => !archive[n]) ||
      names.some((n) => n.includes("..") || n.startsWith("/") || n.includes("\\")) ||
      names.reduce((sum, n) => sum + archive[n].byteLength, 0) > 64 * 1024 * 1024) {
    throw new Error("INVALID_BUNDLE_CONTENT");
  }
  let manifest: any;
  let metrics: any;
  try {
    manifest = JSON.parse(strFromU8(archive["manifest.json"]));
    metrics = JSON.parse(strFromU8(archive["run_metrics.json"]));
  } catch { throw new Error("INVALID_BUNDLE_MANIFEST"); }
  const run = Number(manifest?.run?.run_number);
  if (manifest?.dashboard_contract_version !== "0.2" ||
      manifest?.monitor?.key !== monitorKey ||
      manifest?.run?.dry_run !== false ||
      !Number.isSafeInteger(run) || run <= 0 || run >= FALLBACK_RUN_MAX ||
      Number(metrics?.run_number) !== run || metrics?.monitor_key !== monitorKey) {
    throw new Error("BUNDLE_IDENTITY_MISMATCH");
  }
  for (const name of required.slice(1)) {
    if (manifest?.files?.[name === "publications.jsonl" ? "publications" : name === "source_metrics.jsonl" ? "source_metrics" : "run_metrics"] !== name) {
      throw new Error("BUNDLE_FILE_MISMATCH");
    }
  }
  for (const [field, filename] of [
    ["full_texts", "full_texts.jsonl"], ["entities", "entities.jsonl"],
    ["full_text_integrity", "full_text_integrity.jsonl"],
  ]) {
    if (manifest?.files?.[field] !== filename || !archive[filename]) throw new Error("BUNDLE_FILE_MISMATCH");
  }
  let publications = 0;
  const seen = new Set<string>();
  try {
    for (const line of strFromU8(archive["publications.jsonl"]).split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (!row?.document_id || !row?.publication?.url || !row?.publication?.title || seen.has(row.document_id)) {
        throw new Error("INVALID_PUBLICATION");
      }
      seen.add(row.document_id);
      publications++;
    }
  } catch { throw new Error("INVALID_BUNDLE_PUBLICATIONS"); }
  if (publications !== Number(metrics?.final_publications)) throw new Error("BUNDLE_COUNT_MISMATCH");
  return { run, publications };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
