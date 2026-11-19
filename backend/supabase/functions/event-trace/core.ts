import { load } from "npm:cheerio@1.0.0-rc.12";
import ipaddr from "npm:ipaddr.js@2.2.0";
import { Readability } from "npm:@mozilla/readability@0.6.0";
import { parseHTML } from "npm:linkedom@0.18.12";

export const MAX_PAGES = 20;
export const TASK_LIMIT = 500;
const upperUrlLength = 2048;
const trackingKey = /^(utm_|fbclid$|gclid$|mc_[ce]id$)/i;
const attachment = /\.(?:jpg|jpeg|gif|webp|png|svg|mp[34]|zip|exe|pdf|css|js)$/i;

export type Window = { from: string | null; through: string | null };
export type Candidate = { url: string; title?: string; excerpt?: string };
type Link = { url: string; label: string; evidence?: string; kind: "citation" | "related" | "reference" };
export type Page = {
  url: string; title: string; publisher: string; excerpt: string;
  published: string | null; updated: string | null;
  access: "readable" | "lead" | "metadata";
  links: Link[];
  publicationEvidence?: string;
  updateEvidence?: string;
  extraction?: "html" | "readability" | "telegram";
  issue?: "redirect_home" | "timeout" | "unavailable";
  originKind?: "official" | "media";
  country?: string;
  namedSources?: string[];
};
export type TimelineEntry = Omit<Page, "links"> & {
  id: string; outsideWindow: boolean;
  citations: Array<{ sourceId: string; evidence: string }>;
};
export type TraceResult = {
  entries: TimelineEntry[];
  earliestId: string | null;
  citedSourceIds: string[];
  checked: number;
  search: { tavily: number; brightData: number };
  warnings: string[];
  summary: string | null;
  observations?: Array<{ sourceId: string; excerpt: string; kind: "statement" | "detail" | "disputed" }>;
  checkedAt?: string;
};

export function publicArticleUrl(value: unknown, base?: string): string | null {
  if (typeof value !== "string" || !value || value.length > upperUrlLength) return null;
  try {
    const url = new URL(value, base);
    const host = url.hostname.toLowerCase();
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port ||
        !host.includes(".") || host.endsWith(".") || ipaddr.isValid(host) ||
        /(?:^|\.)(?:localhost|local|internal|lan|home|onion|test|example|invalid)$/.test(host) ||
        attachment.test(url.pathname)) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (trackingKey.test(key)) url.searchParams.delete(key);
    return url.href.length <= upperUrlLength ? url.href : null;
  } catch { return null; }
}

export function publicAddress(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === "unicast" && (ip.kind() === "ipv4" || /^[23]/i.test(ip.toString()));
  } catch { return false; }
}

export function telegramPostKey(value: string): string | null {
  const url = new URL(value);
  if (url.hostname !== "t.me" && url.hostname !== "telegram.me") return null;
  return url.pathname.match(/^\/(?:s\/)?([A-Za-z0-9_]+\/[1-9]\d{0,10})\/?$/)?.[1]?.toLowerCase() ?? null;
}

export function urlKey(value: string): string {
  const post = telegramPostKey(value);
  if (post) return "t.me/" + post;
  const url = new URL(value);
  url.searchParams.sort();
  return url.hostname.replace(/^www\./, "") + url.pathname.replace(/\/+$/, "") + url.search;
}

export function plain(value: unknown, max = 420): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "";
}

