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

export function parseBrowserCapture(raw: string): BrowserCaptureArticle {
  const capture = parseEnvelope(raw.trim());
  const doc = new DOMParser().parseFromString(capture.html, "text/html");
  const base = doc.createElement("base");
  base.href = capture.url;
  (doc.head || doc.documentElement).prepend(base);
  doc.querySelectorAll("script,iframe,object,embed").forEach((node) => node.remove());

  const article = new Readability(doc, { charThreshold: 180 }).parse();
  const text = article?.textContent?.trim() || "";
  if (text.length < 180) throw new Error("BROWSER_CAPTURE_READABILITY_EMPTY");

  return {
    title: (article?.title || capture.title || doc.title || "").trim(),
    text,
    url: capture.url,
    publishedTime: article?.publishedTime || null,
    siteName: article?.siteName || null,
  };
}
