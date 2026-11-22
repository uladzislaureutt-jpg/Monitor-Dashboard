import { day, metadataPage, publicAddress, publicArticleUrl, readPage, timeline, urlKey } from "./core.ts";
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
  expect(matchesEvent("Последствия ливня в Петербурге", "МЧС подсчитало упавшие деревья. Шторм ожидали и в Москве.",
    "Шквал и ливень в Москве 20 июня 2024 года", []), false);
  expect(matchesEvent("Последствия непогоды на Гомельщине", "Сводка от спасателей", task, []), true);
  expect(matchesEvent("Нутрициолог предупредила о вреде холодного кофе",
    "Надо учитывать состояние здоровья и не пить кофе слишком быстро. Другие новости: сильное землетрясение на Камчатке.",
    "Найди ранние сообщения о сильном землетрясении у Камчатки и предупреждении о возможном цунами", []), false);
  expect(matchesEvent("Polish president gave Trump a secret amber throne", "",
    "Освещение истории с янтарным креслом для Дональда Трампа", ["Nawrocki gives Trump an amber throne"]), true);
  expect(matchesEvent('Конференция «Комплаенс в России» - Мероприятия - Интерфакс', "Место проведения: Москва.",
    "Президент США в интервью Fox News сказал о небольших российских ракетах в Польше. Трамп.", []), false);
});

Deno.test("Newscatcher pagination respects the selected Minsk dates and verifies the original page", async () => {
  const { trace } = await import("./trace.ts");
  const { makeNewsSearch } = await import("./newscatcher.ts");
  const task = "Найди, кто первым связал слова Трампа о небольших ракетах в Польше с инцидентом 20 ноября 2026 года.";
  const terms = [["Трамп", "Трампа"], ["Польша", "Польше"], ["небольших ракет", "маленьких ракет"]];
  const window = { from: "2026-11-19", through: "2026-11-20" };
  const plan = makeNewsSearch(task, task, { terms, date: "2026-11-20" }, window);
  expect([plan?.from, plan?.through], ["2026-11-18T21:00:00.000Z", "2026-11-20T20:59:59.999Z"]);
  expect(plan?.query, '("Трамп" OR "Трампа") AND ("Польша" OR "Польше") AND ("небольших ракет" OR "маленьких ракет")');
  const original = "https://eadaily.com/ru/news/earlier";
  const blocked = "https://vk.ru/wall-123_4";
  const noArticle = "https://press.example.org/news/no-text";
  const hits = [original, blocked, noArticle].map(url => ({ url, title: "Трамп о небольших ракетах в Польше",
    excerpt: "По словам Трампа, небольшие ракеты упали в Польше.", publishedHint: "2026-11-20T12:00:00Z", countryHint: "RU" }));
  const requested: number[] = [];
  const opened: string[] = [];
  const result = await trace({ task, window, locale: "ru" }, async () => {}, {
    tavily: async () => [],
    brightSearch: async () => ({ hits: [], failures: 0 }),
    cloudflareConfigured: () => false,
    eventModel: async () => ({ country: "ru", news: { terms } }),
    newscatcherConfigured: () => true,
    newscatcherPage: async (_plan, number, _deadline, onAttempt) => {
      onAttempt();
      requested.push(number);
      return { hits: number === 1 ? hits.slice(1) : hits.slice(0, 1), more: number === 1, incomplete: number === 1 };
    },
    openArticle: async candidate => {
      expect(Object.keys(candidate), ["url"]);
      opened.push(candidate.url);
      return candidate.url === original
        ? readPage('<article><h1>Трамп о небольших ракетах в Польше</h1><time itemprop="datePublished" datetime="2026-11-20T16:59:00+03:00"></time><p>Трамп назвал ошибкой утренний инцидент в Польше, где упали ракеты.</p></article>',
          original, candidate)
        : metadataPage(candidate, "unavailable");
    },
  });
  expect(requested, [1, 2]);
  expect(opened.sort(), [original, noArticle].sort());
  expect(result.search.newscatcherPages, 2);
  expect(result.earliestId, "S01");
  expect(result.entries.map(entry => [entry.url, entry.published]), [[original, "2026-11-20T13:59:00.000Z"]]);
});

