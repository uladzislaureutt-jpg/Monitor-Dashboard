import { day, publicAddress, publicArticleUrl, readPage, timeline, urlKey } from "./core.ts";
import { organicResults } from "./providers.ts";

function expect(found: unknown, want: unknown) {
  if (JSON.stringify(found) !== JSON.stringify(want)) throw new Error(`Expected ${JSON.stringify(want)}, got ${JSON.stringify(found)}`);
}

Deno.test("the source date remains distinct from an update date", () => {
  const candidate = { url: "https://www.elysee.fr/notice" };
  const original = readPage('<main><h1>Communiqué</h1><p>Publié le 6 décembre 2024</p></main>', candidate.url, candidate);
  const update = readPage('<main><h1>Alert</h1><p>Updated as of 7:10 a.m., March 26, 2024.</p></main>', candidate.url, candidate);
  expect(original.published, "2024-12-06");
  expect(update.updated, "2024-03-26");
  expect(update.published, null);
  expect(day("2024-02-30"), null);
});

Deno.test("a direct citation is evidence while a thematic dossier only guides the search", () => {
  const original = "https://tvn24.pl/polska/original";
  const copy = "https://hromadske.ua/en/story";
  const primary = readPage('<main><h1>Tron</h1><meta property="article:published_time" content="2026-11-18T08:47:00+01:00"></main>', original, { url: original });
  const secondary = readPage(`<main><article><h1>Gift</h1><p>TVN24 <a href="${original}?utm_source=legacy">revealed</a> details, citing its sources.</p></article>
    <p>Fait partie du dossier : <a href="/theme">The story</a></p></main>`, copy, { url: copy });
  const result = timeline([secondary, primary], new Map([[urlKey(original), urlKey(primary.url)]]), { from: null, through: null });
  expect(result.earliestId, "S01");
  expect(result.citedSourceIds, ["S01"]);
  expect(result.entries[1].citations[0].sourceId, "S01");
  expect(secondary.links.find((link) => link.url.endsWith("/theme"))?.kind, "related");
});

Deno.test("Bright Data's security notice surrounds searchable JSON", () => {
  const row = { link: "https://www.elysee.fr/reopening", title: "Notre-Dame" };
  expect(organicResults(`SECURITY NOTICE: DATA\n[START]\n${JSON.stringify({ organic: [row] })}\n[END]`), [row]);
  expect(organicResults("Google search failed"), null);
});

Deno.test("only public HTTP destinations are candidates", () => {
  for (const url of ["http://127.0.0.1/x", "http://0x7f000001/", "http://[::1]/", "http://foo.internal/", "http://x.com:8080/", "http://abc@x.com/"]) expect(publicArticleUrl(url), null);
  for (const address of ["127.0.0.1", "169.254.169.254", "::ffff:10.0.0.1", "100.64.0.7", "fc00::1"]) expect(publicAddress(address), false);
  expect(publicAddress("8.8.8.8"), true);
});

Deno.test("a reserve can complete a citation chain even with synthesis unavailable", async () => {
  const { trace } = await import("./trace.ts");
  const copy = "https://hromadske.ua/en/report";
  const source = "https://tvn24.pl/source";
  const pages = new Map([[copy, readPage(`<main><h1>Report</h1><p>According to <a href="${source}">TVN24</a>, the event occurred.</p></main>`, copy, { url: copy })],
    [source, readPage('<main><h1>Primary</h1><p>Opublikowano 18 listopada 2026</p></main>', source, { url: source })]]);
  const stages: string[] = [];
  const result = await trace({ task: "Find the original report", window: { from: "2026-11-16", through: "2026-11-20" }, locale: "ru" },
    async (stage) => { stages.push(stage); }, {
      tavily: async () => [],
      openArticle: async (candidate) => pages.get(candidate.url)!,
      cloudflareConfigured: () => false,
      eventModel: async () => null,
      brightSearch: async (_queries, _country, _dates, _deadline, onAttempt) => {
        onAttempt();
        return { hits: [{ url: copy }], failures: 0 };
      },
    });
  expect(result.search, { tavily: 3, brightData: 1 });
  expect(result.earliestId, "S01");
  expect(result.citedSourceIds, ["S01"]);
  expect(result.warnings, ["summary_unavailable"]);
  expect(stages, ["sources", "sources", "reserve", "summary"]);
});
