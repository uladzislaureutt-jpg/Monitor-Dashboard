import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { metadataPage, plain, publicAddress, publicArticleUrl, readPage, type Candidate, type Page, type Window } from "./core.ts";

const tavilyEndpoint = "https://api.tavily.com/search";
const brightEndpoint = "https://mcp.brightdata.com/mcp";
const cfModel = "@cf/openai/gpt-oss-120b";

function deadlineSignal(deadline: number, maxMillis: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, Math.min(maxMillis, deadline - Date.now())));
}

export async function tavily(query: string, window: Window, deadline: number): Promise<Candidate[]> {
  const key = Deno.env.get("TAVILY_API_KEY") || Deno.env.get("EVENT_TAVILY_API_KEY");
  if (!key) throw new Error("tavily_not_configured");
  const response = await fetch(tavilyEndpoint, {
    method: "POST", redirect: "error", signal: deadlineSignal(deadline, 8500),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query, max_results: 7, search_depth: "basic", auto_parameters: false,
      include_answer: false, include_raw_content: false,
      ...(window.from ? { start_date: window.from } : {}), ...(window.through ? { end_date: window.through } : {}),
    }),
  });
  if (!response.ok) throw new Error(`tavily_http_${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.results)) throw new Error("tavily_format");
  return payload.results.flatMap((row: Record<string, unknown>) => {
    const url = publicArticleUrl(row.url);
    return url ? [{ url, title: plain(row.title), excerpt: plain(row.content) }] : [];
  });
}

function readJson(raw: string): Record<string, unknown> | null {
  try { return JSON.parse(raw); } catch { return null; }
}

export function organicResults(raw: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(raw)) return !raw.length || raw[0]?.link || raw[0]?.url ? raw : null;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return organicResults(obj.organic ?? obj.organic_results ?? obj.results ?? obj.data);
  }
  if (typeof raw !== "string") return null;
  const json = readJson(raw);
  if (json) return organicResults(json);
  // The hosted service places untrusted search JSON between text markers.
  const source = raw.slice(0, 160_000);
  const open = source.indexOf("{");
  const close = source.lastIndexOf("}");
  return open >= 0 && close > open ? organicResults(readJson(source.slice(open, close + 1))) : null;
}

function rpcResult(raw: string): Record<string, unknown> | null {
  const result = readJson(raw);
  if (result) return result;
  for (const packet of raw.split(/\r?\n\r?\n/)) {
    const data = packet.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
    const obj = data.length && readJson(data.join("\n"));
    if (obj && ("result" in obj || "error" in obj)) return obj;
  }
  return null;
}

function nextDay(value: string): string {
  return new Date(Date.parse(value) + 86_400_000).toISOString().slice(0, 10);
}

export async function brightSearch(queries: string[], country: string | null, window: Window, deadline: number,
    onAttempt: () => void): Promise<{ hits: Candidate[]; failures: number }> {
  const key = Deno.env.get("BRIGHT_DATA_API_KEY") || Deno.env.get("EVENT_BRIGHT_DATA_API_KEY");
  if (!key) return { hits: [], failures: 0 };
  const endpoint = new URL(brightEndpoint);
  endpoint.searchParams.set("token", key);
  endpoint.searchParams.set("tools", "search_engine");
  const headers: Record<string, string> = { Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
  let requestId = 0;
  async function rpc(method: string, params: Record<string, unknown>, notification = false) {
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", headers, signal: deadlineSignal(deadline, 12_000),
      body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(notification ? {} : { id: ++requestId }) }),
    });
    if (!response.ok) throw new Error(`bright_http_${response.status}`);
    const sid = response.headers.get("mcp-session-id");
    if (sid) headers["Mcp-Session-Id"] = sid;
    if (notification) { await response.body?.cancel(); return null; }
    return rpcResult(await response.text());
  }
  const hits: Candidate[] = [];
  let failures = 0;
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "monitor-event", version: "1.0" } });
    const protocol = (init?.result as Record<string, unknown> | undefined)?.protocolVersion;
    if (typeof protocol !== "string") return { hits, failures: 1 };
    headers["Mcp-Protocol-Version"] = protocol;
    await rpc("notifications/initialized", {}, true);
    const dates = [window.from && `after:${window.from}`, window.through && `before:${nextDay(window.through)}`].filter(Boolean).join(" ");
    for (const query of queries.slice(0, 2)) {
      if (deadline - Date.now() < 3000) break;
      try {
        // Count a timed-out request as used and never replay it automatically.
        onAttempt();
        const answer = await rpc("tools/call", {
          name: "search_engine",
          arguments: { query: [query, dates].filter(Boolean).join(" "), engine: "google", ...(country ? { country } : {}) },
        });
        const result = answer?.result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined;
        const rows = result?.isError ? null : organicResults(result?.structuredContent) ??
          result?.content?.filter((part) => part.type === "text").map((part) => organicResults(part.text)).find(Array.isArray);
        if (!rows) {
          failures++;
          if (/quota|unauthori[sz]ed|payment|credit/i.test(JSON.stringify(result || answer).slice(0, 1500))) break;
          continue;
        }
        for (const row of rows.slice(0, 7)) {
          const url = publicArticleUrl(row.link || row.url);
          if (url) hits.push({ url, title: plain(row.title), excerpt: plain(row.description) });
        }
      } catch (error) {
        failures++;
        if (error instanceof Error && /bright_http_(401|402|403|429)$/.test(error.message)) break;
      }
    }
  } catch { failures++; }
  return { hits, failures };
}


async function resolvePublicAddress(host: string, signal: AbortSignal): Promise<string | null> {
  let rejectAbort: (() => void) | undefined;
  try {
    const addresses = await Promise.race([
      Promise.allSettled([Deno.resolveDns(host, "A"), Deno.resolveDns(host, "AAAA")]),
      new Promise<never>((_, reject) => {
        rejectAbort = () => reject(signal.reason);
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
      }),
    ]);
    const ips = addresses.flatMap((answer) => answer.status === "fulfilled" ? answer.value : []);
    return ips.length && ips.every(publicAddress) ? ips[0] : null;
  } catch { return null; }
  finally { if (rejectAbort) signal.removeEventListener("abort", rejectAbort); }
}

function loadHtmlPage(url: URL, address: string, signal: AbortSignal):
    Promise<{ status: number; headers: IncomingHttpHeaders; html: string }> {
  const isTls = url.protocol === "https:";
  return new Promise((resolve, reject) => {
    // Connect to the validated address itself. Keep the original TLS name and HTTP Host.
    const request = (isTls ? httpsRequest : httpRequest)({
      hostname: address, port: isTls ? 443 : 80, path: url.pathname + url.search,
      ...(isTls ? { servername: url.hostname } : {}),
      agent: false, signal,
      headers: { Host: url.host, Accept: "text/html,application/xhtml+xml",
        "Accept-Encoding": "identity", "User-Agent": "Monitor-Event/1.0" },
    }, (response) => {
      const status = response.statusCode || 0;
      const headers = response.headers;
      if (status < 200 || status >= 300 || !/html/i.test(headers["content-type"] || "")) {
        resolve({ status, headers, html: "" });
        response.destroy();
        return;
      }
      const decoder = new TextDecoder();
      const parts: string[] = [];
      let size = 0;
      const done = () => resolve({ status, headers, html: parts.join("") + decoder.decode() });
      response.on("data", (chunk: Uint8Array) => {
        parts.push(decoder.decode(chunk.subarray(0, 600_000 - size), { stream: true }));
        size += chunk.byteLength;
        if (size >= 600_000) { done(); response.destroy(); }
      });
      response.on("end", done);
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

export async function openArticle(candidate: Candidate, deadline: number): Promise<Page> {
  const signal = deadlineSignal(deadline, 5200);
  let url = publicArticleUrl(candidate.url);
  try {
    for (let hop = 0; hop < 4 && url && !signal.aborted; hop++) {
      const current = new URL(url);
      const address = await resolvePublicAddress(current.hostname, signal);
      if (!address) break;
      const reply = await loadHtmlPage(current, address, signal);
      if (reply.status >= 300 && reply.status < 400) {
        url = publicArticleUrl(reply.headers.location, url);
        continue;
      }
      if (reply.html) return readPage(reply.html, url, candidate);
      break;
    }
  } catch { /* The search candidate is still usable as metadata. */ }
  return metadataPage(candidate);
}

export function cloudflareConfigured(): boolean {
  return Boolean(Deno.env.get("EVENT_CLOUDFLARE_ACCOUNT_ID") && Deno.env.get("EVENT_CLOUDFLARE_API_TOKEN"));
}

export async function eventModel(system: string, input: unknown, deadline: number, maxMillis: number, maxTokens: number) {
  const account = Deno.env.get("EVENT_CLOUDFLARE_ACCOUNT_ID");
  const token = Deno.env.get("EVENT_CLOUDFLARE_API_TOKEN");
  if (!account || !token || !/^[0-9a-f]{32}$/i.test(account)) return null;
  // Separate account is a runtime guard as well as a separate secret.
  const reviewAccounts = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID_2", "CLOUDFLARE_SECONDARY_ACCOUNT_ID",
    "CLOUDFLARE_BACKUP_ACCOUNT_ID", "CLOUDFLARE_W_REVIEW_ACCOUNT_ID"].map((key) => Deno.env.get(key)?.toLowerCase());
  if (reviewAccounts.includes(account.toLowerCase())) return null;
  try {
    const reply = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${cfModel}`, {
      method: "POST", redirect: "error", signal: deadlineSignal(deadline, maxMillis),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(input) }],
        reasoning_effort: "low", temperature: 0.1, max_tokens: maxTokens, response_format: { type: "json_object" },
      }),
    });
    if (!reply.ok) { await reply.body?.cancel(); return null; }
    const data = (await reply.json()).result;
    const text = data?.response || data?.choices?.[0]?.message?.content || data?.output_text ||
      data?.output?.filter((item: { type?: string }) => item.type === "message")
        .flatMap((item: { content?: unknown[] }) => item.content || [])
        .filter((item: { type?: string }) => item.type === "output_text")
        .map((item: { text?: string }) => item.text).join("\n");
    return typeof text === "string" ? readJson(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/gi, "")) :
      text && typeof text === "object" ? text as Record<string, unknown> : null;
  } catch { return null; }
}
