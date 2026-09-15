import { useEffect, useMemo, useState } from "react";
import type { WorkroomLocalItem } from "../types";

const STORAGE_KEY = "monitor-dashboard-workroom-local-notes-v1";
const LEGACY_STORAGE_KEY = "monitor-dashboard-team-local-notes-v1";

function loadItems(): WorkroomLocalItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? JSON.parse(raw) as WorkroomLocalItem[] : [];
  } catch {
    return [];
  }
}

export function WorkroomDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<WorkroomLocalItem[]>(loadItems);
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

  return <>
    <div className="drawer-backdrop" onMouseDown={onClose} />
    <aside className="workroom-drawer">
      <div className="workroom-head">
        <div><span className="eyebrow">РАБОЧАЯ КОМНАТА</span><h3>Обсуждения и заметки</h3></div>
        <button className="icon-button" onClick={onClose}>×</button>
      </div>
      <div className="workroom-stage-banner"><b>Пока локальный режим.</b><p>Заметки сохраняются только на этом компьютере. Сетевой канал для 5–7 пользователей подключим отдельным backend-слоем, не передавая архив публикаций на сервер.</p></div>
      <div className="workroom-compose">
        <div className="segmented compact-segmented">
          <button className={kind === "note" ? "active" : ""} onClick={() => setKind("note")}>Заметка</button>
          <button className={kind === "announcement" ? "active" : ""} onClick={() => setKind("announcement")}>Объявление</button>
        </div>
        <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Записать мысль, вопрос или договорённость…" />
        <button className="primary-button" onClick={addItem}>Сохранить локально</button>
      </div>
      <div className="workroom-feed">
        {sorted.length === 0 ? <div className="empty-state">Заметок пока нет.</div> : sorted.map((item) => <article className={`workroom-item ${item.kind}`} key={item.id}>
          <div className="workroom-item-meta"><b>{item.kind === "announcement" ? "Объявление" : item.author}</b><span>{new Date(item.createdAt).toLocaleString("ru-RU")}</span></div>
          <p>{item.text}</p>
          <button className="text-danger" onClick={() => setItems((current) => current.filter((candidate) => candidate.id !== item.id))}>Удалить локально</button>
        </article>)}
      </div>
    </aside>
  </>;
}
