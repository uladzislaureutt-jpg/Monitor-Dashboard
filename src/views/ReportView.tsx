import { useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "../api";
import { useI18n } from "../i18n";
import { useReportWorkspace } from "../reportWorkspace";

function prettyDate(value: string) {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}.${month}.${year}` : value;
}
function safeFilenameDate(value: string) { return value.split("-").reverse().join("_"); }

export function ReportView() {
  const { locale } = useI18n();
  const report = useReportWorkspace();
  const [activeUid, setActiveUid] = useState<string | null>(report.items[0]?.documentUid ?? null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const active = useMemo(() => report.items.find((item) => item.documentUid === activeUid) ?? report.items[0] ?? null, [report.items, activeUid]);
  const be = locale === "be";
  const tx = {
    eyebrow: be ? "РЭДАКТАР АГЛЯДУ" : "РЕДАКТОР ОБЗОРА",
    title: be ? "Рабочая вобласць справаздачы" : "Рабочая область отчёта",
    subtitle: be ? "Абярыце 5–8 матэрыялаў, праверце зыходны тэкст, адрэдагуйце версію для агляду і выгрузіце DOCX." : "Выберите 5–8 материалов, проверьте исходный текст, отредактируйте версию для обзора и выгрузите DOCX.",
    count: be ? "Выбрана" : "Выбрано",
    clear: be ? "Ачысціць" : "Очистить",
    empty: be ? "Пакуль нічога не выбрана. Дадайце матэрыялы кнопкай «У агляд» у Архіве або Апошніх матэрыялах." : "Пока ничего не выбрано. Добавьте материалы кнопкой «В обзор» в Архиве или Последних материалах.",
    original: be ? "Зыходны тэкст" : "Исходный текст",
    full: be ? "поўны тэкст" : "полный текст",
    excerpt: be ? "вытрымка са старога пакета" : "выдержка из старого пакета",
    editorial: be ? "Тэкст для агляду" : "Текст для обзора",
    reset: be ? "Вярнуць зыходны" : "Вернуть исходный",
    useExcerpt: be ? "Узяць вытрымку" : "Использовать выдержку",
    open: be ? "Адкрыць арыгінал ↗" : "Открыть оригинал ↗",
    remove: be ? "Прыбраць" : "Убрать",
    up: "↑", down: "↓",
    export: be ? "Экспартаваць DOCX" : "Экспортировать DOCX",
    hydrate: be ? "Пацвердзіць выбар і атрымаць поўныя тэксты" : "Подтвердить выбор и получить полные тексты",
    hydrating: be ? "Атрымліваю поўныя тэксты…" : "Получаю полные тексты…",
    allFull: be ? "Поўныя тэксты ўжо ёсць для ўсёй падборкі" : "Полные тексты уже есть для всей подборки",
    exportHelp: be ? "Фармат паўтарае дасланыя ўзоры; пасля кожнага матэрыялу выводзіцца поўны URL публікацыі." : "Формат повторяет присланные образцы; после каждого материала выводится полный URL публикации.",
    date: be ? "Дата агляду" : "Дата обзора",
    saved: be ? "DOCX захаваны." : "DOCX сохранён.",
    hydrated: be ? "Поўныя тэксты: атрымана {fetched}, ужо было {cached}, не атрымалася {failed}." : "Полные тексты: получено {fetched}, уже было {cached}, не удалось {failed}.",
    tooFew: be ? "Звычайны аб'ём — 5–8 матэрыялаў; экспарт даступны і для меншай колькасці." : "Обычный объём — 5–8 материалов; экспорт доступен и для меньшего количества.",
  };

  async function hydrateFullTexts() {
    if (!report.items.length || report.hydrating) return;
    setError(""); setStatus("");
    try {
      const results = await report.hydrateMissing();
      const fetched = results.filter((item) => item.status === "fetched").length;
      const cached = results.filter((item) => item.status === "already_present").length;
      const failed = results.filter((item) => item.status === "failed").length;
      setStatus(tx.hydrated.replace("{fetched}", String(fetched)).replace("{cached}", String(cached)).replace("{failed}", String(failed)));
      if (failed) {
        const details = results.filter((item) => item.status === "failed").map((item) => item.detail).filter(Boolean);
        if (details.length) setError(details.join("\n"));
      }
    } catch (reason) { setError(String(reason)); }
  }

  async function exportDocx() {
    if (!report.items.length) return;
    setError(""); setStatus("");
    const path = await save({
      title: tx.export,
      defaultPath: `Обзор_критических_материалов_${safeFilenameDate(report.date)}.docx`,
      filters: [{ name: "Word DOCX", extensions: ["docx"] }],
    });
    if (!path) return;
    try {
      await desktopApi.exportReport(path, prettyDate(report.date), report.items.map((item) => ({
        source: item.source,
        location: item.locality && item.region && item.locality !== item.region ? `${item.locality}, ${item.region}` : item.locality || item.region || "",
        title: item.title,
        text: item.editorialText.trim() || item.sourceText.trim() || item.title,
        url: item.url,
      })));
      setStatus(tx.saved);
    } catch (reason) { setError(String(reason)); }
  }

  return <div className="view-stack report-view">
    <section className="view-heading"><div><div className="eyebrow dark">{tx.eyebrow}</div><h2>{tx.title}</h2><p>{tx.subtitle}</p></div><div className="report-head-controls"><label>{tx.date}<input type="date" value={report.date} onChange={(e) => report.setDate(e.target.value)} /></label><button className="primary-button" disabled={!report.items.length} onClick={exportDocx}>{tx.export}</button></div></section>
    {status && <div className="notice success">{status}</div>}{error && <div className="notice error">{error}</div>}
    <section className="report-toolbar panel"><div><b>{tx.count}: {report.items.length}/{report.maxItems}</b><span>{tx.tooFew}</span><button className="secondary-button report-hydrate-button" disabled={!report.items.length || report.hydrating || report.missingFullTextCount === 0} onClick={hydrateFullTexts}>{report.hydrating ? tx.hydrating : report.missingFullTextCount === 0 ? tx.allFull : `${tx.hydrate} (${report.missingFullTextCount})`}</button></div><div><span>{tx.exportHelp}</span>{report.items.length > 0 && <button className="ghost-button" onClick={() => { if (window.confirm(tx.clear + "?")) report.clear(); }}>{tx.clear}</button>}</div></section>
    {!report.items.length ? <section className="panel empty-state report-empty">{tx.empty}</section> : <section className="report-workspace-grid">
      <aside className="panel report-basket">{report.items.map((item, index) => <article key={item.documentUid} className={active?.documentUid === item.documentUid ? "active" : ""} onClick={() => setActiveUid(item.documentUid)}><div className="report-basket-number">{index + 1}</div><div><b>{item.source}</b><span>{item.title}</span></div><div className="report-order-actions"><button disabled={index === 0} onClick={(e) => { e.stopPropagation(); report.move(item.documentUid, -1); }}>{tx.up}</button><button disabled={index === report.items.length - 1} onClick={(e) => { e.stopPropagation(); report.move(item.documentUid, 1); }}>{tx.down}</button><button className="text-danger" onClick={(e) => { e.stopPropagation(); report.remove(item.documentUid); }}>{tx.remove}</button></div></article>)}</aside>
      {active && <article className="panel report-editor"><div className="report-editor-head"><div><span className="source-chip">{active.source}</span><h3>{active.title}</h3><p>{[active.locality, active.region].filter(Boolean).join(" · ")}</p></div><button className="link-button" onClick={() => desktopApi.openUrl(active.url)}>{tx.open}</button></div>
        <details className="report-source-details" open><summary>{tx.original} · {active.sourceQuality === "full" ? tx.full : tx.excerpt}</summary><div className="report-source-text">{active.sourceText}</div></details>
        <div className="report-editor-label"><b>{tx.editorial}</b><div><button className="ghost-button small-button" onClick={() => report.resetText(active.documentUid)}>{tx.reset}</button>{active.excerpt && <button className="ghost-button small-button" onClick={() => report.useExcerpt(active.documentUid)}>{tx.useExcerpt}</button>}</div></div>
        <textarea className="report-editor-textarea" value={active.editorialText} onChange={(e) => report.updateText(active.documentUid, e.target.value)} />
      </article>}
    </section>}
  </div>;
}
