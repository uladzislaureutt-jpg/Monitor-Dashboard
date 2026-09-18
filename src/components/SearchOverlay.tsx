import { useEffect, useState } from "react";
import { desktopApi } from "../api";
import type { PublicationSummary } from "../types";
import { useI18n } from "../i18n";
import { PublicationCard } from "./PublicationCard";

export function SearchOverlay({ query, open, onClose, onShowArchive }: { query: string; open: boolean; onClose: () => void; onShowArchive: (query: string) => void }) {
  const { t } = useI18n();
  const [items, setItems] = useState<PublicationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [moderationVersion, setModerationVersion] = useState(0);
  useEffect(() => { const handler = () => setModerationVersion((value) => value + 1); window.addEventListener("monitor:moderation-changed", handler); return () => window.removeEventListener("monitor:moderation-changed", handler); }, []);
  useEffect(() => {
    if (!open || query.trim().length < 2) { setItems([]); setTotal(0); setError(""); return; }
    const handle = window.setTimeout(() => {
      setLoading(true);
      desktopApi.search(query.trim(), 8).then((result) => { setItems(result.items); setTotal(result.total); setError(""); }).catch((reason) => setError(String(reason))).finally(() => setLoading(false));
    }, 180);
    return () => window.clearTimeout(handle);
  }, [open, query, moderationVersion]);
  if (!open) return null;
  return <div className="search-layer" onMouseDown={onClose}><section className="search-popover" onMouseDown={(event) => event.stopPropagation()}><div className="search-popover-head"><div><b>{t("search.title")}</b><span>{query.trim().length < 2 ? t("search.minChars") : loading ? t("archive.searching") : t("search.matches", { count: total })}</span></div><button className="icon-button" onClick={onClose} aria-label={t("search.close")}>×</button></div>{error && <div className="notice error">{error}</div>}<div className="search-results">{query.trim().length >= 2 && !loading && !error && items.length === 0 && <div className="empty-state">{t("search.empty")}</div>}{items.map((item) => <PublicationCard key={item.id} item={item} compact />)}</div>{total > items.length && <button className="show-all-search" onClick={() => onShowArchive(query.trim())}>{t("search.showAll", { count: total })}</button>}</section></div>;
}
