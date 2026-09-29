import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { desktopApi } from "./api";
import type { PublicationSummary, ReportDraftItem } from "./types";

const storageKey = (monitorKey: string) => `monitor-report-workspace-${monitorKey}-v1`;
const settingKey = (monitorKey: string) => `report.workspace.${monitorKey}.v1`;
const MAX_ITEMS = 8;

type ReportState = { date: string; items: ReportDraftItem[]; revision: number; exportedRevision: number };
type ReportContextValue = ReportState & {
  ready: boolean;
  busyDocumentUid: string | null;
  maxItems: number;
  fullTextCount: number;
  partialTextCount: number;
  missingFullTextCount: number;
  pendingCount: number;
  contains: (documentUid: string) => boolean;
  toggle: (item: PublicationSummary) => Promise<void>;
  remove: (documentUid: string) => void;
  move: (documentUid: string, direction: -1 | 1) => void;
  updateText: (documentUid: string, text: string) => void;
  resetText: (documentUid: string) => void;
  useExcerpt: (documentUid: string) => void;
  setManualFullText: (documentUid: string, text: string) => void;
  setDate: (value: string) => void;
  clear: () => void;
  markExported: () => void;
};

const ReportContext = createContext<ReportContextValue | null>(null);

function todayIso() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function emptyState(): ReportState { return { date: todayIso(), items: [], revision: 0, exportedRevision: 0 }; }

function stripOmissionMarkers(value: string) {
  return value.replace(/\[\s*(?:…|\.{3})\s*\]/g, " ");
}

function cleanEditorialText(value: string) {
  return stripOmissionMarkers(value)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .trim();
}

function normalizeQuality(item: ReportDraftItem): ReportDraftItem["sourceQuality"] {
  const raw = String((item as { sourceQuality?: string }).sourceQuality || "").toLowerCase();
  if (raw === "full") return "full";
  if (raw === "partial") return "partial";
  return "missing";
}

function normalize(raw: unknown): ReportState {
  if (!raw || typeof raw !== "object") return emptyState();
  const value = raw as Partial<ReportState>;
  const items = Array.isArray(value.items)
    ? value.items
        .filter((item): item is ReportDraftItem => Boolean(item && typeof item === "object" && typeof (item as ReportDraftItem).documentUid === "string"))
        .slice(0, MAX_ITEMS)
        .map((item) => ({
          ...item,
          sourceQuality: normalizeQuality(item),
          sourceOrigin: item.sourceOrigin ?? (normalizeQuality(item) === "full" ? "contract" : "excerpt"),
          editorialText: cleanEditorialText(item.editorialText ?? item.sourceText ?? ""),
        }))
    : [];
  const revision = Number.isFinite(Number(value.revision)) ? Math.max(0, Number(value.revision)) : (items.length ? 1 : 0);
  const exportedRevision = Number.isFinite(Number(value.exportedRevision)) ? Math.max(0, Number(value.exportedRevision)) : 0;
  return { date: typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date) ? value.date : todayIso(), items, revision, exportedRevision };
}

function loadLocal(monitorKey: string): ReportState {
  try { return normalize(JSON.parse(localStorage.getItem(storageKey(monitorKey)) ?? "null")); }
  catch { return emptyState(); }
}

