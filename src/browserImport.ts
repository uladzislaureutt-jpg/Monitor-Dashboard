import { Readability } from "./generated/readability.js";

export type BrowserCaptureArticle = {
  title: string;
  text: string;
  url: string;
  publishedTime: string | null;
  siteName: string | null;
};

type BrowserCaptureEnvelope = {
  monitor: number;
  version?: number;
  url: string;
  title?: string;
  html: string;
  capturedAt?: string;
};

export const MONITOR_BOOKMARKLET = `javascript:(async()=>{try{const p=JSON.stringify({monitor:1,version:1,url:location.href,title:document.title,html:document.documentElement.outerHTML,capturedAt:new Date().toISOString()});let ok=false;try{await navigator.clipboard.writeText(p);ok=true}catch(e){}if(!ok){const t=document.createElement('textarea');t.value=p;t.setAttribute('readonly','');t.style.cssText='position:fixed;left:-9999px;top:0;opacity:0';document.body.appendChild(t);t.focus();t.select();ok=document.execCommand('copy');t.remove()}alert(ok?'Скопировано для Monitor':'Не удалось скопировать. Используйте ручную вставку текста.')}catch(e){alert('Monitor: '+(e&&e.message?e.message:e))}})()`;

function parseEnvelope(raw: string): BrowserCaptureEnvelope {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("BROWSER_CAPTURE_INVALID"); }
  if (!value || typeof value !== "object") throw new Error("BROWSER_CAPTURE_INVALID");
  const data = value as Partial<BrowserCaptureEnvelope>;
  if (data.monitor !== 1 || typeof data.url !== "string" || typeof data.html !== "string") throw new Error("BROWSER_CAPTURE_INVALID");
  if (!/^https?:\/\//i.test(data.url) || data.html.length < 100) throw new Error("BROWSER_CAPTURE_INVALID");
  if (data.html.length > 12_000_000) throw new Error("BROWSER_CAPTURE_TOO_LARGE");
  return data as BrowserCaptureEnvelope;
}

function compactText(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function linkTextLength(element: Element) {
  return Array.from(element.querySelectorAll("a"))
    .reduce((total, anchor) => total + compactText(anchor.textContent || "").length, 0);
}

function pruneNavigationAndRecommendationBlocks(root: HTMLElement) {
  root.querySelectorAll("nav,aside,footer,form,[role='navigation'],[role='complementary']")
    .forEach((node) => node.remove());

  const candidates = Array.from(root.querySelectorAll("ul,ol,section,div")).reverse();
  for (const element of candidates) {
    if (!element.isConnected) continue;
    const text = compactText(element.textContent || "");
    if (text.length < 100) continue;
    const anchors = element.querySelectorAll("a");
    if (anchors.length < 3) continue;

    const linked = linkTextLength(element);
    const density = linked / Math.max(1, text.length);
    const punctuation = (text.match(/[.!?…](?:\s|$)/g) || []).length;
    const looksLikeLinkFeed =
      density >= 0.58 ||
      (density >= 0.44 && anchors.length >= 6 && punctuation <= Math.max(3, Math.floor(anchors.length / 2)));

    if (looksLikeLinkFeed) element.remove();
  }

  // After link feeds are removed, empty headings often remain ("Сейчас читают",
  // "Related", etc.). Drop only short trailing headings that no longer introduce
  // substantial content; do not rely on source names or language-specific phrases.
  const headings = Array.from(root.querySelectorAll("h2,h3,h4,h5,h6"));
  for (const heading of headings) {
    if (!heading.isConnected) continue;
    const text = compactText(heading.textContent || "");
    if (!text || text.length > 80) continue;
    let sibling = heading.nextElementSibling;
    let followingText = "";
    while (sibling && followingText.length < 140) {
      followingText += " " + compactText(sibling.textContent || "");
      sibling = sibling.nextElementSibling;
    }
    if (compactText(followingText).length < 80) heading.remove();
  }
}

function textFromReadableHtml(content: string) {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body><main id="monitor-readable">${content}</main></body>`, "text/html");
  const root = parsed.getElementById("monitor-readable");
  if (!root) return "";

  pruneNavigationAndRecommendationBlocks(root);

  const blocks = Array.from(root.querySelectorAll("p,blockquote,h2,h3,h4,li"))
    .map((node) => compactText(node.textContent || ""))
    .filter((text) => text.length >= 2);

  // Prefer paragraph-aware reconstruction. If the page has unusual markup and
  // Readability returned no normal blocks, retain its cleaned text as fallback.
  const result = blocks.join("\n\n");
  return compactText(result || root.textContent || "");
}

export function parseBrowserCapture(raw: string): BrowserCaptureArticle {
  const capture = parseEnvelope(raw.trim());
  const doc = new DOMParser().parseFromString(capture.html, "text/html");
  const base = doc.createElement("base");
  base.href = capture.url;
  (doc.head || doc.documentElement).prepend(base);
  doc.querySelectorAll("script,iframe,object,embed").forEach((node) => node.remove());

  const article = new Readability(doc, { charThreshold: 180 }).parse();
  const text = article?.content ? textFromReadableHtml(article.content) : compactText(article?.textContent || "");
  if (text.length < 180) throw new Error("BROWSER_CAPTURE_READABILITY_EMPTY");

  return {
    title: (article?.title || capture.title || doc.title || "").trim(),
    text,
    url: capture.url,
    publishedTime: article?.publishedTime || null,
    siteName: article?.siteName || null,
  };
}
