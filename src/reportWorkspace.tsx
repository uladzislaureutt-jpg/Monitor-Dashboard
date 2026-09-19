import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { desktopApi } from "./api";
import type { FullTextHydrationResult, PublicationSummary, ReportDraftItem } from "./types";

const STORAGE_KEY = "monitor-report-workspace-social-v1";
const SETTING_KEY = "report.workspace.social_economic.v1";
const MAX_ITEMS = 8;

type ReportState = { date: string; items: ReportDraftItem[]; revision: number; exportedRevision: number };
type ReportContextValue = ReportState & {
  ready: boolean;
  busyDocumentUid: string | null;
  hydrating: boolean;
  maxItems: number;
  missingFullTextCount: number;
  pendingCount: number;
  contains: (documentUid: string) => boolean;
  toggle: (item: PublicationSummary) => Promise<void>;
  hydrateMissing: () => Promise<FullTextHydrationResult[]>;
  remove: (documentUid: string) => void;
  move: (documentUid: string, direction: -1 | 1) => void;
  updateText: (documentUid: string, text: string) => void;
  resetText: (documentUid: string) => void;
  useExcerpt: (documentUid: string) => void;
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

function normalize(raw: unknown): ReportState {
  if (!raw || typeof raw !== "object") return emptyState();
  const value = raw as Partial<ReportState>;
  const items = Array.isArray(value.items)
    ? value.items
        .filter((item): item is ReportDraftItem => Boolean(item && typeof item === "object" && typeof (item as ReportDraftItem).documentUid === "string"))
        .slice(0, MAX_ITEMS)
        .map((item) => ({ ...item, editorialText: cleanEditorialText(item.editorialText ?? item.sourceText ?? "") }))
    : [];
  const revision = Number.isFinite(Number(value.revision)) ? Math.max(0, Number(value.revision)) : (items.length ? 1 : 0);
  const exportedRevision = Number.isFinite(Number(value.exportedRevision)) ? Math.max(0, Number(value.exportedRevision)) : 0;
  return { date: typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date) ? value.date : todayIso(), items, revision, exportedRevision };
}

function loadLocal(): ReportState {
  try { return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")); }
  catch { return emptyState(); }
}

export function ReportProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ReportState>(loadLocal);
  const [ready, setReady] = useState(false);
  const [busyDocumentUid, setBusyDocumentUid] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(false);

  const persistRaw = useCallback((next: ReportState) => {
    setState(next);
    const raw = JSON.stringify(next);
    localStorage.setItem(STORAGE_KEY, raw);
    void desktopApi.setSetting(SETTING_KEY, raw);
  }, []);

  const persist = useCallback((next: ReportState) => {
    persistRaw({ ...next, revision: Math.max(state.revision + 1, next.revision ?? 0), exportedRevision: state.exportedRevision });
  }, [persistRaw, state.exportedRevision, state.revision]);

  useEffect(() => {
    let cancelled = false;
    desktopApi.getSetting(SETTING_KEY).then((raw) => {
      if (cancelled) return;
      if (raw) {
        try {
          const restored = normalize(JSON.parse(raw));
          setState(restored);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(restored));
          void desktopApi.setSetting(SETTING_KEY, JSON.stringify(restored));
        } catch { /* keep local fallback */ }
      } else {
        const local = loadLocal();
        if (local.items.length) void desktopApi.setSetting(SETTING_KEY, JSON.stringify(local));
      }
      setReady(true);
    }).catch(() => setReady(true));
    return () => { cancelled = true; };
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
        sourceQuality: fullText ? "full" : "excerpt",
        editorialText: fullText || cleanEditorialText(item.excerpt?.trim() || item.title),
      };
      persist({ ...state, items: [...state.items, draft] });
    } finally { setBusyDocumentUid(null); }
  }, [contains, persist, remove, state]);

  const hydrateMissing = useCallback(async () => {
    const missing = state.items.filter((item) => item.sourceQuality !== "full");
    if (!missing.length) return [];
    setHydrating(true);
    try {
      const results = await desktopApi.hydrateReportFullTexts(missing.map((item) => item.documentUid));
      const nextItems = await Promise.all(state.items.map(async (item) => {
        if (item.sourceQuality === "full") return item;
        const editorial = await desktopApi.editorialSource(item.documentUid);
        const fullText = editorial?.fullText?.trim() || "";
        if (!fullText) return item;
        const previousClean = cleanEditorialText(item.sourceText);
        const currentClean = cleanEditorialText(item.editorialText);
        const excerptClean = cleanEditorialText(item.excerpt?.trim() || "");
        const untouched = !currentClean || currentClean === previousClean || currentClean === excerptClean;
        return {
          ...item,
          sourceText: fullText,
          sourceQuality: "full" as const,
          editorialText: untouched ? fullText : item.editorialText,
        };
      }));
      persist({ ...state, items: nextItems });
      return results;
    } finally { setHydrating(false); }
  }, [persist, state]);

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
  const setDate = useCallback((date: string) => persist({ ...state, date }), [persist, state]);
  const clear = useCallback(() => persist({ ...state, date: state.date, items: [] }), [persist, state]);
  const markExported = useCallback(() => { persistRaw({ ...state, exportedRevision: state.revision }); }, [persistRaw, state]);
  const missingFullTextCount = useMemo(() => state.items.filter((item) => item.sourceQuality !== "full").length, [state.items]);
  const pendingCount = useMemo(() => state.items.length > 0 && state.revision !== state.exportedRevision ? state.items.length : 0, [state.items.length, state.revision, state.exportedRevision]);

  const value = useMemo<ReportContextValue>(() => ({
    ...state,
    ready,
    busyDocumentUid,
    hydrating,
    maxItems: MAX_ITEMS,
    missingFullTextCount,
    pendingCount,
    contains,
    toggle,
    hydrateMissing,
    remove,
    move,
    updateText,
    resetText,
    useExcerpt,
    setDate,
    clear,
    markExported,
  }), [state, ready, busyDocumentUid, hydrating, missingFullTextCount, pendingCount, contains, toggle, hydrateMissing, remove, move, updateText, resetText, useExcerpt, setDate, clear, markExported]);
  return <ReportContext.Provider value={value}>{children}</ReportContext.Provider>;
}

export function useReportWorkspace() {
  const value = useContext(ReportContext);
  if (!value) throw new Error("useReportWorkspace must be used inside ReportProvider");
  return value;
}