Deno.test("Newscatcher stops at one page when results fit and leaves other routes available on rate limits", async () => {
  const { trace } = await import("./trace.ts");
  const task = "Землетрясение в Камчатке";
  const adapters = {
    tavily: async () => [],
    brightSearch: async () => ({ hits: [], failures: 0 }),
    cloudflareConfigured: () => false,
    eventModel: async () => ({ news: { terms: [["землетрясение"], ["Камчатка", "Камчатке"]] } }),
    openArticle: async (candidate: { url: string }) => metadataPage(candidate),
    newscatcherConfigured: () => true,
  };
  const input = { task, window: { from: null, through: null }, locale: "ru" as const };
  const one = await trace(input, async () => {}, { ...adapters, newscatcherPage: async (_p, page, _d, attempt) => {
    expect(page, 1);
    attempt();
    return { hits: [], more: false, incomplete: false };
  } });
  expect(one.search.newscatcher, 1);
  const broad = await trace(input, async () => {}, { ...adapters, newscatcherPage: async (_p, _page, _d, attempt) => {
    attempt();
    return { hits: [], more: true, incomplete: true };
  } });
  expect([broad.search.newscatcher, broad.search.newscatcherPages, broad.search.newscatcherStatus], [8, 8, "partial"]);
  const throttled = await trace(input, async () => {}, { ...adapters, newscatcherPage: async (_p, page, _d, attempt) => {
    expect(page, 1);
    attempt();
    throw new Error("newscatcher_rate_limit");
  } });
  expect([throttled.search.newscatcher, throttled.search.newscatcherPages, throttled.search.newscatcherStatus,
    throttled.search.tavily > 0], [1, undefined, "rate_limit", true]);
});

