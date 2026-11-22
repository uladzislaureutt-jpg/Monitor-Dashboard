import type { EventEntry, EventRun } from "./eventTrace";

type Locale = "ru" | "be";
export type ReportPart = { text: string; url?: string };
export type ReportTable = { headers: string[]; widths: number[]; rows: ReportPart[][][] };
export type ReportSection = { heading: string; paragraphs: ReportPart[][]; table?: ReportTable };
export type EventReport = { title: string; metadata: Array<[string, string]>; sections: ReportSection[] };

function dateLabel(value: string | null | undefined, locale: Locale, dayOnly = false) {
  if (!value) return locale === "be" ? "Дата не пацверджаная" : "Дата не подтверждена";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split("-").reverse().join(".");
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return locale === "be" ? "Дата не пацверджаная" : "Дата не подтверждена";
  return new Intl.DateTimeFormat(locale === "be" ? "be-BY" : "ru-RU", {
    timeZone: "Europe/Minsk", dateStyle: "short", ...(dayOnly ? {} : { timeStyle: "short" }),
  }).format(time);
}

export function makeEventReport(run: EventRun, locale: Locale): EventReport {
  const tr = (ru: string, be: string) => locale === "be" ? be : ru;
  const result = run.result;
  const entries = result?.entries ?? [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const earliest = result?.earliestId ? byId.get(result.earliestId) : undefined;
  const official = entries.find((entry) => entry.originKind === "official" && entry.access !== "metadata" && !entry.outsideWindow && entry.published);
  const cited = new Set(result?.citedSourceIds);
  const scoped = entries.filter((entry) => !entry.outsideWindow);
  const evidence = result?.observations ?? [];
  const text = (value: string): ReportPart => ({ text: value });
  const link = (entry: EventEntry, label = entry.publisher): ReportPart => ({ text: label, url: entry.url });
  const sourceList = (ids: string[]) => ids.flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [text(" · "), link(entry)] : [];
  });
  const regions = new Intl.DisplayNames([locale === "be" ? "be" : "ru"], { type: "region" });
  const country = (code: string) => regions.of(code) || code;
  const describe = (entry: EventEntry): string => [
    entry.originKind === "official" ? tr("Официальное сообщение", "Афіцыйнае паведамленне")
      : entry.citations.length ? tr("Публикация со ссылкой", "Публікацыя са спасылкай")
      : tr("Сообщение редакции", "Паведамленне рэдакцыі"),
    cited.has(entry.id) ? tr("На материал ссылаются", "На матэрыял спасылаюцца") : "",
    entry.outsideWindow ? tr("Вне периода", "Па-за перыядам") : "",
  ].filter(Boolean).join(" · ");
  const access = (entry: EventEntry) => entry.access === "readable" ? tr("Текст доступен", "Тэкст даступны")
    : entry.access === "lead" ? tr("Заголовок и лид", "Загаловак і лід") : tr("Только метаданные", "Толькі метаданыя");
  const named = (entry: EventEntry) => entry.namedSources?.length
    ? [text(" · " + tr("Названный источник", "Названая крыніца") + " — " + entry.namedSources.join(", "))] : [];
  const range = run.options.from || run.options.through
    ? run.options.from === run.options.through ? dateLabel(run.options.from, locale)
      : `${run.options.from ? dateLabel(run.options.from, locale) : "…"} — ${run.options.through ? dateLabel(run.options.through, locale) : "…"}`
    : tr("По условиям запроса", "Паводле ўмоў запыту");
  const date = (value?: string | null) => dateLabel(value, locale);
  const makeEvidence = (p: typeof evidence[number]): ReportPart[] => [
    text("«" + p.excerpt + "»"), ...sourceList([p.sourceId]),
  ];
  const summary: ReportPart[][] = [];
  if (earliest) {
    summary.push([text(tr("Самая ранняя найденная публикация с подтверждённой датой", "Самая ранняя знойдзеная публікацыя з пацверджанай датай") + " — "),
      link(earliest), text(" · " + date(earliest.published))]);
    if (scoped.some((entry) => entry.id !== earliest.id && entry.published &&
        (entry.published.length === 10 || earliest.published?.length === 10) &&
        dateLabel(entry.published, locale, true) === dateLabel(earliest.published, locale, true))) {
      summary.push([text(tr("У части публикаций за этот день известно только число. Их порядок внутри дня не установлен.",
        "Для часткі публікацый за гэты дзень вядомая толькі дата. Іх парадак цягам дня не ўстаноўлены."))]);
    }
  }
  if (official) summary.push([text(tr("Самое раннее найденное официальное сообщение", "Самае ранняе знойдзенае афіцыйнае паведамленне") + " — "),
    link(official), text(" · " + date(official.published))]);
  if (result?.summary) summary.push([text(result.summary), ...sourceList(result.summarySources ?? [])]);
  if (!summary.length) summary.push([text(tr("Датированный первоисточник пока не установлен.", "Датаваная першакрыніца пакуль не ўстаноўлена."))]);

  const dates = (entry: EventEntry): ReportPart[] => [
    text(date(entry.published)),
    ...(entry.updated && entry.updated !== entry.published ? [text(" · " + tr("Обновлено", "Абноўлена") + " " + date(entry.updated))] : []),
  ];
  const groups = new Map<string, EventEntry[]>();
  for (const entry of scoped) {
    if (entry.access === "metadata" || !entry.country || !/^[A-Z]{2}$/.test(entry.country)) continue;
    groups.set(entry.country, [...(groups.get(entry.country) || []), entry]);
  }
  const unavailable = entries.filter((entry) => entry.access === "metadata").length;
  const undated = entries.filter((entry) => !entry.published).length;
  const direct = entries.filter((entry) => entry.citations.length);
  const selected = new Map(evidence.filter((p) => p.kind !== "disputed").map((p) => [p.sourceId, p.excerpt]));
  const verified: ReportPart[][] = evidence.filter((p) => p.kind !== "disputed").map(makeEvidence);
  if (!verified.length) {
    for (const entry of [official, earliest].filter((entry, i, values): entry is EventEntry => Boolean(entry && values.indexOf(entry) === i))) {
      verified.push([link(entry, entry.title), text(" · " + describe(entry) + " · " + access(entry))]);
    }
  }
  if (!verified.length) verified.push([text(tr("Доступных материалов недостаточно, чтобы подтвердить детали.", "Даступных матэрыялаў недастаткова, каб пацвердзіць дэталі."))]);
  const openChecks: ReportPart[][] = evidence.filter((p) => p.kind === "disputed").map(makeEvidence);
  if (unavailable || undated) openChecks.push([text(tr(
    `Доступны только метаданные для ${unavailable} публикаций. Дата не подтверждена у ${undated}.`,
    `Даступныя толькі метаданыя для ${unavailable} публікацый. Дата не пацверджаная ў ${undated}.`))]);
  const failures = scoped.filter((entry) => entry.issue).slice(0, 5);
  for (const entry of failures) {
    const reason = entry.issue === "redirect_home" ? tr("ссылка ведёт на главную", "спасылка вядзе на галоўную")
      : entry.issue === "timeout" ? tr("истекло время загрузки", "скончыўся час загрузкі")
      : tr("страница недоступна", "старонка недаступная");
    openChecks.push([link(entry, entry.title), text(" · " + reason)]);
  }
  if (!openChecks.length) openChecks.push([text(tr("В проверенных материалах явные расхождения не выделены.", "У правераных матэрыялах яўныя разыходжанні не вылучаныя."))]);
  const conclusions: ReportPart[][] = [];
  if (earliest) conclusions.push([text(tr("Для хронологии отправная точка — ", "Для храналогіі зыходны пункт — ")), link(earliest, earliest.title), text(".")]);
  if (official && official.id !== earliest?.id) conclusions.push([text(tr("Для официальной позиции — ", "Для афіцыйнай пазіцыі — ")), link(official, official.title), text(".")]);
  if (direct.length) {
    const referenced = entries.filter((entry) => cited.has(entry.id)).slice(0, 4);
    conclusions.push([text(tr("По прямым ссылкам установлена цепочка с участием ", "Паводле прамых спасылак вызначаны ланцуг з удзелам ")),
      ...referenced.flatMap((entry, i) => [...(i ? [text(", ")] : []), link(entry)]), text(".")]);
  }
  if (!conclusions.length) conclusions.push([text(tr("Первоисточник и цепочка распространения требуют проверки.", "Першакрыніца і ланцуг распаўсюджання патрабуюць праверкі."))]);
  return {
    title: run.task,
    metadata: [[tr("Период мониторинга", "Перыяд маніторынгу"), range],
      [tr("Контрольный момент", "Кантрольны момант"), date(result?.checkedAt || run.updated_at || run.created_at)],
      [tr("Базовая часовая зона", "Базавы часавы пояс"), tr("Минск (UTC+3)", "Мінск (UTC+3)")]],
    sections: [
      { heading: tr("Резюме", "Рэзюмэ"), paragraphs: summary },
      { heading: tr("1. Что подтверждено", "1. Што пацверджана"), paragraphs: verified },
      { heading: tr("2. Хронология распространения", "2. Храналогія распаўсюджання"), paragraphs: [], table: {
        headers: [tr("Время", "Час"), tr("Страна и издание", "Краіна і выданне"), tr("Роль", "Роля"),
          tr("Что добавилось", "Што дадалося"), tr("Откуда сведения", "Адкуль звесткі")],
        widths: [14, 18, 16, 25, 27],
        rows: entries.map((entry) => [
          dates(entry),
          [...(entry.country && /^[A-Z]{2}$/.test(entry.country) ? [text(country(entry.country) + " · ")] : []), link(entry)],
          [text(describe(entry))],
          [link(entry, entry.title), ...(selected.has(entry.id) ? [text(" · «" + selected.get(entry.id) + "»")] : [])],
          entry.citations.length ? entry.citations.flatMap((citation, index) => {
            const source = byId.get(citation.sourceId);
            return source ? [...(index ? [text(" · ")] : []), link(source), text(" — «" + citation.evidence + "»")] : [];
          }) : [text(entry.originKind === "official" ? tr("Канал ведомства или официальный сайт", "Канал ведамства або афіцыйны сайт")
            : tr("Прямая атрибуция не установлена", "Прамая атрыбуцыя не ўстаноўленая")), ...named(entry)],
        ]),
      } },
      { heading: tr("3. География освещения", "3. Геаграфія асвятлення"), paragraphs: groups.size ?
        Array.from(groups).map(([code, list]) => [text(country(code) + " — "), ...list.slice(0, 5).flatMap((entry, i) =>
          [...(i ? [text(", ")] : []), link(entry), ...(entry.citations.length ? [text(" (" + tr("со ссылкой", "са спасылкай") + ")")] : [])])])
        : [[text(tr("Страны доступных источников пока не определены.", "Краіны даступных крыніц пакуль не вызначаныя."))]] },
      { heading: tr("4. Изменения и спорные версии", "4. Змены і спрэчныя версіі"), paragraphs: openChecks },
      { heading: tr("5. Выводы", "5. Высновы"), paragraphs: conclusions },
      { heading: tr("Приложение. Реестр источников", "Дадатак. Рэестр крыніц"), paragraphs: [], table: {
        headers: [tr("Издание", "Выданне"), tr("Публикация", "Публікацыя"), tr("Дата и время", "Дата і час"), tr("Примечание", "Заўвага")],
        widths: [17, 37, 18, 28],
        rows: entries.map((entry) => [[link(entry)], [link(entry, entry.title)], dates(entry),
          [text([describe(entry), access(entry), entry.publicationEvidence].filter(Boolean).join(" · "))]]),
      } },
    ],
  };
}