export function ReportProvider({ children }: { children: ReactNode }) {
  const [monitorKey, setMonitorKey] = useState(() => desktopApi.activeMonitorKey());
  const [state, setState] = useState<ReportState>(() => loadLocal(desktopApi.activeMonitorKey()));
  const [ready, setReady] = useState(false);
  const [busyDocumentUid, setBusyDocumentUid] = useState<string | null>(null);

  const persistRaw = useCallback((next: ReportState) => {
    setState(next);
    const raw = JSON.stringify(next);
    localStorage.setItem(storageKey(monitorKey), raw);
    void desktopApi.setSetting(settingKey(monitorKey), raw);
  }, [monitorKey]);

  const persist = useCallback((next: ReportState) => {
    persistRaw({ ...next, revision: Math.max(state.revision + 1, next.revision ?? 0), exportedRevision: state.exportedRevision });
  }, [persistRaw, state.exportedRevision, state.revision]);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setState(loadLocal(monitorKey));
    desktopApi.getSetting(settingKey(monitorKey)).then((raw) => {
      if (cancelled) return;
      if (raw) {
        try {
          const restored = normalize(JSON.parse(raw));
          setState(restored);
          localStorage.setItem(storageKey(monitorKey), JSON.stringify(restored));
          void desktopApi.setSetting(settingKey(monitorKey), JSON.stringify(restored));
        } catch { /* keep local fallback */ }
      } else {
        const local = loadLocal(monitorKey);
        if (local.items.length) void desktopApi.setSetting(settingKey(monitorKey), JSON.stringify(local));
      }
      setReady(true);
    }).catch(() => setReady(true));
    return () => { cancelled = true; };
  }, [monitorKey]);

  useEffect(() => {
    const onMonitorChanged = () => setMonitorKey(desktopApi.activeMonitorKey());
    window.addEventListener("monitor:changed", onMonitorChanged);
    return () => window.removeEventListener("monitor:changed", onMonitorChanged);
  }, []);

  const contains = useCallback((documentUid: string) => state.items.some((item) => item.documentUid === documentUid), [state.items]);

  const remove = useCallback((documentUid: string) => {
    persist({ ...state, items: state.items.filter((item) => item.documentUid !== documentUid) });
  }, [persist, state]);

  const toggle = useCallback(async (item: PublicationSummary) => {
    if (contains(item.documentUid)) { remove(item.documentUid); return; }
    if (state.items.length >= MAX_ITEMS) throw new Error("REPORT_MAX_ITEMS");
    setBusyDocumentUid(item.documentUid);
    try {
      const editorial = await desktopApi.editorialSource(item.documentUid);
      const fullText = editorial?.fullText?.trim() || "";
      const quality = (editorial?.quality || "").trim().toLowerCase();
      const sourceQuality: ReportDraftItem["sourceQuality"] = fullText
        ? (quality === "partial" ? "partial" : "full")
        : "missing";
      const sourceText = fullText || item.excerpt?.trim() || item.title;
      const draft: ReportDraftItem = {
        documentUid: item.documentUid,
        title: item.title,
        url: item.url,
        source: item.source,
        publishedAt: item.publishedAt,
        region: item.region,
        locality: item.locality,
        excerpt: item.excerpt,
        score: item.score,
        officialResponse: item.officialResponse,
        sourceText,
        sourceQuality,
        sourceOrigin: fullText ? "contract" : "excerpt",
        editorialText: cleanEditorialText(sourceText),
      };
      persist({ ...state, items: [...state.items, draft] });
    } finally { setBusyDocumentUid(null); }
  }, [contains, persist, remove, state]);

  const move = useCallback((documentUid: string, direction: -1 | 1) => {
    const index = state.items.findIndex((item) => item.documentUid === documentUid);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= state.items.length) return;
    const items = [...state.items];
    [items[index], items[target]] = [items[target], items[index]];
    persist({ ...state, items });
  }, [persist, state]);

  const updateText = useCallback((documentUid: string, text: string) => {
    persist({ ...state, items: state.items.map((item) => item.documentUid === documentUid ? { ...item, editorialText: stripOmissionMarkers(text) } : item) });
  }, [persist, state]);

  const resetText = useCallback((documentUid: string) => {
    persist({ ...state, items: state.items.map((item) => item.documentUid === documentUid ? { ...item, editorialText: cleanEditorialText(item.sourceText) } : item) });
  }, [persist, state]);

  const useExcerpt = useCallback((documentUid: string) => {
    persist({ ...state, items: state.items.map((item) => item.documentUid === documentUid ? { ...item, editorialText: cleanEditorialText(item.excerpt?.trim() || item.sourceText) } : item) });
  }, [persist, state]);

  const setManualFullText = useCallback((documentUid: string, text: string) => {
    const fullText = cleanEditorialText(text);
    if (!fullText) return;
    persist({
      ...state,
      items: state.items.map((item) => {
        if (item.documentUid !== documentUid) return item;
        const current = cleanEditorialText(item.editorialText);
        const previousSource = cleanEditorialText(item.sourceText);
        const excerpt = cleanEditorialText(item.excerpt?.trim() || "");
        const untouched = !current || current === previousSource || current === excerpt;
        return {
          ...item,
          sourceText: fullText,
          sourceQuality: "full" as const,
          sourceOrigin: "manual" as const,
          editorialText: untouched ? fullText : item.editorialText,
        };
      }),
    });
  }, [persist, state]);

  const setDate = useCallback((date: string) => persist({ ...state, date }), [persist, state]);
  const clear = useCallback(() => persist({ ...state, date: state.date, items: [] }), [persist, state]);
  const markExported = useCallback(() => { persistRaw({ ...state, exportedRevision: state.revision }); }, [persistRaw, state]);
  const fullTextCount = useMemo(() => state.items.filter((item) => item.sourceQuality === "full").length, [state.items]);
  const partialTextCount = useMemo(() => state.items.filter((item) => item.sourceQuality === "partial").length, [state.items]);
  const missingFullTextCount = useMemo(() => state.items.filter((item) => item.sourceQuality === "missing").length, [state.items]);
  const pendingCount = useMemo(() => state.items.length > 0 && state.revision !== state.exportedRevision ? state.items.length : 0, [state.items.length, state.revision, state.exportedRevision]);

  const value = useMemo<ReportContextValue>(() => ({
    ...state,
    ready,
    busyDocumentUid,
    maxItems: MAX_ITEMS,
    fullTextCount,
    partialTextCount,
    missingFullTextCount,
    pendingCount,
    contains,
    toggle,
    remove,
    move,
    updateText,
    resetText,
    useExcerpt,
    setManualFullText,
    setDate,
    clear,
    markExported,
  }), [state, ready, busyDocumentUid, fullTextCount, partialTextCount, missingFullTextCount, pendingCount, contains, toggle, remove, move, updateText, resetText, useExcerpt, setManualFullText, setDate, clear, markExported]);
  return <ReportContext.Provider value={value}>{children}</ReportContext.Provider>;
}

export function useReportWorkspace() {
  const value = useContext(ReportContext);
  if (!value) throw new Error("useReportWorkspace must be used inside ReportProvider");
  return value;
}
