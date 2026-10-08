import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "../api";
import { MONITOR_BOOKMARKLET, parseBrowserCapture } from "../browserImport";
import { useI18n } from "../i18n";
import { useReportWorkspace } from "../reportWorkspace";
import type { ReportDraftItem } from "../types";
import { compressionReduction, exactCompressForProfile, type CompressionMode } from "../editorialCompression";
import { aiCompress } from "../editorialAi";

function prettyDate(value: string) {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}.${month}.${year}` : value;
}
function safeFilenameDate(value: string) { return value.split("-").reverse().join("_"); }
const MAX_AI_COMPRESSION_RUNS = 2;
function aiCompressionRunsKey(documentUid: string) { return `ai_compression_runs:${documentUid}`; }


type EditorialLintIssue = {
  id: string;
  start: number;
  end: number;
  messageRu: string;
  messageBe: string;
  excerpt: string;
};

function excerptAround(text: string, start: number, end: number) {
  const from = Math.max(0, start - 28);
  const to = Math.min(text.length, Math.max(end, start + 1) + 34);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ")}${to < text.length ? "…" : ""}`;
}

function lintEditorialText(text: string): EditorialLintIssue[] {
  const issues: EditorialLintIssue[] = [];
  const add = (start: number, end: number, ru: string, be: string) => {
    issues.push({ id: `${start}:${end}:${issues.length}`, start, end, messageRu: ru, messageBe: be, excerpt: excerptAround(text, start, end) });
  };

  for (const match of text.matchAll(/ {2,}/g)) {
    const start = match.index ?? 0;
    add(start, start + match[0].length, "Лишний пробел", "Лішні прабел");
  }
  for (const match of text.matchAll(/\s+([,;:!?])/g)) {
    const start = match.index ?? 0;
    add(start, start + match[0].length, `Пробел перед знаком «${match[1]}»`, `Прабел перад знакам «${match[1]}»`);
  }
  for (const match of text.matchAll(/([,;:!?])([\p{L}])/gu)) {
    const start = (match.index ?? 0) + match[1].length;
    add(start, start + match[2].length, `Возможно, нужен пробел после «${match[1]}»`, `Магчыма, патрэбны прабел пасля «${match[1]}»`);
  }
  for (const match of text.matchAll(/([,;:!?])\1+/g)) {
    const start = match.index ?? 0;
    add(start, start + match[0].length, "Повтор знака препинания", "Паўтор знака прыпынку");
  }
  for (const match of text.matchAll(/\b([\p{L}]{2,})\s+\1\b/giu)) {
    const start = match.index ?? 0;
    add(start, start + match[0].length, `Повтор слова «${match[1]}»`, `Паўтор слова «${match[1]}»`);
  }
  for (const match of text.matchAll(/["“”„][^\n"]{1,160}["“”„]/g)) {
    const start = match.index ?? 0;
    add(start, start + match[0].length, "Проверьте кавычки: в обзоре используются « »", "Праверце двукоссе: у аглядзе выкарыстоўваюцца « »");
  }

  const opens = (text.match(/«/g) ?? []).length;
  const closes = (text.match(/»/g) ?? []).length;
  if (opens !== closes) add(0, Math.min(text.length, 1), "Несбалансированные кавычки « »", "Незбалансаванае двукоссе « »");

  const roundOpen = (text.match(/\(/g) ?? []).length;
  const roundClose = (text.match(/\)/g) ?? []).length;
  if (roundOpen !== roundClose) add(0, Math.min(text.length, 1), "Несбалансированные круглые скобки", "Незбалансаваныя круглыя дужкі");

  return issues.slice(0, 60);
}

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
  const [manualItem, setManualItem] = useState({ title: "", source: "", region: "", text: "", url: "", quality: "full" as "full" | "partial" });
  const [importUrl, setImportUrl] = useState("");
  const [urlImportBusy, setUrlImportBusy] = useState(false);
  const [urlImportMessage, setUrlImportMessage] = useState("");
  const [urlImportError, setUrlImportError] = useState("");
  const [clipboardBusy, setClipboardBusy] = useState(false);
  const [bookmarkletOpen, setBookmarkletOpen] = useState(false);
  const [compressionMode, setCompressionMode] = useState<CompressionMode>("auto");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiRuns, setAiRuns] = useState<number | null>(null);
  const [lintIssues, setLintIssues] = useState<EditorialLintIssue[]>([]);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
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
    exportHelp: isLMonitor
      ? (be ? "Фармат паўтарае дасланы ўзор для L-Monitor." : "Формат повторяет присланный образец для L-Monitor.")
      : (be ? "Фармат паўтарае дасланыя ўзоры; пасля кожнага матэрыялу выводзіцца поўны URL публікацыі." : "Формат повторяет присланные образцы; после каждого материала выводится полный URL публикации."),
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
    compressionMinimum: be ? "Мінімальнае 20–30%" : "Минимальное 20–30%",
    compressionStandard: isLMonitor ? (be ? "Стандарт 30–50%" : "Стандарт 30–50%") : (be ? "Стандарт 20–40%" : "Стандарт 20–40%"),
    compressionMaximum: isLMonitor ? (be ? "Максімальная 50–70%" : "Максимальная 50–70%") : (be ? "Максімальная 40–60%" : "Максимальная 40–60%"),
    compressionExtract: isLMonitor ? (be ? "Экстракт 70–90%" : "Экстракт 70–90%") : (be ? "Экстракт 60–80%" : "Экстракт 60–80%"),
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
    importByUrl: be ? "Спампаваць матэрыял" : "Скачать материал",
    importUrlPlaceholder: be ? "Устаўце спасылку на матэрыял…" : "Вставьте ссылку на материал…",
    importUrlHelp: be ? "Спачатку Monitor паспрабуе звычайную загрузку. Для любой іншай крыніцы выкарыстоўвайце «→ Monitor» у браўзеры і «Уставіць з браўзера»." : "Сначала Monitor попробует обычную загрузку. Для любого другого источника используйте «→ Monitor» в браузере и «Вставить из браузера».",
    importUrlDone: be ? "Матэрыял спампаваны. Праверце загаловак, выданне, краіну і тэкст." : "Материал скачан. Проверьте заголовок, издание, страну и текст.",
    browserFallback: be ? "Аўтаматычна атрымаць старонку не ўдалося. Адкрыйце яе ў звычайным браўзеры, націсніце закладку «→ Monitor», затым вярніцеся сюды." : "Автоматически получить страницу не удалось. Откройте её в обычном браузере, нажмите закладку «→ Monitor», затем вернитесь сюда.",
    openBrowser: be ? "Адкрыць у звычайным браўзеры" : "Открыть в обычном браузере",
    browserHelp: be ? "У браўзеры працуюць вашы cookies, уваход, падпіска і VPN. Пасля загрузкі старонкі націсніце «→ Monitor», затым «Уставіць з браўзера»." : "В браузере работают ваши cookies, вход, подписка и VPN. После загрузки страницы нажмите «→ Monitor», затем «Вставить из браузера».",
    importPartial: be ? "Атрымана толькі агульнадаступная частка матэрыялу." : "Получена только общедоступная часть материала.",
    clipboardImport: be ? "Уставіць з браўзера" : "Вставить из браузера",
    clipboardEmpty: be ? "У буферы абмену няма старонкі Monitor." : "В буфере обмена нет страницы Monitor.",
    clipboardDone: be ? "Старонка з браўзера апрацавана і дададзена ў агляд." : "Страница из браузера обработана и добавлена в обзор.",
    bookmarkletHelp: be ? "Як падключыць закладку «→ Monitor»" : "Как подключить закладку «→ Monitor»",
    bookmarkletCopy: be ? "Скапіяваць код закладкі" : "Скопировать код закладки",
    bookmarkletCopied: be ? "Код закладкі скапіяваны. Стварыце новую закладку ў браўзеры і ўстаўце код у поле URL." : "Код закладки скопирован. Создайте новую закладку в браузере и вставьте код в поле URL.",
    manualItemHelp: be ? "Для матэрыялаў па падпісцы або прапушчаных маніторынгам. Устаўце загаловак, выданне і тэкст з браўзера." : "Для материалов по подписке или пропущенных мониторингом. Вставьте заголовок, издание и текст из браузера.",
    manualTitle: be ? "Загаловак" : "Заголовок",
    manualSource: be ? "Крыніца / выданне" : "Источник / издание",
    manualCountry: be ? "Краіна крыніцы" : "Страна источника",
    manualBody: be ? "Зыходны тэкст" : "Исходный текст",
    add: be ? "Дадаць у агляд" : "Добавить в обзор",
  };

  useEffect(() => {
    setManualOpen(false);
    setManualText("");
  }, [active?.documentUid, isLMonitor]);

  useEffect(() => {
    setLintIssues([]);
  }, [active?.documentUid]);

  function runEditorialLint() {
    if (!active) return;
    const issues = lintEditorialText(active.editorialText);
    setLintIssues(issues);
    setError("");
    setStatus(issues.length ? "" : (be ? "Лакальная праверка не знайшла заўваг." : "Локальная проверка не нашла замечаний."));
  }

  function focusLintIssue(issue: EditorialLintIssue) {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    editor.setSelectionRange(issue.start, issue.end);
    const lineHeight = 24;
    const before = active?.editorialText.slice(0, issue.start) ?? "";
    const line = before.split("\n").length - 1;
    editor.scrollTop = Math.max(0, line * lineHeight - editor.clientHeight / 3);
  }

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
    const result = exactCompressForProfile(active.sourceText, compressionMode, isLMonitor ? "l" : "sep");
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

  async function fetchManualByUrl() {
    if (urlImportBusy || !importUrl.trim()) return;
    setUrlImportBusy(true);
    setUrlImportError("");
    setUrlImportMessage("");
    setError("");
    setStatus("");
    try {
      const payload = await desktopApi.fetchKnownSourceArticle(importUrl.trim());
      const uid = report.addManualItem({
        title: payload.title,
        source: payload.source,
        region: payload.region || "",
        text: payload.text,
        url: payload.url,
        quality: payload.quality,
      });
      setActiveUid(uid);
      setImportUrl("");
      setManualItemOpen(false);
      setUrlImportMessage(payload.quality === "partial" ? `${tx.importUrlDone} ${tx.importPartial}` : tx.importUrlDone);
    } catch (reason) {
      setUrlImportError(String(reason));
    } finally {
      setUrlImportBusy(false);
    }
  }

  async function pasteManualFromClipboard() {
    if (clipboardBusy) return;
    setClipboardBusy(true);
    setError("");
    setStatus("");
    setUrlImportError("");
    try {
      const raw = (await desktopApi.readClipboardText()).trim();
      if (!raw) throw new Error("BROWSER_CAPTURE_INVALID");
      const capture = parseBrowserCapture(raw);
      let resolvedSource: { source: string; region: string | null; url: string } | null = null;
      try {
        resolvedSource = await desktopApi.resolveKnownSource(capture.url);
      } catch {
        // Browser import must also work for publications absent from the local
        // monitoring catalogue. The catalogue enriches metadata; it is not an
        // allow-list for a page the user explicitly opened and captured.
      }
      const capturedUrl = new URL(capture.url);
      const host = capturedUrl.hostname.replace(/^www\./i, "");
      const fallbackSource = (capture.siteName || host).trim();
      const fallbackRegion = /(?:^|\.)by$/i.test(host) ? "Беларусь" : "";
      const uid = report.addManualItem({
        title: capture.title || resolvedSource?.source || fallbackSource,
        source: resolvedSource?.source || fallbackSource,
        region: resolvedSource?.region || fallbackRegion,
        text: capture.text,
        url: resolvedSource?.url || capture.url,
        quality: "full",
      });
      setActiveUid(uid);
      setImportUrl("");
      setManualItemOpen(false);
      setUrlImportMessage(tx.clipboardDone);
    } catch (reason) {
      const message = String(reason);
      if (message.includes("BROWSER_CAPTURE_INVALID")) {
        setUrlImportError(be ? "Буфер не змяшчае старонку, перададзеную закладкай «→ Monitor»." : "В буфере нет страницы, переданной закладкой «→ Monitor».");
      } else if (message.includes("BROWSER_CAPTURE_TOO_LARGE")) {
        setUrlImportError(be ? "Старонка занадта вялікая для імпарту праз буфер." : "Страница слишком большая для импорта через буфер.");
      } else if (message.includes("BROWSER_CAPTURE_READABILITY_EMPTY")) {
        setUrlImportError(be ? "Readability не змог вылучыць асноўны тэкст. Выкарыстоўвайце ручную ўстаўку." : "Readability не смог выделить основной текст. Используйте ручную вставку.");
      } else {
        setUrlImportError(message);
      }
    } finally {
      setClipboardBusy(false);
    }
  }

  async function copyBookmarklet() {
    try {
      await desktopApi.writeClipboardText(MONITOR_BOOKMARKLET);
      setError("");
      setStatus(tx.bookmarkletCopied);
    } catch (reason) {
      setError(String(reason));
    }
  }

  function addManualReportItem() {
    if (!manualItem.title.trim() || !manualItem.text.trim()) return;
    try {
      const uid = report.addManualItem(manualItem);
      setActiveUid(uid);
      setManualItem({ title: "", source: "", region: "", text: "", url: "", quality: "full" });
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
      defaultPath: isLMonitor
        ? `Дополнения в обзор СМИ_${safeFilenameDate(report.date)}.docx`
        : `Обзор_критических_материалов_${safeFilenameDate(report.date)}.docx`,
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
    <section className="report-toolbar panel"><div><b>{tx.count}: {report.items.length}{report.maxItems !== null ? `/${report.maxItems}` : ""}</b>{tx.tooFew && <span>{tx.tooFew}</span>}</div><div><button className="secondary-button" disabled={clipboardBusy} onClick={pasteManualFromClipboard}>{clipboardBusy ? "…" : tx.clipboardImport}</button><button className="secondary-button" onClick={() => setManualItemOpen((value) => !value)}>{tx.addManualItem}</button><span>{tx.exportHelp}</span>{report.items.length > 0 && <button className="ghost-button" onClick={() => { if (window.confirm(tx.clear + "?")) report.clear(); }}>{tx.clear}</button>}</div></section>
    {<section className="panel report-url-import"><div><b>{tx.importByUrl}</b><span>{tx.importUrlHelp}</span></div><div className="report-url-import-row"><input value={importUrl} onChange={(e) => { setImportUrl(e.target.value); setUrlImportError(""); setUrlImportMessage(""); }} placeholder={tx.importUrlPlaceholder} onKeyDown={(e) => { if (e.key === "Enter") void fetchManualByUrl(); }} /><button className="primary-button" disabled={!importUrl.trim() || urlImportBusy} onClick={fetchManualByUrl}>{urlImportBusy ? "…" : tx.importByUrl}</button></div>{urlImportBusy && <div className="report-url-inline pending">{be ? "Загрузка і вылучэнне асноўнага тэксту…" : "Загрузка и извлечение основного текста…"}</div>}{urlImportMessage && <div className="report-url-inline success">{urlImportMessage}</div>}{urlImportError && <div className="report-url-inline error"><div>{urlImportError}</div><div className="report-url-browser-actions"><button className="secondary-button small-button" disabled={!importUrl.trim()} onClick={() => void desktopApi.openUrl(importUrl.trim())}>{tx.openBrowser}</button><button className="primary-button small-button" disabled={clipboardBusy} onClick={() => void pasteManualFromClipboard()}>{clipboardBusy ? "…" : tx.clipboardImport}</button><span>{tx.browserHelp}</span></div></div>}<div className="report-bookmarklet-toggle"><button className="ghost-button small-button" onClick={() => setBookmarkletOpen((value) => !value)}>{tx.bookmarkletHelp}</button></div>{bookmarkletOpen && <div className="report-bookmarklet-help"><b>→ Monitor</b><p>{be ? "1. Пакажыце панэль закладак Ctrl+Shift+B. 2. Стварыце новую закладку з назвай «→ Monitor». 3. Скапіруйце код ніжэй і ўстаўце яго ў поле URL закладкі. Пасля гэтага на любой адкрытай публікацыі дастаткова націснуць гэтую закладку." : "1. Покажите панель закладок Ctrl+Shift+B. 2. Создайте новую закладку с именем «→ Monitor». 3. Скопируйте код ниже и вставьте его в поле URL закладки. После этого на любой открытой публикации достаточно нажать эту закладку."}</p><button className="secondary-button small-button" onClick={() => void copyBookmarklet()}>{tx.bookmarkletCopy}</button></div>}</section>}
    {manualItemOpen && <section className="panel report-add-manual"><div><b>{tx.addManualItem}</b><p>{tx.manualItemHelp}</p>{manualItem.quality === "partial" && <p className="report-import-partial">{tx.importPartial}</p>}</div><div className="report-add-manual-grid"><label>{tx.manualTitle}<input value={manualItem.title} onChange={(e) => setManualItem({ ...manualItem, title: e.target.value })} /></label><label>{tx.manualSource}<input value={manualItem.source} onChange={(e) => setManualItem({ ...manualItem, source: e.target.value })} /></label><label>{tx.manualCountry}<input value={manualItem.region} onChange={(e) => setManualItem({ ...manualItem, region: e.target.value })} /></label></div><label className="report-add-manual-text">{tx.manualBody}<textarea value={manualItem.text} onChange={(e) => setManualItem({ ...manualItem, text: e.target.value })} /></label><div className="report-add-manual-actions"><button className="primary-button" disabled={!manualItem.title.trim() || !manualItem.text.trim()} onClick={addManualReportItem}>{tx.add}</button><button className="ghost-button" onClick={() => setManualItemOpen(false)}>{tx.cancel}</button></div></section>}
    {!report.items.length ? <section className="panel empty-state report-empty">{tx.empty}</section> : <section className="report-workspace-grid">
      <aside className="panel report-basket">{report.items.map((item, index) => <article key={item.documentUid} className={active?.documentUid === item.documentUid ? "active" : ""} onClick={() => setActiveUid(item.documentUid)}><div className="report-basket-number">{index + 1}</div><div><div className="report-basket-source-row"><b>{item.source}</b><span className={`report-text-status ${item.sourceQuality}`} title={qualityLabel(item)}><i />{qualityShort(item)}</span></div><span>{item.title}</span></div><div className="report-order-actions"><button disabled={index === 0} onClick={(e) => { e.stopPropagation(); report.move(item.documentUid, -1); }}>{tx.up}</button><button disabled={index === report.items.length - 1} onClick={(e) => { e.stopPropagation(); report.move(item.documentUid, 1); }}>{tx.down}</button><button className="text-danger" onClick={(e) => { e.stopPropagation(); report.remove(item.documentUid); }}>{tx.remove}</button></div></article>)}</aside>
      {active && <article className="panel report-editor"><div className="report-editor-head"><div><span className="source-chip">{active.source}</span><h3>{active.title}</h3><p>{[active.locality, active.region].filter(Boolean).join(" · ")}</p></div>{active.url && <button className="link-button" onClick={() => desktopApi.openUrl(active.url)}>{tx.open}</button>}</div>
        <details className={`report-source-details quality-${active.sourceQuality}`} open><summary><span>{tx.original} · {qualityLabel(active)}</span><span className={`report-text-status ${active.sourceQuality}`}><i />{qualityShort(active)}</span></summary><div className="report-source-text">{active.sourceText}</div></details>
        {active.sourceQuality !== "full" && <div className="report-source-warning"><div><b>{qualityLabel(active)}</b><p>{tx.needsReview}</p></div><button className="secondary-button small-button" onClick={() => { setManualOpen((value) => !value); if (!manualText) setManualText(""); }}>{active.sourceQuality === "partial" ? tx.replaceFull : tx.pasteFull}</button></div>}
        {manualOpen && active.sourceQuality !== "full" && <div className="report-manual-source"><p>{tx.pasteHelp}</p><textarea value={manualText} onChange={(e) => setManualText(e.target.value)} placeholder={tx.pastePlaceholder} /><div><button className="primary-button small-button" disabled={!manualText.trim()} onClick={saveManualFullText}>{tx.saveManual}</button><button className="ghost-button small-button" onClick={() => { setManualOpen(false); setManualText(""); }}>{tx.cancel}</button></div></div>}
        <div className={`report-compression-panel ${active.sourceQuality !== "full" ? "disabled" : ""}`}>
          <div className="report-compression-head"><div><b>{isLMonitor ? tx.exact : tx.compression}</b><span>{isLMonitor ? tx.exactHelp : tx.aiHelp}</span></div><label><select value={compressionMode} onChange={(e) => setCompressionMode(e.target.value as CompressionMode)} disabled={active.sourceQuality !== "full" || aiBusy}><option value="auto">{tx.compressionAuto}</option>{isLMonitor && <option value="light">{tx.compressionMinimum}</option>}<option value="standard">{tx.compressionStandard}</option><option value="maximum">{tx.compressionMaximum}</option><option value="extract">{tx.compressionExtract}</option></select></label></div>
          <div className="report-compression-actions"><button className="secondary-button small-button" disabled={active.sourceQuality !== "full" || aiBusy} onClick={applyExactCompression}>{tx.exact}</button>{!isLMonitor && <button className="primary-button small-button" disabled={active.sourceQuality !== "full" || aiBusy || aiLimitReached || aiRuns === null} onClick={applyAiCompression}>{aiBusy ? tx.aiRunning : tx.ai}</button>}<span>{be ? "Бягучае скарачэнне" : "Текущее сокращение"}: {compressionReduction(active.sourceText, active.editorialText)}%</span>{!isLMonitor && <span>{tx.aiLimit}: {aiRuns ?? "…"}/{MAX_AI_COMPRESSION_RUNS}</span>}</div>
          {active.sourceQuality !== "full" && <p>{tx.compressionNeedsFull}</p>}
          {!isLMonitor && maximumMode && <p>{tx.aiMaximumHelp}</p>}
          {!isLMonitor && extractMode && <p>{tx.aiExtractHelp}</p>}
          {!isLMonitor && aiLimitReached && <p>{tx.aiLimitReached}</p>}
        </div>
        <div className="report-editor-label"><b>{tx.editorial}</b><div><span className="report-text-length">{active.editorialText.length.toLocaleString()} {be ? "сімвалаў" : "символов"} · {active.editorialText.split(/\\n+/).filter(Boolean).length} {be ? "абзацаў" : "абзацев"}</span><button className="ghost-button small-button" onClick={runEditorialLint}>{be ? "Праверыць тэкст" : "Проверить текст"}</button><button className="ghost-button small-button" onClick={() => report.resetText(active.documentUid)}>{tx.reset}</button>{active.excerpt && <button className="ghost-button small-button" onClick={() => report.useExcerpt(active.documentUid)}>{tx.useExcerpt}</button>}</div></div>
        <div className="report-editorial-compose"><div className="report-editorial-compose-title">{active.title}</div><textarea ref={editorRef} className="report-editor-textarea" lang={be ? "be" : "ru"} spellCheck={true} value={active.editorialText} onChange={(e) => { report.updateText(active.documentUid, e.target.value); if (lintIssues.length) setLintIssues([]); }} /><div className="report-editorial-tail-hint">{be ? "Арфаграфія правяраецца сродкамі WebView2. Перад экспартам праверце канец тэксту." : "Орфография проверяется средствами WebView2. Перед экспортом проверьте конец текста."}</div></div>
        {lintIssues.length > 0 && <div className="report-lint-panel"><div className="report-lint-head"><b>{be ? `Заўвагі: ${lintIssues.length}` : `Замечания: ${lintIssues.length}`}</b><span>{be ? "Націсніце на заўвагу, каб перайсці да месца ў тэксце." : "Нажмите на замечание, чтобы перейти к месту в тексте."}</span></div><div className="report-lint-list">{lintIssues.map((issue)=><button key={issue.id} type="button" onClick={()=>focusLintIssue(issue)}><b>{be ? issue.messageBe : issue.messageRu}</b><span>{issue.excerpt}</span></button>)}</div></div>}
        {lintIssues.length === 0 && status === "__lint_clean__" && null}
      </article>}
    </section>}
  </div>;
}
