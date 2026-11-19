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

Deno.test("follows an editorial Source label and isolates the exact public Telegram post", async () => {
  const { trace } = await import("./trace.ts");
  const { readTelegramPost } = await import("./core.ts");
  const newsroom = "https://www.braslav-star.by/2026/11/13/item/";
  const telegram = "https://t.me/vitebsk_gai/26470";
  const page = readPage(`<main><article><h1>ДТП в Браславе</h1>
    <meta property="article:published_time" content="2026-11-13T12:56:00+03:00"/>
    <p>Сообщение о дорожно-транспортном происшествии.</p><p>Источник: <a href="${telegram}">Витебск ГАИ</a></p>
    </article></main>`, newsroom, { url: newsroom });
  const post = readTelegramPost(`<div data-post="vitebsk_gai/26469"><div class="tgme_widget_message_text">Другая публикация.</div></div>
    <div data-post="vitebsk_gai/26470"><div class="tgme_widget_message_text">ДТП в Браславе. Полиция проводит проверку обстоятельств происшествия.</div>
    <time datetime="2026-11-13T09:46:35Z"></time></div>`, telegram, { url: telegram });
  if (!post) throw new Error("The exact post was skipped");
  expect(post.excerpt.includes("Другая публикация"), false);
  expect(post.published, "2026-11-13T09:46:35.000Z");
  expect(urlKey(telegram), urlKey("https://t.me/s/vitebsk_gai/26470?embed=1"));
  const opened: string[] = [];
  const result = await trace({ task: "ДТП в Браславе", window: { from: "2026-11-13", through: "2026-11-13" }, locale: "ru" },
    async () => {}, {
      tavily: async () => [{ url: newsroom }],
      openArticle: async (candidate) => { opened.push(candidate.url); return candidate.url === newsroom ? page : post; },
      cloudflareConfigured: () => false,
      eventModel: async () => null,
      brightSearch: async () => { throw new Error("A supported origin should stop paid search"); },
    });
  expect(opened, [newsroom, telegram]);
  expect(result.earliestId, result.entries.find((entry) => entry.url === telegram)?.id);
  expect(result.entries.find((entry) => entry.url === newsroom)?.citations.map((edge) => edge.sourceId), [result.earliestId]);
});

Deno.test("uses the article byline and rejects home redirects instead of dating them", () => {
  const url = "https://vitbichi.by/news/episode/";
  const page = readPage('<header><p>Опубликовано 19 ноября 2026</p></header><main><article><h1>ДТП</h1><p>Пятница, 13.11.2026 14:40 | Рубрика: Происшествия</p><p>Текст статьи.</p></article></main>', url, { url });
  expect(page.published, "2026-11-13T11:40:00.000Z");
  expect(page.publicationEvidence, "Подпись в статье");
  const home = readPage("<h1>Главная</h1><p>Опубликовано 19 ноября 2026</p>", "https://vitbichi.by/", { url });
  expect([home.url, home.issue, home.published, home.access], [url, "redirect_home", null, "metadata"]);
});

Deno.test("a model observation must be an exact extract from a readable card", async () => {
  const { validateObservations } = await import("./trace.ts");
  const url = "https://tvn24.pl/story";
  const excerpt = "Редакция сообщает о подарке и ссылается на собеседника в администрации.";
  const entry = { ...readPage("<main><h1>Сообщение</h1><p>" + excerpt + "</p></main>", url, { url }),
    id: "S01", outsideWindow: false, citations: [], excerpt, access: "readable" as const };
  expect(validateObservations([
    { source_id: "S99", excerpt, kind: "detail" },
    { source_id: "S01", excerpt, kind: "disputed" },
    { source_id: "S01", excerpt: "Абсолютно новая и выдуманная подробность, которой публикация не содержит.", kind: "statement" },
    { source_id: "S01", excerpt, kind: "statement" },
  ], [entry]), [{ sourceId: "S01", excerpt, kind: "statement" }]);
});

Deno.test("date overlap does not admit an unrelated search result", async () => {
  const { matchesEvent } = await import("./trace.ts");
  const task = "Найди первые сообщения МЧС и белорусских СМИ о последствиях шквала 14 июля 2024 года в Гомельской области.";
  expect(matchesEvent("В Кыргызстане из-за дождя затопило рынок", "14 июля. По данным МЧС.", task, []), false);
  expect(matchesEvent("В Гомеле повалены сотни деревьев", "Последствия шквала устраняют коммунальные службы.", task, []), true);
  expect(matchesEvent("Polish president gave Trump a secret amber throne", "",
    "Освещение истории с янтарным креслом для Дональда Трампа", ["Nawrocki gives Trump an amber throne"]), true);
});

Deno.test("a direct attribution can restore a previously checked candidate without a second download", async () => {
  const { trace } = await import("./trace.ts");
  const original = "https://gov.pl/briefing";
  const copy = "https://news.pl/gift";
  const entries = new Map([
    [original, readPage('<article><h1>Briefing</h1><time itemprop="datePublished" datetime="2026-11-18T08:00:00Z"></time><p>Original source.</p></article>', original, { url: original })],
    [copy, readPage(`<article><h1>Amber throne for Trump</h1><p>According to <a href="${original}">the official briefing</a>, the gift was presented in June.</p></article>`, copy, { url: copy })],
  ]);
  const checked: string[] = [];
  const result = await trace({ task: "Amber throne for Trump", window: { from: null, through: null }, locale: "ru" },
    async () => {}, {
      tavily: async () => [{ url: original }, { url: copy }],
      openArticle: async (candidate) => { checked.push(candidate.url); return entries.get(candidate.url)!; },
      cloudflareConfigured: () => false,
      eventModel: async () => null,
      brightSearch: async () => ({ hits: [], failures: 0 }),
    });
  expect(checked, [original, copy]);
  expect(result.entries.find((entry) => entry.url === copy)?.citations.map((edge) => edge.sourceId), [result.earliestId]);
});
