import { useEffect, useMemo, useState } from "react";
import type { WorkroomLocalItem } from "../types";
import { useI18n } from "../i18n";

const STORAGE_KEY = "monitor-dashboard-workroom-local-notes-v1";
const LEGACY_STORAGE_KEY = "monitor-dashboard-team-local-notes-v1";
function loadItems(): WorkroomLocalItem[] { try { const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY); return raw ? JSON.parse(raw) as WorkroomLocalItem[] : []; } catch { return []; } }

export function WorkroomDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, formatLocale } = useI18n();
  const [items, setItems] = useState<WorkroomLocalItem[]>(loadItems);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"note" | "announcement">("note");
  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); }, [items]);
  const sorted = useMemo(() => [...items].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.createdAt.localeCompare(a.createdAt)), [items]);
  function addItem() { const value = text.trim(); if (!value) return; setItems((current) => [{ id: crypto.randomUUID(), kind, author: t("workroom.you"), text: value, createdAt: new Date().toISOString(), pinned: kind === "announcement" }, ...current]); setText(""); }
  if (!open) return null;
  return <><div className="drawer-backdrop" onMouseDown={onClose} /><aside className="workroom-drawer"><div className="workroom-head"><div><span className="eyebrow">{t("workroom.eyebrow")}</span><h3>{t("workroom.title")}</h3></div><button className="icon-button" onClick={onClose}>×</button></div><div className="workroom-stage-banner"><b>{t("workroom.local")}</b><p>{t("workroom.localHelp")}</p></div><div className="workroom-compose"><div className="segmented compact-segmented"><button className={kind === "note" ? "active" : ""} onClick={() => setKind("note")}>{t("workroom.note")}</button><button className={kind === "announcement" ? "active" : ""} onClick={() => setKind("announcement")}>{t("workroom.announcement")}</button></div><textarea value={text} onChange={(event) => setText(event.target.value)} placeholder={t("workroom.placeholder")} /><button className="primary-button" onClick={addItem}>{t("workroom.save")}</button></div><div className="workroom-feed">{sorted.length === 0 ? <div className="empty-state">{t("workroom.empty")}</div> : sorted.map((item) => <article className={`workroom-item ${item.kind}`} key={item.id}><div className="workroom-item-meta"><b>{item.kind === "announcement" ? t("workroom.announcement") : item.author}</b><span>{new Date(item.createdAt).toLocaleString(formatLocale)}</span></div><p>{item.text}</p><button className="text-danger" onClick={() => setItems((current) => current.filter((candidate) => candidate.id !== item.id))}>{t("workroom.delete")}</button></article>)}</div></aside></>;
}
