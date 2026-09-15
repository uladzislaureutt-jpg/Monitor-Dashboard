import { useEffect, useMemo, useState } from "react";
import type { TeamLocalItem } from "../types";

const STORAGE_KEY = "monitor-dashboard-team-local-notes-v1";

function loadItems(): TeamLocalItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as TeamLocalItem[] : [];
  } catch {
    return [];
  }
}

export function TeamDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<TeamLocalItem[]>(loadItems);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"note" | "announcement">("note");

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }, [items]);

  const sorted = useMemo(() => [...items].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.createdAt.localeCompare(a.createdAt)), [items]);

  function addItem() {
    const value = text.trim();
    if (!value) return;
    setItems((current) => [{
      id: crypto.randomUUID(),
      kind,
      author: "Вы",
      text: value,
      createdAt: new Date().toISOString(),
      pinned: kind === "announcement",
    }, ...current]);
    setText("");
  }

  if (!open) return null;

  return (
    <>
      <div className="drawer-backdrop" onMouseDown={onClose} />
      <aside className="team-drawer">
        <div className="team-head">
          <div>
            <span className="eyebrow">КОМАНДА</span>
            <h3>Лента и объявления</h3>
          </div>
          <button className="icon-button" onClick={onClose}>×</button>
        </div>
        <div className="team-stage-banner">
          <b>Интерфейс готов, синхронизация ещё не подключена.</b>
          <p>На этапе 0.4 записи ниже сохраняются только на этом компьютере. В 0.5 этот же drawer подключим к общему каналу 5–7 пользователей без передачи архива статей на сервер.</p>
        </div>
        <div className="team-compose">
          <div className="segmented compact-segmented">
            <button className={kind === "note" ? "active" : ""} onClick={() => setKind("note")}>Заметка</button>
            <button className={kind === "announcement" ? "active" : ""} onClick={() => setKind("announcement")}>Объявление</button>
          </div>
          <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Оставить локальную заметку для проверки интерфейса…" />
          <button className="primary-button" onClick={addItem}>Сохранить локально</button>
        </div>
        <div className="team-feed">
          {sorted.length === 0 ? (
            <div className="empty-state">Локальных заметок пока нет.</div>
          ) : sorted.map((item) => (
            <article className={`team-item ${item.kind}`} key={item.id}>
              <div className="team-item-meta">
                <b>{item.kind === "announcement" ? "Объявление" : item.author}</b>
                <span>{new Date(item.createdAt).toLocaleString("ru-RU")}</span>
              </div>
              <p>{item.text}</p>
              <button className="text-danger" onClick={() => setItems((current) => current.filter((candidate) => candidate.id !== item.id))}>Удалить локально</button>
            </article>
          ))}
        </div>
      </aside>
    </>
  );
}
