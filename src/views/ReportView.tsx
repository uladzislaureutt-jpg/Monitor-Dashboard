import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "../api";
import { useI18n } from "../i18n";
import { useReportWorkspace } from "../reportWorkspace";
import type { ReportDraftItem } from "../types";

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
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState("");
  const active = useMemo(() => report.items.find((item) => item.documentUid === activeUid) ?? report.items[0] ?? null, [report.items, activeUid]);
  const be = locale === "be";
  const tx = {
    eyebrow: be ? "РЭДАКТАР АГЛЯДУ" : "РЕДАКТОР ОБЗОРА",
    title: be ? "Рабочая вобласць справаздачы" : "Рабочая область отчёта",
    subtitle: be ? "Абярыце 5–8 матэрыялаў, праверце паўнату зыходнага тэксту, адрэдагуйце версію для агляду і выгрузіце DOCX." : "Выберите 5–8 материалов, проверьте полноту исходного текста, отредактируйте версию для обзора и выгрузите DOCX.",
    count: be ? "Выбрана" : "Выбрано",
    clear: be ? "Ачысціць" : "Очистить",
    empty: be ? "Пакуль нічога не выбрана. Дадайце матэрыялы кнопкай «У агляд» у Архіве або Апошніх матэрыялах." : "Пока ничего не выбрано. Добавьте материалы кнопкой «В обзор» в Архиве или Последних материалах.",
    original: be ? "Зыходны тэкст" : "Исходный текст",
    full: be ? "поўны тэкст" : "полный текст",
    partial: be ? "частковы тэкст" : "частичный текст",
    missing: be ? "поўны тэкст адсутнічае · паказана вытрымка" : "полный текст отсутствует · показана выдержка",
    manual: be ? "поўны тэкст устаўлены ўручную" : "полный текст вставлен вручную",
    editorial: be ? "Тэкст для агляду" : "Текст для обзора",
    reset: be ? "Вярнуць зыходны" : "Вернуть исходный",
    useExcerpt: be ? "Узяць вытрымку" : "Использовать выдержку",
    open: be ? "Адкрыць арыгінал ↗" : "Открыть оригинал ↗",
    remove: be ? "Прыбраць" : "Убрать",
    up: "↑", down: "↓",
    export: be ? "Экспартаваць DOCX" : "Экспортировать DOCX",
    exportHelp: be ? "Фармат паўтарае дасланыя ўзоры; пасля кожнага матэрыялу выводзіцца поўны URL публікацыі." : "Формат повторяет присланные образцы; после каждого материала выводится полный URL публикации.",
    date: be ? "Дата агляду" : "Дата обзора",
    saved: be ? "DOCX захаваны." : "DOCX сохранён.",
    tooFew: be ? "Звычайны аб'ём — 5–8 матэрыялаў; экспарт даступны і для меншай колькасці." : "Обычный объём — 5–8 материалов; экспорт доступен и для меньшего количества.",
    integrity: be ? "Паўната тэкстаў" : "Полнота текстов",
    fullCount: be ? "поўных" : "полных",
    partialCount: be ? "частковых" : "частичных",
    missingCount: be ? "адсутнічае" : "отсутствуют",
    allReady: be ? "Усе выбраныя матэрыялы маюць поўны тэкст." : "Все выбранные материалы имеют полный текст.",
    needsReview: be ? "Матэрыялы з частковым або адсутным тэкстам патрабуюць ручной праверкі перад рэдагаваннем." : "Материалы с частичным или отсутствующим текстом требуют ручной проверки перед редактированием.",
    pasteFull: be ? "Уставіць поўны тэкст уручную" : "Вставить полный текст вручную",
    replaceFull: be ? "Замяніць поўным тэкстам уручную" : "Заменить полным текстом вручную",
    pasteHelp: be ? "Адкрыйце арыгінал у браўзеры, скапіруйце тэкст публікацыі і ўстаўце яго сюды. Тэкст захаваецца толькі ў рабочай падборцы агляду." : "Откройте оригинал в браузере, скопируйте текст публикации и вставьте его сюда. Текст сохранится только в рабочей подборке обзора.",
    pastePlaceholder: be ? "Устаўце поўны тэкст публікацыі…" : "Вставьте полный текст публикации…",
    saveManual: be ? "Захаваць як поўны тэкст" : "Сохранить как полный текст",
    cancel: be ? "Скасаваць" : "Отмена",
    manualSaved: be ? "Поўны тэкст захаваны ў рабочай падборцы." : "Полный текст сохранён в рабочей подборке.",
  };

  useEffect(() => {
    setManualOpen(false);
    setManualText("");
  }, [active?.documentUid]);

  function qualityLabel(item: ReportDraftItem) {
    if (item.sourceQuality === "full") return item.sourceOrigin === "manual" ? tx.manual : tx.full;
    if (item.sourceQuality === "partial") return tx.partial;
    return tx.missing;
  }

  function qualityShort(item: ReportDraftItem) {
    if (item.sourceQuality === "full") return be ? "Поўны" : "Полный";
    if (item.sourceQuality === "partial") return be ? "Частковы" : "Частичный";
    return be ? "Адсутнічае" : "Отсутствует";
  }

  function saveManualFullText() {
    if (!active || !manualText.trim()) return;
    report.setManualFullText(active.documentUid, manualText);
    setManualOpen(false);
    setManualText("");
    setError("");
    setStatus(tx.manualSaved);
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
      report.markExported();
      setStatus(tx.saved);
    } catch (reason) { setError(String(reason)); }
  }

  const integrityClass = report.partialTextCount + report.missingFullTextCount === 0 ? "ready" : "attention";

  return <div className="view-stack report-view">
    <section className="view-heading"><div><div className="eyebrow dark">{tx.eyebrow}</div><h2>{tx.title}</h2><p>{tx.subtitle}</p></div><div className="report-head-controls"><label>{tx.date}<input type="date" value={report.date} onChange={(e) => report.setDate(e.target.value)} /></label><button className="primary-button" disabled={!report.items.length} onClick={exportDocx}>{tx.export}</button></div></section>
    {status && <div className="notice success">{status}</div>}{error && <div className="notice error">{error}</div>}
    {report.items.length > 0 && <section className={`report-integrity-summary ${integrityClass}`}>
      <div><b>{tx.integrity}: {report.fullTextCount}/{report.items.length}</b><span>{tx.fullCount}: {report.fullTextCount} · {tx.partialCount}: {report.partialTextCount} · {tx.missingCount}: {report.missingFullTextCount}</span></div>
      <p>{integrityClass === "ready" ? tx.allReady : tx.needsReview}</p>
    </section>}
    <section className="report-toolbar panel"><div><b>{tx.count}: {report.items.length}/{report.maxItems}</b><span>{tx.tooFew}</span></div><div><span>{tx.exportHelp}</span>{report.items.length > 0 && <button className="ghost-button" onClick={() => { if (window.confirm(tx.clear + "?")) report.clear(); }}>{tx.clear}</button>}</div></section>
    {!report.items.length ? <section className="panel empty-state report-empty">{tx.empty}</section> : <section className="report-workspace-grid">
      <aside className="panel report-basket">{report.items.map((item, index) => <article key={item.documentUid} className={active?.documentUid === item.documentUid ? "active" : ""} onClick={() => setActiveUid(item.documentUid)}><div className="report-basket-number">{index + 1}</div><div><div className="report-basket-source-row"><b>{item.source}</b><span className={`report-text-status ${item.sourceQuality}`} title={qualityLabel(item)}><i />{qualityShort(item)}</span></div><span>{item.title}</span></div><div className="report-order-actions"><button disabled={index === 0} onClick={(e) => { e.stopPropagation(); report.move(item.documentUid, -1); }}>{tx.up}</button><button disabled={index === report.items.length - 1} onClick={(e) => { e.stopPropagation(); report.move(item.documentUid, 1); }}>{tx.down}</button><button className="text-danger" onClick={(e) => { e.stopPropagation(); report.remove(item.documentUid); }}>{tx.remove}</button></div></article>)}</aside>
      {active && <article className="panel report-editor"><div className="report-editor-head"><div><span className="source-chip">{active.source}</span><h3>{active.title}</h3><p>{[active.locality, active.region].filter(Boolean).join(" · ")}</p></div><button className="link-button" onClick={() => desktopApi.openUrl(active.url)}>{tx.open}</button></div>
        <details className={`report-source-details quality-${active.sourceQuality}`} open><summary><span>{tx.original} · {qualityLabel(active)}</span><span className={`report-text-status ${active.sourceQuality}`}><i />{qualityShort(active)}</span></summary><div className="report-source-text">{active.sourceText}</div></details>
        {active.sourceQuality !== "full" && <div className="report-source-warning"><div><b>{qualityLabel(active)}</b><p>{tx.needsReview}</p></div><button className="secondary-button small-button" onClick={() => { setManualOpen((value) => !value); if (!manualText) setManualText(""); }}>{active.sourceQuality === "partial" ? tx.replaceFull : tx.pasteFull}</button></div>}
        {manualOpen && active.sourceQuality !== "full" && <div className="report-manual-source"><p>{tx.pasteHelp}</p><textarea value={manualText} onChange={(e) => setManualText(e.target.value)} placeholder={tx.pastePlaceholder} /><div><button className="primary-button small-button" disabled={!manualText.trim()} onClick={saveManualFullText}>{tx.saveManual}</button><button className="ghost-button small-button" onClick={() => { setManualOpen(false); setManualText(""); }}>{tx.cancel}</button></div></div>}
        <div className="report-editor-label"><b>{tx.editorial}</b><div><button className="ghost-button small-button" onClick={() => report.resetText(active.documentUid)}>{tx.reset}</button>{active.excerpt && <button className="ghost-button small-button" onClick={() => report.useExcerpt(active.documentUid)}>{tx.useExcerpt}</button>}</div></div>
        <textarea className="report-editor-textarea" value={active.editorialText} onChange={(e) => report.updateText(active.documentUid, e.target.value)} />
      </article>}
    </section>}
  </div>;
}
