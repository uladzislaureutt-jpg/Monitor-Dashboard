import { load } from "npm:cheerio@1.0.0-rc.12";
import { Readability } from "npm:@mozilla/readability@0.6.0";
import { parseHTML } from "npm:linkedom@0.18.12";
import cases from "./ru-by-fixtures.json" with { type: "json" };
import { plain, readPage, urlKey } from "../../backend/supabase/functions/event-trace/core.ts";
import { openArticle, tavily } from "../../backend/supabase/functions/event-trace/providers.ts";
import { trace } from "../../backend/supabase/functions/event-trace/trace.ts";

type Fixture = typeof cases[number]["pages"][number];

function normalize(text: string) {
  return text.normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/[\p{Pd}\u2212]/gu, "-").replace(/\s+/g, " ");
}

function matches(text: string, fixture: Fixture) {
  const normalized = normalize(text);
  return fixture.anchors.filter((anchor) => normalized.includes(normalize(anchor))).length;
}

function verify(text: string, fixture: Fixture) {
  return fixture.anchors.length > 0 && matches(text, fixture) >= 2;
}

async function loadHtml(url: string) {
  const started = performance.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "Monitor-Event/1.0" },
    });
    const html = (await res.text()).slice(0, 650_000);
    const $ = load(html);
    const title = plain($("title").first().text(), 180);
    const rootRedirect = new URL(url).pathname !== "/" && new URL(res.url).pathname === "/";
    const block = /(not available in your (?:country|region)|restricted in your (?:country|region)|not available from your location|недоступ[а-я]+ в вашем регион|geo.?block)/iu.test(
      title + " " + plain($("body").text(), 850));
    return { status: res.status, url: res.url, title, ms: Math.round(performance.now() - started), rootRedirect, geoMessage: block, html };
  } catch (error) {
    const cause = error instanceof Error ? String(error.cause || error.message) : "";
    const category = /timeout|timed out/i.test(cause) || error instanceof DOMException && error.name === "TimeoutError" ? "timeout"
      : /dns|lookup|name known|no such host/i.test(cause) ? "dns" : /tls|certificate/i.test(cause) ? "tls" : "network";
    return { status: null, url, error: category, ms: Math.round(performance.now() - started), html: "" };
  }
}

function readability(html: string, fixture: Fixture) {
  if (!html) return { chars: 0, verified: false, matches: 0 };
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document, { charThreshold: 140 }).parse();
    const body = plain(article?.textContent, 14_000);
    return { chars: body.length, verified: verify(body, fixture), matches: matches(body, fixture) };
  } catch { return { chars: 0, verified: false, matches: 0 }; }
}

async function telegram(fixture: Fixture) {
  const url = new URL(fixture.url);
  const id = url.pathname.slice(1);
  url.searchParams.set("embed", "1");
  const response = await loadHtml(url.href);
  const $ = load(response.html);
  const post = $("[data-post]").filter((_, el) => $(el).attr("data-post") === id).first();
  const body = plain(post.find(".tgme_widget_message_text").text(), 12_000);
  const time = post.find("time").first().attr("datetime") ?? null;
  return { status: response.status, exactPost: post.length === 1, time, chars: body.length, verified: verify(body, fixture) };
}

async function inspect(fixture: Fixture) {
  const [original, raw, tg] = await Promise.all([
    openArticle({ url: fixture.url }, Date.now() + 8000),
    loadHtml(fixture.url),
    fixture.role === "official_telegram" ? telegram(fixture) : Promise.resolve(null),
  ]);
  const { html, ...diagnostics } = raw;
  const sameHtml = raw.status === 200 && html ? readPage(html, raw.url, { url: fixture.url }) : null;
  const alternative = readability(raw.status === 200 ? html : "", fixture);
  return {
    id: fixture.id, role: fixture.role, seed: fixture.url, expectedDate: fixture.date,
    http: { ...diagnostics, chars: html.length },
    event: { url: original.url, title: original.title, access: original.access, published: original.published, updated: original.updated,
      links: original.links.filter((link) => link.kind === "citation").map(({ url }) => url),
      verified: original.access !== "metadata" && verify(original.title + " " + original.excerpt, fixture) },
    sameHtml: sameHtml ? { access: sameHtml.access, published: sameHtml.published, verified: verify(sameHtml.title + " " + sameHtml.excerpt, fixture) } : null,
    readability: alternative,
    telegram: tg,
  };
}

const key = Deno.env.get("TAVILY_API_KEY") || Deno.env.get("EVENT_TAVILY_API_KEY");
let freeTavily = false;
if (key) {
  try {
    const res = await fetch("https://api.tavily.com/usage", {
      headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(6000),
    });
    const data = res.ok ? await res.json() : null;
    const remaining = Number(data?.account?.plan_limit) - Number(data?.account?.plan_usage);
    freeTavily = /researcher|^free$/i.test(data?.account?.current_plan || "") && remaining >= 20;
  } catch { /* Skip search unless it can run within confirmed free credits. */ }
}
const report = { route: "GitHub ubuntu-latest", country: null as string | null,
  hasTavilyKey: Boolean(key), freeTavily, cases: [] as unknown[] };
try {
  const reply = await fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(5000) });
  report.country = (await reply.text()).match(/^loc=([A-Z]{2})$/m)?.[1] ?? null;
} catch { /* A failed geolocation probe does not change source-access evidence. */ }

for (const item of cases) {
  const sources = await Promise.all(item.pages.map(inspect));
  let discovery: unknown = null;
  if (item.task && item.window && report.freeTavily) {
    const stages: string[] = [];
    const searched: Array<{ query: string; hits: string[] }> = [];
    const result = await trace({ task: item.task, window: item.window, locale: "ru" }, async (stage) => { stages.push(stage); }, {
      tavily: async (query, window, deadline) => {
        const rows = await tavily(query, window, deadline);
        searched.push({ query, hits: rows.map(({ url }) => url) });
        return rows;
      },
      openArticle,
      // This run measures the primary route without spending reserve or model credits.
      brightSearch: async () => ({ hits: [], failures: 0 }),
      cloudflareConfigured: () => false,
      eventModel: async () => null,
    });
    discovery = { queries: searched, stages, counts: result.search, warnings: result.warnings,
      matchedControls: item.pages.filter((page) => result.entries.some((entry) => urlKey(entry.url) === urlKey(page.url))).map(({id}) => id),
      earliest: result.entries.find(({ id }) => id === result.earliestId)?.url ?? null };
  }
  const row = { id: item.id, label: item.label, window: item.window, sources, discovery };
  report.cases.push(row);
  console.log("EVENT_RU_BY_CASE", JSON.stringify(row));
}
await Deno.writeTextFile("event-ru-by.json", JSON.stringify(report, null, 2));
console.log("EVENT_RU_BY_ENV", JSON.stringify({ runnerCountry: report.country, tavilyConfigured: report.hasTavilyKey, freeTavily: report.freeTavily }));