Deno.test("Newscatcher records a billable HTTP success even when its JSON fails validation", async () => {
  const { makeNewsSearch, newscatcherPage } = await import("./newscatcher.ts");
  const plan = makeNewsSearch("Трамп Польша", "Трамп Польша", {}, { from: null, through: null });
  if (!plan) throw Error("missing search plan");
  const fetch = globalThis.fetch;
  const prior = Deno.env.get("NEWSCATCHER_API_KEY");
  let recorded: unknown;
  try {
    Deno.env.set("NEWSCATCHER_API_KEY", "test-key");
    globalThis.fetch = async (_url, options) => {
      expect(Object.keys(JSON.parse(String(options?.body))).sort(), [
        "exclude_duplicates", "from_date", "page", "page_size", "q", "search_in", "sort_by", "to_date",
      ]);
      return new Response("bad response", { status: 200 });
    };
    await newscatcherPage(plan, 1, Date.now() + 10_000, () => {}, {
      reserve: async () => 42,
      record: async (id, row) => { recorded = [id, row.status, row.credits, row.result_count]; },
    }).catch(() => {});
    expect(recorded, [42, 200, 5, null]);
  } finally {
    globalThis.fetch = fetch;
    if (prior === undefined) Deno.env.delete("NEWSCATCHER_API_KEY"); else Deno.env.set("NEWSCATCHER_API_KEY", prior);
  }
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

Deno.test("search ranks a relevant regional authority and distinct sources above social duplicates", async () => {
  const { rankSearch, compactQuery } = await import("./trace.ts");
  const query = "Проследи публикации о ДТП в Браславе 13 ноября 2026 года. Найди первоисточник.";
  expect(compactQuery(query), "ДТП в Браславе 13 ноября 2026 года");
  const title = "ДТП в Браславе 13 ноября";
  const content = [
    {title, url:"https://www.instagram.com/p/a"},
    {title, url:"https://vitbichi.by/news/article"},
    {title, url:"https://www.vitbichi.by/news/another-copy"},
    {title, url:"https://gai.gov.by/alerts/incident"},
    {title, url:"https://t.me/vitebsk_gai/26470"},
    {title, url:"https://www.vitbichi.by/news/article?utm_source=test"},
  ];
  expect(rankSearch(content, query, [], "by").map(({url})=>url), [
    content[3].url, content[4].url, content[1].url, content[2].url, content[0].url,
  ]);
});

Deno.test("an indexed Telegram feed only yields matching dated posts and never enters the timeline", async () => {
  const { trace } = await import("./trace.ts");
  const { readTelegramFeed, readTelegramPost } = await import("./core.ts");
  const html = '<div class="tgme_widget_message" data-post="vitebsk_gai/202"><div class="tgme_widget_message_text">ДТП в Браславе. Происшествие на перекрестке.</div><time datetime="2026-11-13T09:46:35Z"></time></div>' +
    '<div class="tgme_widget_message" data-post="vitebsk_gai/201"><div class="tgme_widget_message_text">Погода в Витебске.</div><time datetime="2026-11-13T08:00:00Z"></time></div>' +
    '<div class="tgme_widget_message" data-post="vitebsk_gai/100"><div class="tgme_widget_message_text">ДТП в Браславе.</div><time datetime="2026-11-05T08:00:00Z"></time></div>' +
    '<div class="tgme_widget_message" data-post="other_channel/77"><div class="tgme_widget_message_text">ДТП в Браславе.</div><time datetime="2026-11-13T08:00:00Z"></time></div>';
  const feed = "https://t.me/s/vitebsk_gai?before=204";
  const post = "https://t.me/vitebsk_gai/202";
  const opened: string[] = [];
  const result = await trace({ task:"ДТП в Браславе 13 ноября 2026 года", window:{from:"2026-11-13",through:"2026-11-13"},locale:"ru" },
    async () => {}, {
      tavily: async () => [{ url: feed }],
      openArticle: async candidate => {
        opened.push(candidate.url);
        if (candidate.url === feed) return readTelegramFeed(html, feed, candidate);
        if (candidate.url !== post) throw new Error("Unexpected feed post");
        return readTelegramPost(html, post, candidate)!;
      },
      cloudflareConfigured: () => false,
      eventModel: async () => null,
      brightSearch: async () => ({hits:[], failures:0}),
    });
  expect(opened, [feed, post]);
  expect(result.entries.map(({url})=>url), [post]);
});

Deno.test("the pinned HTTP reader de-chunks a fragmented response and handles a redirect", async () => {
  const { readReply } = await import("./transport.ts");
  const serve = (packets: string[]) => ({
    read(buffer: Uint8Array) {
      const packet = packets.shift();
      return Promise.resolve(packet === undefined ? null : new TextEncoder().encodeInto(packet, buffer).written);
    },
  });
  const progress: Parameters<typeof readReply>[1] = { phase: "headers" };
  const page = await readReply(serve(["HTTP/1.1 200 OK\r\nContent-Type: text/",
    "html; charset=utf-8\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n<art", "i\r\n4\r\ncle>\r\n0\r\n\r\n"]), progress);
  expect([page.html, progress.status, progress.phase], ["<article>", 200, "complete"]);
  const redirect = await readReply(serve(["HTTP/1.1 302 Found\r\nLocation: /news/1\r\nContent-Length: 999\r\n\r\n"]), {phase:"headers"});
  expect([redirect.status, redirect.headers.get("location"), redirect.html], [302, "/news/1", ""]);
});

Deno.test("a contextual citation from another city and an unrelated year stay out of the timeline", async () => {
  const { trace } = await import("./trace.ts");
  const current = "https://example.org/storm";
  const other = "https://example.org/st-petersburg";
  const old = "https://example.org/previous-storm";
  const results = new Map([
    [current, readPage(`<article><h1>Ливень в Москве</h1><p>По данным <a href="${other}">соседнего издания</a> в другом городе тоже прошёл ливень.</p></article>`, current, {url:current})],
    [other, readPage('<article><h1>Ливень в Петербурге</h1><time itemprop="datePublished" datetime="2024-06-20T07:00:00Z"></time><p>По словам МЧС, проблемы есть и в Москве.</p></article>', other, {url:other})],
    [old, readPage('<article><h1>Ливень в Москве</h1><time itemprop="datePublished" datetime="2023-06-20T07:00:00Z"></time><p>Последствия в Москве.</p></article>', old, {url:old})],
  ]);
  const result = await trace({task:"Ливень в Москве 20 июня 2024 года",window:{from:"2024-06-19",through:"2024-06-21"},locale:"ru"},
    async () => {}, {
      tavily: async () => [{url:current}, {url:old}],
      openArticle: async ({url}) => results.get(url)!,
      cloudflareConfigured: () => false,
      eventModel: async () => null,
      brightSearch: async () => ({hits:[], failures:0}),
    });
  expect(result.entries.map(({url})=>url), [current]);
});
