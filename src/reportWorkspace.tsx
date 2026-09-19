import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { desktopApi } from "./api";
import type { PublicationSummary, ReportDraftItem } from "./types";

const STORAGE_KEY = "monitor-report-workspace-social-v1";
const SETTING_KEY = "report.workspace.social_economic.v1";
const MAX_ITEMS = 8;

type ReportState = { date: string; items: ReportDraftItem[] };
type ReportContextValue = ReportState & {
  ready: boolean;
  busyDocumentUid: string | null;
  maxItems: number;
  contains: (documentUid: string) => boolean;
  toggle: (item: PublicationSummary) => Promise<void>;
  remove: (documentUid: string) => void;
  move: (documentUid: string, direction: -1 | 1) => void;
  updateText: (documentUid: string, text: string) => void;
  resetText: (documentUid: string) => void;
  useExcerpt: (documentUid: string) => void;
  setDate: (value: string) => void;
  clear: () => void;
};

const ReportContext = createContext<ReportContextValue | null>(null);

function todayIso() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function emptyState(): ReportState { return { date: todayIso(), items: [] }; }

function normalize(raw: unknown): ReportState {
  if (!raw || typeof raw !== "object") return emptyState();
  const value = raw as Partial<ReportState>;
  const items = Array.isArray(value.items)
    ? value.items.filter((item): item is ReportDraftItem => Boolean(item && typeof item === "object" && typeof (item as ReportDraftItem).documentUid === "string")).slice(0, MAX_ITEMS)
    : [];
  return { date: typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date) ? value.date : todayIso(), items };
}

function loadLocal(): ReportState {
  try { return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")); }
  catch { return emptyState(); }
}

export function ReportProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ReportState>(loadLocal);
  const [ready, setReady] = useState(false);
  const [busyDocumentUid, setBusyDocumentUid] = useState<string | null>(null);

  const persist = useCallback((next: ReportState) => {
    setState(next);
    const raw = JSON.stringify(next);
    localStorage.setItem(STORAGE_KEY, raw);
    void desktopApi.setSetting(SETTING_KEY, raw);
  }, []);

  useEffect(() => {
    let cancelled = false;
    desktopApi.getSetting(SETTING_KEY).then((raw) => {
      if (cancelled) return;
      if (raw) {
        try {
          const restored = normalize(JSON.parse(raw));
          setState(restored);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(restored));
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
      const sourceText = editorial?.fullText?.trim() || item.excerpt?.trim() || item.title;
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
        sourceQuality: editorial?.fullText?.trim() ? "full" : "excerpt",
        editorialText: sourceText,
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
    persist({ ...state, items: state.items.map((item) => item.documentUid === documentUid ? { ...item, editorialText: text } : item) });
  }, [persist, state]);
  const resetText = useCallback((documentUid: string) => {
    persist({ ...state, items: state.items.map((item) => item.documentUid === documentUid ? { ...item, editorialText: item.sourceText } : item) });
  }, [persist, state]);
  const useExcerpt = useCallback((documentUid: string) => {
    persist({ ...state, items: state.items.map((item) => item.documentUid === documentUid ? { ...item, editorialText: item.excerpt?.trim() || item.sourceText } : item) });
  }, [persist, state]);
  const setDate = useCallback((date: string) => persist({ ...state, date }), [persist, state]);
  const clear = useCallback(() => persist({ date: state.date, items: [] }), [persist, state.date]);

  const value = useMemo<ReportContextValue>(() => ({ ...state, ready, busyDocumentUid, maxItems: MAX_ITEMS, contains, toggle, remove, move, updateText, resetText, useExcerpt, setDate, clear }), [state, ready, busyDocumentUid, contains, toggle, remove, move, updateText, resetText, useExcerpt, setDate, clear]);
  return <ReportContext.Provider value={value}>{children}</ReportContext.Provider>;
}

export function useReportWorkspace() {
  const value = useContext(ReportContext);
  if (!value) throw new Error("useReportWorkspace must be used inside ReportProvider");
  return value;
}
