import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "../api";
import { useI18n } from "../i18n";
import { useReportWorkspace } from "../reportWorkspace";
import type { ReportDraftItem } from "../types";
import { compressionReduction, exactCompress, type CompressionMode } from "../editorialCompression";
import { aiCompress } from "../editorialAi";

function prettyDate(value: string) {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}.${month}.${year}` : value;
}
function safeFilenameDate(value: string) { return value.split("-").reverse().join("_"); }
const MAX_AI_COMPRESSION_RUNS = 2;
function aiCompressionRunsKey(documentUid: string) { return `ai_compression_runs:${documentUid}`; }

export function ReportView() {
  const { locale } = useI18n();
  const report = useReportWorkspace();
  const isLMonitor = desktopApi.activeMonitorKey() === "lukashenko";
  const [activeUid, setActiveUid] = useState<string | null>(report.items[0]?.documentUid ?? null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState("");
  const [manualItemOpen, setManualItemOpen] = useState(false);
  const [manualItem, setManualItem] = useState({ title: "", source: "", region: "", url: "", text: "" });
  const [browserImportBusy, setBrowserImportBusy] = useState(false);
  const [compressionMode, setCompressionMode] = useState<CompressionMode>("auto");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiRuns, setAiRuns] = useState<number | null>(null);
  const active = useMemo(() => report.items.find((item) => item.documentUid === activeUid) ?? report.items[0] ?? null, [report.items, activeUid]);
  const be = locale === "be";
  const tx = {
    eyebrow: be ? "РЭДАКТАР АГЛЯДУ" : "РЕДАКТОР ОБЗОРА",
    title: be ? "Рабочая вобласць справаздачы" : "Рабочая область отчёта",
    subtitle: isLMonitor
      ? (be ? "Абярыце матэрыялы патрэбнай глыбіні, праверце зыходны тэкст, адрэдагуйце версію для агляду і выгрузіце DOCX." : "Выберите материалы нужной глубины, проверьте исходный текст, отредактируйте версию для обзора и выгрузите DOCX.")
      : (be ? "Абярыце 5–8 матэрыялаў, праверце паўнату зыходнага тэксту, адрэдагуйце версію для агляду і выгрузіце DOCX." : "Выберите 5–8 материалов, проверьте полноту исходного текста, отредактируйте версию для обзора и выгрузите DOCX."),
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
    tooFew: isLMonitor ? "" : (be ? "Звычайны аб'ём — 5–8 матэрыялаў; экспарт даступны і для меншай колькасці." : "Обычный объём — 5–8 материалов; экспорт доступен и для меньшего количества."),
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
    compression: be ? "Кампрэсія" : "Компрессия",
    compressionAuto: be ? "Аўта" : "Авто",
    compressionLight: be ? "Лёгкая 5–10%" : "Лёгкая 5–10%",
    compressionStandard: be ? "Стандарт 20–40%" : "Стандарт 20–40%",
    compressionMaximum: be ? "Максімальная 40–60%" : "Максимальная 40–60%",
    compressionExtract: be ? "Экстракт 60–80%" : "Экстракт 60–80%",
    exact: be ? "Exact · без перапісвання" : "Exact · без переписывания",
    ai: be ? "AI · GPT-OSS 120B" : "AI · GPT-OSS 120B",
    aiRunning: be ? "AI апрацоўвае…" : "AI обрабатывает…",
    compressionNeedsFull: be ? "Кампрэсія даступная толькі для поўнага тэксту." : "Компрессия доступна только для полного текста.",
    exactDone: be ? "Exact-кампрэсія прыменена." : "Exact-компрессия применена.",
    aiDone: be ? "AI-кампрэсія гатовая." : "AI-компрессия готова.",
    aiAuth: be ? "Для AI-кампрэсіі трэба ўвайсці ў Рабочую кімнату." : "Для AI-компрессии нужно войти в Рабочую комнату.",
    aiConfig: be ? "На серверы яшчэ не зададзены GROQ_API_KEY. Exact-рэжым ужо даступны." : "На сервере ещё не задан GROQ_API_KEY. Exact-режим уже доступен.",
    aiValidation: be ? "AI-варыянт не прайшоў праверку фактычнай цэласнасці і не быў ужыты." : "AI-вариант не прошёл проверку фактической целостности и не был применён.",
    aiRange: be ? "AI-варыянт не адпавядае дапушчальнаму дыяпазону скарачэння і не быў ужыты." : "AI-вариант не соответствует допустимому диапазону сокращения и не был применён.",
    aiFallback: be ? "Exact-fallback" : "Exact-fallback",
    aiLimit: be ? "AI-запускі для матэрыялу" : "AI-запуски для публикации",
    aiLimitReached: be ? "Для гэтай публікацыі ўжо выкарыстаны два AI-запускі." : "Для этой публикации уже использованы два AI-запуска.",
    aiMaximumHelp: be ? "Максімальны AI-рэжым строга правяраецца ў дыяпазоне 40–60%." : "Максимальный AI-режим строго проверяется в диапазоне 40–60%.",
    aiExtractHelp: be ? "Рэжым «Экстракт» строга правяраецца ў дыяпазоне 60–80%; у выніку застаецца 20–40% зыходнага тэксту." : "Режим «Экстракт» строго проверяется в диапазоне 60–80%; в результате остаётся 20–40% исходного текста.",
    aiHelp: be ? "AI адпраўляе толькі поўны тэкст абранага матэрыялу. Лічбы, імёны і прамыя цытаты правяраюцца перад заменай." : "AI отправляет только полный текст выбранного материала. Числа, имена и прямые цитаты проверяются перед заменой.",
    exactHelp: be ? "Толькі Exact: скарачэнне без перапісвання і без выкарыстання Groq." : "Только Exact: сокращение без переписывания и без использования Groq.",
    addManualItem: be ? "Дадаць матэрыял уручную" : "Добавить материал вручную",
    browserImport: be ? "Атрымаць з браўзера" : "Получить из браузера",
    browserImportEmpty: be ? "Браўзер пакуль не перадаў матэрыял. Адкрыйце публікацыю, націсніце пашырэнне Monitor і паўтарыце." : "Браузер пока не передал материал. Откройте публикацию, нажмите расширение Monitor и повторите.",
    browserImportDone: be ? "Матэрыял з браўзера атрыманы. Праверце палі і дадайце яго ў агляд." : "Материал из браузера получен. Проверьте поля и добавьте его в обзор.",
    manualItemHelp: be ? "Для матэрыялаў па падпісцы або прапушчаных маніторынгам. Устаўце загаловак, выданне і тэкст з браўзера." : "Для материалов по подписке или пропущенных мониторингом. Вставьте заголовок, издание и текст из браузера.",
    manualTitle: be ? "Загаловак" : "Заголовок",
    manualSource: be ? "Крыніца / выданне" : "Источник / издание",
    manualCountry: be ? "Краіна крыніцы" : "Страна источника",
    manualUrl: "URL",
    manualBody: be ? "Зыходны тэкст" : "Исходный текст",
    add: be ? "Дадаць у агляд" : "Добавить в обзор",
  };

  useEffect(() => {
    setManualOpen(false);
    setManualText("");
  }, [active?.documentUid, isLMonitor]);

  useEffect(() => {
    let cancelled = false;
    if (isLMonitor || !active?.documentUid) { setAiRuns(0); return () => { cancelled = true; }; }
    setAiRuns(null);
    desktopApi.getSetting(aiCompressionRunsKey(active.documentUid))
      .then((value) => {
        const parsed = Number(value || 0);
        if (!cancelled) setAiRuns(Number.isFinite(parsed) ? Math.max(0, Math.min(MAX_AI_COMPRESSION_RUNS, Math.trunc(parsed))) : 0);
      })
      .catch(() => { if (!cancelled) setAiRuns(0); });
    return () => { cancelled = true; };
  }, [active?.documentUid, isLMonitor]);

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

  function applyExactCompression() {
    if (!active || active.sourceQuality !== "full") return;
    const result = exactCompress(active.sourceText, compressionMode);
    report.updateText(active.documentUid, result.text);
    setError("");
    setStatus(`${tx.exactDone} ${be ? "Скарачэнне" : "Сокращение"}: ${result.reductionPct}%.`);
  }

  function aiModeLabel(mode: Exclude<CompressionMode, "auto">) {
    if (mode === "light") return be ? "Лёгкая" : "Лёгкая";
    if (mode === "maximum") return be ? "Максімальная" : "Максимальная";
    if (mode === "extract") return "Экстракт";
    return be ? "Стандарт" : "Стандарт";
  }

  async function applyAiCompression() {
    if (!active || active.sourceQuality !== "full" || aiBusy) return;
    const usedRuns = aiRuns ?? 0;
    if (usedRuns >= MAX_AI_COMPRESSION_RUNS) { setError(tx.aiLimitReached); return; }
    setAiBusy(true);
    setError(""); setStatus("");
    try {
      const nextRun = usedRuns + 1;
      await desktopApi.setSetting(aiCompressionRunsKey(active.documentUid), String(nextRun));
      setAiRuns(nextRun);
      const result = await aiCompress({ text: active.sourceText, mode: compressionMode, title: active.title, source: active.source });
      report.updateText(active.documentUid, result.compressedText);
      setStatus(`${result.fallback ? `${tx.aiFallback}.` : tx.aiDone} AI · ${aiModeLabel(result.effectiveMode)} · ${be ? "скарачэнне" : "сокращение"} ${result.reductionPct}% · ${result.attempts} ${be ? "спроба" : "попытка"} · ${result.usage.totalTokens.toLocaleString()} ${be ? "токенаў" : "токенов"} · ${tx.aiLimit}: ${nextRun}/${MAX_AI_COMPRESSION_RUNS}.`);
    } catch (reason) {
      const message = String(reason);
      if (message.includes("AI_AUTH_REQUIRED") || message.includes("AUTH_REQUIRED")) setError(tx.aiAuth);
      else if (message.includes("groq_not_configured")) setError(tx.aiConfig);
      else if (message.includes("compression_validation_failed")) setError(tx.aiValidation);
      else if (message.includes("AI_CLIENT_REJECTED_RANGE") || message.includes("AI_CLIENT_INVALID_RESULT")) setError(tx.aiRange);
      else setError(message);
    } finally { setAiBusy(false); }
  }

  async function receiveBrowserImport() {
    if (browserImportBusy) return;
    setBrowserImportBusy(true);
    setError("");
    setStatus("");
    try {
      const payload = await desktopApi.takeBrowserImport();
      if (!payload) {
        setError(tx.browserImportEmpty);
        return;
      }
      let region = "";
      try {
        const sources = await desktopApi.sources(null);
        const normalized = payload.source.trim().toLocaleLowerCase();
        const known = sources.find((item) => item.name.trim().toLocaleLowerCase() === normalized);
        region = known?.region || "";
      } catch { /* source lookup is optional */ }
      setManualItem({
        title: payload.title,
        source: payload.source,
        region,
        url: payload.url,
        text: payload.text,
      });
      setManualItemOpen(true);
      setStatus(tx.browserImportDone);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBrowserImportBusy(false);
    }
  }

  function addManualReportItem() {
    if (!manualItem.title.trim() || !manualItem.text.trim()) return;
    try {
      const uid = report.addManualItem(manualItem);
      setActiveUid(uid);
      setManualItem({ title: "", source: "", region: "", url: "", text: "" });
      setManualItemOpen(false);
      setError("");
      setStatus(be ? "Матэрыял дададзены ў агляд." : "Материал добавлен в обзор.");
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
      })), isLMonitor ? "lukashenko" : "social_economic");
      report.markExported();
      setStatus(tx.saved);
    } catch (reason) { setError(String(reason)); }
  }

  const integrityClass = report.partialTextCount + report.missingFullTextCount === 0 ? "ready" : "attention";
  const aiLimitReached = (aiRuns ?? 0) >= MAX_AI_COMPRESSION_RUNS;
  const maximumMode = compressionMode === "maximum";
  const extractMode = compressionMode === "extract";

  return <div className="view-stack report-view">
    <section className="view-heading"><div><div className="eyebrow dark">{tx.eyebrow}</div><h2>{tx.title}</h2><p>{tx.subtitle}</p></div><div className="report-head-controls"><label>{tx.date}<input type="date" value={report.date} onChange={(e) => report.setDate(e.target.value)} /></label><button className="primary-button" disabled={!report.items.length} onClick={exportDocx}>{tx.export}</button></div></section>
    {status && <div className="notice success">{status}</div>}{error && <div className="notice error">{error}</div>}
    {report.items.length > 0 && <section className={`report-integrity-summary ${integrityClass}`}>
      <div><b>{tx.integrity}: {report.fullTextCount}/{report.items.length}</b><span>{tx.fullCount}: {report.fullTextCount} · {tx.partialCount}: {report.partialTextCount} · {tx.missingCount}: {report.missingFullTextCount}</span></div>
      <p>{integrityClass === "ready" ? tx.allReady : tx.needsReview}</p>
    </section>}
    <section className="report-toolbar panel"><div><b>{tx.count}: {report.items.length}{report.maxItems !== null ? `/${report.maxItems}` : ""}</b>{tx.tooFew && <span>{tx.tooFew}</span>}</div><div>{isLMonitor && <><button className="primary-button" disabled={browserImportBusy} onClick={receiveBrowserImport}>{browserImportBusy ? "…" : tx.browserImport}</button><button className="secondary-button" onClick={() => setManualItemOpen((value) => !value)}>{tx.addManualItem}</button></>}<span>{tx.exportHelp}</span>{report.items.length > 0 && <button className="ghost-button" onClick={() => { if (window.confirm(tx.clear + "?")) report.clear(); }}>{tx.clear}</button>}</div></section>
    {isLMonitor && manualItemOpen && <section className="panel report-add-manual"><div><b>{tx.addManualItem}</b><p>{tx.manualItemHelp}</p></div><div className="report-add-manual-grid"><label>{tx.manualTitle}<input value={manualItem.title} onChange={(e) => setManualItem({ ...manualItem, title: e.target.value })} /></label><label>{tx.manualSource}<input value={manualItem.source} onChange={(e) => setManualItem({ ...manualItem, source: e.target.value })} /></label><label>{tx.manualCountry}<input value={manualItem.region} onChange={(e) => setManualItem({ ...manualItem, region: e.target.value })} /></label><label>{tx.manualUrl}<input value={manualItem.url} onChange={(e) => setManualItem({ ...manualItem, url: e.target.value })} placeholder="https://…" /></label></div><label className="report-add-manual-text">{tx.manualBody}<textarea value={manualItem.text} onChange={(e) => setManualItem({ ...manualItem, text: e.target.value })} /></label><div className="report-add-manual-actions"><button className="primary-button" disabled={!manualItem.title.trim() || !manualItem.text.trim()} onClick={addManualReportItem}>{tx.add}</button><button className="ghost-button" onClick={() => setManualItemOpen(false)}>{tx.cancel}</button></div></section>}
    {!report.items.length ? <section className="panel empty-state report-empty">{tx.empty}</section> : <section className="report-workspace-grid">
      <aside className="panel report-basket">{report.items.map((item, index) => <article key={item.documentUid} className={active?.documentUid === item.documentUid ? "active" : ""} onClick={() => setActiveUid(item.documentUid)}><div className="report-basket-number">{index + 1}</div><div><div className="report-basket-source-row"><b>{item.source}</b><span className={`report-text-status ${item.sourceQuality}`} title={qualityLabel(item)}><i />{qualityShort(item)}</span></div><span>{item.title}</span></div><div className="report-order-actions"><button disabled={index === 0} onClick={(e) => { e.stopPropagation(); report.move(item.documentUid, -1); }}>{tx.up}</button><button disabled={index === report.items.length - 1} onClick={(e) => { e.stopPropagation(); report.move(item.documentUid, 1); }}>{tx.down}</button><button className="text-danger" onClick={(e) => { e.stopPropagation(); report.remove(item.documentUid); }}>{tx.remove}</button></div></article>)}</aside>
      {active && <article className="panel report-editor"><div className="report-editor-head"><div><span className="source-chip">{active.source}</span><h3>{active.title}</h3><p>{[active.locality, active.region].filter(Boolean).join(" · ")}</p></div>{active.url && <button className="link-button" onClick={() => desktopApi.openUrl(active.url)}>{tx.open}</button>}</div>
        <details className={`report-source-details quality-${active.sourceQuality}`} open><summary><span>{tx.original} · {qualityLabel(active)}</span><span className={`report-text-status ${active.sourceQuality}`}><i />{qualityShort(active)}</span></summary><div className="report-source-text">{active.sourceText}</div></details>
        {active.sourceQuality !== "full" && <div className="report-source-warning"><div><b>{qualityLabel(active)}</b><p>{tx.needsReview}</p></div><button className="secondary-button small-button" onClick={() => { setManualOpen((value) => !value); if (!manualText) setManualText(""); }}>{active.sourceQuality === "partial" ? tx.replaceFull : tx.pasteFull}</button></div>}
        {manualOpen && active.sourceQuality !== "full" && <div className="report-manual-source"><p>{tx.pasteHelp}</p><textarea value={manualText} onChange={(e) => setManualText(e.target.value)} placeholder={tx.pastePlaceholder} /><div><button className="primary-button small-button" disabled={!manualText.trim()} onClick={saveManualFullText}>{tx.saveManual}</button><button className="ghost-button small-button" onClick={() => { setManualOpen(false); setManualText(""); }}>{tx.cancel}</button></div></div>}
        <div className={`report-compression-panel ${active.sourceQuality !== "full" ? "disabled" : ""}`}>
          <div className="report-compression-head"><div><b>{isLMonitor ? tx.exact : tx.compression}</b><span>{isLMonitor ? tx.exactHelp : tx.aiHelp}</span></div><label><select value={compressionMode} onChange={(e) => setCompressionMode(e.target.value as CompressionMode)} disabled={active.sourceQuality !== "full" || aiBusy}><option value="auto">{tx.compressionAuto}</option><option value="light">{tx.compressionLight}</option><option value="standard">{tx.compressionStandard}</option><option value="maximum">{tx.compressionMaximum}</option><option value="extract">{tx.compressionExtract}</option></select></label></div>
          <div className="report-compression-actions"><button className="secondary-button small-button" disabled={active.sourceQuality !== "full" || aiBusy} onClick={applyExactCompression}>{tx.exact}</button>{!isLMonitor && <button className="primary-button small-button" disabled={active.sourceQuality !== "full" || aiBusy || aiLimitReached || aiRuns === null} onClick={applyAiCompression}>{aiBusy ? tx.aiRunning : tx.ai}</button>}<span>{be ? "Бягучае скарачэнне" : "Текущее сокращение"}: {compressionReduction(active.sourceText, active.editorialText)}%</span>{!isLMonitor && <span>{tx.aiLimit}: {aiRuns ?? "…"}/{MAX_AI_COMPRESSION_RUNS}</span>}</div>
          {active.sourceQuality !== "full" && <p>{tx.compressionNeedsFull}</p>}
          {!isLMonitor && maximumMode && <p>{tx.aiMaximumHelp}</p>}
          {!isLMonitor && extractMode && <p>{tx.aiExtractHelp}</p>}
          {!isLMonitor && aiLimitReached && <p>{tx.aiLimitReached}</p>}
        </div>
        <div className="report-editor-label"><b>{tx.editorial}</b><div><button className="ghost-button small-button" onClick={() => report.resetText(active.documentUid)}>{tx.reset}</button>{active.excerpt && <button className="ghost-button small-button" onClick={() => report.useExcerpt(active.documentUid)}>{tx.useExcerpt}</button>}</div></div>
        <div className="report-editorial-compose"><div className="report-editorial-compose-title">{active.title}</div><textarea className="report-editor-textarea" value={active.editorialText} onChange={(e) => report.updateText(active.documentUid, e.target.value)} /></div>
      </article>}
    </section>}
  </div>;
}
