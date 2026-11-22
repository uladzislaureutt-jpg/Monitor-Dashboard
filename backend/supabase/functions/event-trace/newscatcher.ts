import { day, plain, publicArticleUrl, publicationDate, type Candidate, type Window } from "./core.ts";

const endpoint = "https://api.newscatcherapi.com/news-api/articles";
const pageSize = 100;
export const newsPageLimit = 8;
const creditsPerPage = 5;
const minInterval = 1_150;
const twoDays = 2 * 86_400_000;
let nextRequest = 0;

export type NewsCandidate = Candidate & { publishedHint: string | null; countryHint: string };
export type NewsSearch = { query: string; groups: string[][]; from: string; through: string };
export type NewsAccounting = {
  reserve: (page: number) => Promise<number | null>;
  record: (id: number, entry: { status: number; credits: number | null; result_count: number | null; elapsed_ms: number }) => Promise<void>;
};

function key() {
  return Deno.env.get("NEWSCATCHER_API_KEY") || Deno.env.get("NEWSCATCHER_KEY") ||
    Deno.env.get("NEWSCATCHER_API_TOKEN") || Deno.env.get("NEWS_CATCHER_API_KEY");
}

export function newscatcherConfigured() {
  return Boolean(key());
}

function terms(values: unknown) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.slice(0, 6).map(value => plain(value, 72))
    .filter(value => /^(?=.*\p{L})[\p{L}\p{M}\d .’'\-]+$/u.test(value)))];
}

export function makeNewsSearch(task: string, compact: string, plan: unknown, window: Window, now = Date.now()): NewsSearch | null {
  const proposal = plan && typeof plan === "object" ? plan as { terms?: unknown; date?: unknown } : {};
  let groups = Array.isArray(proposal.terms) ? proposal.terms.slice(0, 4).map(terms).filter(group => group.length) : [];
  if (groups.length < 2) {
    const quotes = terms([...task.matchAll(/[«“"]([^»”"]{3,72})[»”"]/gu)].map(match => match[1]));
    const remaining = quotes.reduce((value, phrase) => value.replaceAll(phrase, ""), compact);
    const original = remaining.match(/\p{L}{4,}/gu) || [];
    const stops = /^(?:президент|интервью|сообщил|сообщение|сообщения|публикации|первоисточник|случилось|случившихся|произош[её]л|сказал|заявил|событие|события|инцидент|першакрыніца|здарэнне|паведаміў|president|interview|search|original|first|earliest|article|report|statement|incident|event)$/iu;
    const words = [...new Set(original.map(word => word.toLowerCase()).filter(word => !stops.test(word)))];
    groups = [...(quotes.length ? [quotes] : []), ...words.slice(0, quotes.length ? 2 : 3).map(word => [word])];
  }
  if (groups.length < 2) return null;
  const query = groups.map(group => "(" + group.map(term => '"' + term + '"').join(" OR ") + ")").join(" AND ");

  const hintedDay = day(proposal.date);
  const date = hintedDay && task.includes(hintedDay.slice(0, 4)) && !window.from && !window.through ? hintedDay : null;
  const fromDay = window.from || date;
  const throughDay = window.through || date;
  const end = throughDay ? Date.parse(throughDay + "T23:59:59.999+03:00") : now;
  const start = fromDay ? Date.parse(fromDay + "T00:00:00+03:00") : end - twoDays;
  if (start > end) return null;
  return { query, groups, from: new Date(start).toISOString(), through: new Date(end).toISOString() };
}

export async function newscatcherPage(search: NewsSearch, page: number, deadline: number, onAttempt: () => void,
    accounting?: NewsAccounting) {
  const apiKey = key();
  if (!apiKey) throw new Error("newscatcher_unavailable");
  const now = Date.now();
  const requestAt = Math.max(now, nextRequest);
  if (deadline - requestAt < 2_500) throw new Error("newscatcher_window_partial");
  nextRequest = requestAt + minInterval;
  if (requestAt > now) await new Promise(resolve => setTimeout(resolve, requestAt - now));
  const reservation = accounting ? await accounting.reserve(page) : null;
  if (accounting && reservation === null) throw new Error("newscatcher_window_partial");
  onAttempt();
  const started = Date.now();
  let status = 0;
  let count: number | null = null;
  let result;
  try {
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.min(8_000, deadline - Date.now()))),
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        q: search.query, search_in: ["title_body", "title_body_translated"],
        from_date: search.from, to_date: search.through, page, page_size: pageSize,
        sort_by: "published_at", exclude_duplicates: false,
      }),
    });
    status = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(status === 429 ? "newscatcher_rate_limit" : "newscatcher_unavailable");
    }
    result = await response.json();
    if (!Array.isArray(result.results)) throw new Error("newscatcher_unavailable");
    count = result.results.length;
  } finally {
    if (accounting && reservation !== null) await accounting.record(reservation, {
      status, credits: status === 200 ? creditsPerPage : status === 0 ? null : 0,
      result_count: count, elapsed_ms: Date.now() - started,
    });
  }
  const hits = result.results.slice(0, pageSize).flatMap((row: Record<string, unknown>): NewsCandidate[] => {
    const url = publicArticleUrl(row?.url);
    if (!url) return [];
    return [{ url, title: plain(row.title, 240), excerpt: plain(row.snippet),
      publishedHint: publicationDate(row.published_at), countryHint: plain(row.country, 2).toUpperCase() }];
  });
  const more = Number.isInteger(result.total_pages) ? result.total_pages > page : result.results.length === pageSize;
  const incomplete = Number(result.total_hits) > page * pageSize || more || Boolean(result.window?.clamped);
  return { hits, more, incomplete };
}
