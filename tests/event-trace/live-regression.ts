import cases from "./ru-by-fixtures.json" with { type: "json" };
import search from "./ru-by-search-replay.json" with { type: "json" };
import { openArticle } from "../../backend/supabase/functions/event-trace/providers.ts";
import { plain, urlKey, type Candidate } from "../../backend/supabase/functions/event-trace/core.ts";
import { trace } from "../../backend/supabase/functions/event-trace/trace.ts";

const amber = {
  id: "amber-chair", task: "Освещение истории с янтарным креслом для Дональда Трампа",
  label: "Янтарный трон", window: { from: "2026-11-17", through: "2026-11-19" },
  pages: [
    { id: "amber-hromadske", url: "https://hromadske.ua/en/world/274598-polands-president-secretly-gifted-trump-an-amber-decorated-throne-media-report",
      role: "related_media", date: "2026-11-18", anchors: ["amber-decorated chair", "TVN24", "birthday"] },
    { id: "amber-tvn24", url: "https://tvn24.pl/polska/karol-nawrocki-prezent-dla-donalda-trumpa-tron-z-bursztynu-przekazany-w-tajemnicy-st9344391",
      role: "first_report", date: "2026-11-18", anchors: ["bursztyn", "Donald", "Nawrocki"] },
  ],
};
const byCase: Record<string, Candidate[]> = {
  ...search,
  // Known search hit from the Bright Data baseline. TVN24 is only a comparison target.
  "amber-chair": [{ url: amber.pages[0].url }],
};
const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/[\p{Pd}\u2212]/gu, "-");
const report: unknown[] = [];
for (const item of [...cases, amber]) {
  const sources = [];
  for (let offset = 0; offset < item.pages.length; offset += 3) {
    const batch = await Promise.all(item.pages.slice(offset, offset + 3).map(async (test) => {
      const page = await openArticle({ url: test.url }, Date.now() + 8000);
      const text = normalize(page.title + " " + page.excerpt);
      const hits = test.anchors.filter((anchor) => text.includes(normalize(anchor))).length;
      return { id: test.id, source: test.url, published: page.published, evidence: page.publicationEvidence ?? null,
        dateMatches: test.date ? page.published?.slice(0, 10) === test.date : null,
        issue: page.issue ?? null, access: page.access, extraction: page.extraction ?? null,
        anchorHits: hits, verified: page.access !== "metadata" && hits >= 2,
        targets: page.links.filter(({ kind }) => kind === "citation").map(({ url }) => url) };
    }));
    sources.push(...batch);
  }
  let replay: unknown = null;
  if (item.task && item.window && byCase[item.id]) {
    const opened: string[] = [];
    let calls = 0;
    const result = await trace({ task: item.task, window: item.window, locale: "ru" }, async () => {}, {
      tavily: async () => {
        const start = 7 * Math.min(calls++, 1);
        return byCase[item.id].slice(start, start + 7);
      },
      openArticle: async (candidate, deadline) => { opened.push(candidate.url); return await openArticle(candidate, deadline); },
      cloudflareConfigured: () => false,
      eventModel: async () => item.id === "amber-chair" ? { queries: ["Poland president Nawrocki Trump amber throne"] } : null,
      brightSearch: async () => ({ hits: [], failures: 0 }),
    });
    replay = { checked: result.checked, earliest: result.entries.find(({ id }) => id === result.earliestId)?.url ?? null,
      controls: item.pages.filter((test) => opened.some((url) => urlKey(url) === urlKey(test.url))).map(({ id }) => id),
      links: result.entries.flatMap((row) => row.citations.map((edge) => ({
        from: row.url, to: result.entries.find(({ id }) => id === edge.sourceId)?.url, evidence: plain(edge.evidence, 140),
      }))) };
  }
  const section = { id: item.id, sources, replay };
  console.log("EVENT_REGRESSION " + JSON.stringify(section));
  report.push(section);
}
await Deno.writeTextFile("event-regression.json", JSON.stringify(report, null, 2));