export function day(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + "T12:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

export function publicationDate(value: unknown): string | null {
  const raw = plain(value, 60);
  if (day(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const date = new Date(raw);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
}

// Visible dates rendered by editorial templates may omit a time or a zone.
function visibleDate(value: string, kind: "published" | "updated"): string | null {
  const months = [
    ["january", "janvier", "stycznia", "января"], ["february", "février", "lutego", "февраля"],
    ["march", "mars", "marca", "марта"], ["april", "avril", "kwietnia", "апреля"],
    ["may", "mai", "maja", "мая"], ["june", "juin", "czerwca", "июня"],
    ["july", "juillet", "lipca", "июля"], ["august", "août", "sierpnia", "августа"],
    ["september", "septembre", "września", "сентября"], ["october", "octobre", "października", "октября"],
    ["november", "novembre", "listopada", "ноября"], ["december", "décembre", "grudnia", "декабря"],
  ];
  const marker = kind === "published" ? /(?:published(?: on)?|publié le|opublikowano|опубликовано)\s*:?\s*/iu
    : /(?:updated(?: as of| on)?|mis à jour le|zaktualizowano|обновлено)\s*:?\s*/iu;
  const found = marker.exec(value);
  if (!found || found.index > 8) return null;
  const tail = value.slice(found.index + found[0].length);
  const match = tail.match(/^(\d{1,2})\s+(\p{L}+)\s+(\d{4})/u) ||
    tail.match(/^(?:\d{1,2}:\d{2}\s*(?:a\.m\.|p\.m\.),?\s*)?(\p{L}+)\s+(\d{1,2}),?\s+(\d{4})/iu);
  if (!match) return null;
  const [first, second, year] = match.slice(1);
  const english = Number.isNaN(Number(first));
  const month = months.findIndex((list) => list.includes((english ? first : second).toLowerCase())) + 1;
  return month ? day(`${year}-${String(month).padStart(2, "0")}-${(english ? second : first).padStart(2, "0")}`) : null;
}

function articleSchema(data: unknown, depth = 0): Record<string, unknown> | null {
  if (!data || typeof data !== "object" || depth > 3) return null;
  if (Array.isArray(data)) {
    for (const node of data.slice(0, 32)) {
      const item = articleSchema(node, depth + 1);
      if (item) return item;
    }
    return null;
  }
  const obj = data as Record<string, unknown>;
  const kinds = Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]];
  if (kinds.some((type) => typeof type === "string" && /(?:Article|BlogPosting|Report|PressRelease)$/i.test(type))) return obj;
  return articleSchema(obj["@graph"], depth + 1) || articleSchema(obj.mainEntity, depth + 1);
}

const citation = /(?:источник\s*:|крыніца\s*:|źródło\s*:|source\s*:|джерело\s*:|according to|reported by|reports?\b|first reported|citing|в сообщении|как сообщает|как пишет|по данным|по сообщению|со ссылкой на|як паведамляе|паводле|d’après|d'apres|d'après|selon|a rapporté|citant|podaje|donosi|według|poinformowa[łl]|ujawni[łl]|informuje|laut |wie .*berichtet|según|segun|secondo|за даними|як повідомляє)/iu;
const dossier = /(?:dossier|^voir les \d+ publications|all (?:stories|articles|publications)|thematic|related (?:stories|articles)|więcej na temat|все материалы по теме|тематическ[а-я]+ досье)/iu;
const gated = /(?:subscriber(?:s only| content)|sign in to (?:continue|read)|subscribe to (?:continue|read)|доступно по подписке|dostęp dla subskrybentów|réservé aux abonnés|für abonnenten)/iu;

function classifications(value: string): Pick<Page, "country" | "originKind"> {
  const host = new URL(value).hostname.replace(/^www\./, "");
  const post = telegramPostKey(value);
  const channel = post?.split("/")[0];
  const officialChannels: Record<string, string> = { vitebsk_gai: "BY", mchs112by: "BY", kbgsras: "RU" };
  if (channel && officialChannels[channel]) return { country: officialChannels[channel], originKind: "official" };
  const suffix = host.split(".").at(-1)?.toUpperCase();
  const country = suffix && /^(BY|RU|PL|UA|FR|DE|GB|UK|IT|ES|US|CA|LT|LV|EE|CZ|SE|NO|FI|NL|BE|SK|HU|MD|KZ|KG|AT|CH|PT)$/.test(suffix)
    ? suffix === "UK" ? "GB" : suffix : undefined;
  return { country, originKind: /(?:^|\.)(?:gov(?:\.|$)|gouv\.fr$|elysee\.fr$)/.test(host) ? "official" : "media" };
}

export function redirectedToHome(requested: string, fetched: string): boolean {
  const from = new URL(requested);
  const to = new URL(fetched);
  return from.pathname !== "/" && /^(?:\/|\/(?:ru|be|en|pl|fr|de)\/?)$/i.test(to.pathname) && !to.search;
}

export function metadataPage(candidate: Candidate, issue?: Page["issue"]): Page {
  return {
    url: candidate.url, title: plain(candidate.title) || new URL(candidate.url).hostname,
    publisher: new URL(candidate.url).hostname.replace(/^www\./, ""), excerpt: plain(candidate.excerpt),
    published: null, updated: null, access: "metadata", links: [], issue, ...classifications(candidate.url),
  };
}

function numericByline(value: string, host: string): string | null {
  const match = value.match(/^(?:(?:понедельник|вторник|среда|четверг|пятница|суббота|воскресенье),?\s*)?(\d{2})[./](\d{2})[./](\d{4})(?:[ ,/]+(\d{2}:\d{2}))?(?:\s*(?:[|·]|$))/iu);
  if (!match) return null;
  const date = day(`${match[3]}-${match[2]}-${match[1]}`);
  return date && match[4] && /^(?:www\.)?vitbichi\.by$/.test(host)
    ? publicationDate(`${date}T${match[4]}:00+03:00`) : date;
}

function articleText(markup: string): string {
  if (!markup) return "";
  try {
    // Bound CPU and avoid translating navigation or script data into article text.
    const { document } = parseHTML(markup.slice(0, 360_000));
    const dom = document as unknown as Document;
    const parsed = new Readability(dom, { charThreshold: 140, maxElemsToParse: 9000, nbTopCandidates: 4 }).parse();
    const body = plain(parsed?.textContent, 2300);
    return gated.test(body) ? "" : body;
  } catch { return ""; }
}

export function readTelegramPost(markup: string, sourceUrl: string, candidate: Candidate): Page | null {
  const id = telegramPostKey(sourceUrl);
  if (!id) return null;
  const $ = load(markup);
  const post = $("[data-post]").filter((_, node) => $(node).attr("data-post")?.toLowerCase() === id).first();
  const message = post.find(".tgme_widget_message_text").first();
  const excerpt = plain(message.text(), 2300);
  if (!excerpt) return null;
  const time = post.find("time[datetime]").first().attr("datetime");
  // An album caption may be inside its selected post while its date is in the enclosing message.
  const outerTime = post.closest(".tgme_widget_message_wrap").find("a.tgme_widget_message_date").filter((_, node) => {
    const href = publicArticleUrl($(node).attr("href"), sourceUrl);
    return href ? telegramPostKey(href) === id : false;
  }).first().find("time[datetime]").attr("datetime");
  const published = publicationDate(time || outerTime);
  const links = message.find("a[href]").slice(0, 20).toArray().flatMap((node): Link[] => {
    const anchor = $(node);
    const url = publicArticleUrl(anchor.attr("href"), sourceUrl);
    const label = plain(anchor.text(), 140);
    if (!url || !label || urlKey(url) === urlKey(sourceUrl)) return [];
    return /читать подробнее|читайте подробнее|падрабязней|read more/i.test(label) ? [{ url, label, kind: "related" }] : [];
  });
  const publisher = plain(post.find(".tgme_widget_message_owner_name").first().text(), 90) || "@" + id.split("/")[0];
  return { url: "https://t.me/" + id, title: plain(candidate.title || excerpt, 150), publisher, excerpt, published,
    updated: null, access: "readable", links, extraction: "telegram",
    ...(published ? { publicationEvidence: "Telegram · datetime" } : {}), ...classifications(sourceUrl) };
}

export function readPage(markup: string, fetchedUrl: string, candidate: Candidate): Page {
  if (redirectedToHome(candidate.url, fetchedUrl)) return metadataPage(candidate, "redirect_home");
  const cleanMarkup = markup.replace(/<script\b(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  const $ = load(cleanMarkup);
  const meta = (name: string) => $(`meta[property="${name}"],meta[name="${name}"],meta[itemprop="${name}"]`).first().attr("content");
  let schema: Record<string, unknown> | null = null;
  for (const node of $('script[type="application/ld+json"]').slice(0, 16).toArray()) {
    try {
      const raw = $(node).text();
      if (raw.length > 160_000) continue;
      schema = articleSchema(JSON.parse(raw));
      if (schema) break;
    } catch { /* Ignore invalid structured metadata. */ }
  }
  const canon = publicArticleUrl($('link[rel=canonical]').first().attr("href"), fetchedUrl);
  const url = canon && new URL(canon).hostname.replace(/^www\./, "") === new URL(fetchedUrl).hostname.replace(/^www\./, "")
    ? canon : fetchedUrl;
  const title = plain(schema?.headline || meta("og:title") || $("h1").first().text() || $("title").first().text() || candidate.title);
  const site = schema?.publisher as { name?: unknown } | undefined;
  const publisher = plain(site?.name || meta("og:site_name"), 90) || new URL(url).hostname.replace(/^www\./, "");
  const article = $("article").first();
  const main = $("main,#main,[role=main]").first();
  const heading = $("h1").first();
  const body = article.length ? article : main.length ? main : heading.closest(".post,.entry,.news-detail,.news-item-detail,.detail,.material");
  $("script,style,nav,footer,aside,form,iframe,[hidden],[role=navigation]").remove();
  const headerDateScope = (article.length ? article : heading.parent());
  const dateLabels = headerDateScope.find("time,span,p,small,.date,.news-date,.text-muted").slice(0, 90)
    .map((_, node) => plain($(node).text(), 180)).get();
  // Belarusian editorial templates can place the byline next to the heading outside an article element.
  const host = new URL(fetchedUrl).hostname;
  const byline = dateLabels.map((text) => numericByline(text, host)).find(Boolean)
    || (/^(?:www\.)?vitbichi\.by$/.test(host) ? $("[class*=date],.news-detail p,.news-detail div,main p")
      .slice(0, 100).map((_, node) => plain($(node).text(), 180)).get()
      .map((text) => /^пятница,|^понедельник,|^вторник,|^среда,|^четверг,|^суббота,|^воскресенье,/iu.test(text)
        ? numericByline(text, host) : null).find(Boolean) : null);
  const metaPublished = [schema?.datePublished, meta("article:published_time"), meta("datePublished"),
    body.find('time[itemprop="datePublished"]').first().attr("datetime")].map(publicationDate).find(Boolean);
  const visiblePublished = byline || dateLabels.map((text) => visibleDate(text, "published")).find(Boolean);
  const published = visiblePublished && visiblePublished.length > 10 ? visiblePublished : metaPublished ?? visiblePublished ?? null;
  const publishedFrom = published ? published === visiblePublished ? "Подпись в статье" : "Метаданные статьи" : undefined;
  const metaUpdated = [schema?.dateModified, meta("article:modified_time"), meta("dateModified"),
    body.find('time[itemprop="dateModified"]').first().attr("datetime")].map(publicationDate).find(Boolean);
  const updated = metaUpdated ?? dateLabels.map((text) => visibleDate(text, "updated")).find(Boolean) ?? null;
  const paragraphs = body.find("h2,h3,h4,h5,p").slice(0, 35).map((_, element) => plain($(element).text(), 550)).get();
  const originalText = plain(paragraphs.join(" "), 2300);
  const lead = plain(meta("og:description") || meta("description") || candidate.excerpt);
  const paywall = schema?.isAccessibleForFree === false || schema?.isAccessibleForFree === "false" || gated.test(originalText);
  const fallback = !paywall && originalText.length < 1300 ? articleText(cleanMarkup) : "";
  const extracted = fallback.length >= Math.max(260, originalText.length + 120);
  const bodyText = extracted ? fallback : originalText;
  const access = paywall ? lead || bodyText ? "lead" : "metadata"
    : bodyText.length >= 260 ? "readable" : lead || bodyText ? "lead" : "metadata";
  const links: Link[] = [];
  const seen = new Set<string>();
  const anchors = (main.length ? main : body.length ? body : $("body")).find("a[href]").slice(0, 450).toArray();
  for (const anchor of anchors) {
    const ref = $(anchor);
    const link = publicArticleUrl(ref.attr("href"), fetchedUrl);
    const label = plain(ref.text(), 180);
    if (!link || !label || urlKey(link) === urlKey(url)) continue;
    const container = ref.closest("p,li,blockquote,.source,.entry-source");
    const context = plain(container.text(), 5000);
    const offset = context.toLowerCase().indexOf(label.toLowerCase());
    const snippet = offset >= 0 ? context.slice(Math.max(0, offset - 115), offset + label.length + 110) : "";
    const sameSite = new URL(link).hostname.replace(/^www\./, "") === new URL(url).hostname.replace(/^www\./, "");
    const parentText = plain(ref.parent().text(), 180);
    const articleAnchor = !article.length || ref.closest("article").get(0) === article.get(0);
    const type = articleAnchor && snippet && citation.test(snippet) ? "citation"
      : sameSite && (dossier.test(label) || dossier.test(parentText)) ? "related" : "reference";
    if (seen.has(urlKey(link) + ":" + type)) continue;
    seen.add(urlKey(link) + ":" + type);
    links.push({ url: link, label, kind: type, ...(type === "citation" ? { evidence: plain(snippet, 300) } : {}) });
  }
  const namedSources = paragraphs.map((text) => text.match(/^(?:источник|крыніца|źródło|source|джерело)\s*:\s*(.{3,100})$/iu)?.[1])
    .filter((text): text is string => Boolean(text)).slice(0, 5);
  return { url, title: title || publisher, publisher, excerpt: access === "lead" ? lead || bodyText.slice(0, 420)
    : plain(bodyText || lead, 1700), published, updated, access, links, extraction: extracted ? "readability" : "html",
    publicationEvidence: publishedFrom, updateEvidence: updated ? metaUpdated ? "Метаданные статьи" : "Отметка об обновлении" : undefined,
    namedSources, ...classifications(url) };
}

export function timeline(pages: Page[], resolved: Map<string, string>, window: Window): Pick<TraceResult, "entries" | "earliestId" | "citedSourceIds"> {
  const dateKey = (value: string) => value.length === 10 ? value : new Date(Date.parse(value) + 3 * 3600_000).toISOString().slice(0, 10);
  const outsideWindow = (value: string | null) => Boolean(value &&
    ((window.from && dateKey(value) < window.from) || (window.through && dateKey(value) > window.through)));
  const ordered = [...pages].sort((left, right) => {
    const a = left.published, b = right.published;
    if (!a || !b) return a ? -1 : b ? 1 : 0;
    const byDay = dateKey(a).localeCompare(dateKey(b));
    return byDay || (a.length === 10 || b.length === 10 ? Number(a.length === 10) - Number(b.length === 10) : Date.parse(a) - Date.parse(b));
  });
  const byUrl = new Map(ordered.map((page, index) => [urlKey(page.url), `S${String(index + 1).padStart(2, "0")}`]));
  const cited = new Set<string>();
  const entries = ordered.map(({ links, ...page }) => {
    const id = byUrl.get(urlKey(page.url))!;
    const targets = new Set<string>();
    const citations = links.filter((link) => link.kind === "citation" && link.evidence).flatMap((link) => {
      const target = urlKey(link.url);
      const sourceId = byUrl.get(resolved.get(target) || target);
      if (!sourceId || sourceId === id || targets.has(sourceId)) return [];
      targets.add(sourceId);
      cited.add(sourceId);
      return [{ sourceId, evidence: link.evidence! }];
    });
    return { ...page, id, outsideWindow: outsideWindow(page.published), citations };
  });
  return { entries, earliestId: entries.find((entry) => entry.published && !entry.outsideWindow)?.id ?? null, citedSourceIds: [...cited] };
}
