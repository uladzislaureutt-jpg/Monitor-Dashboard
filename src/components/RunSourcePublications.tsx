import { useEffect, useMemo, useRef, useState } from "react";
import { desktopApi } from "../api";
import { useI18n } from "../i18n";
import type { RunPublication, RunSummary } from "../types";

type Feed = "all" | "github" | "assistant1" | "assistant2";

function publicationCountry(item: RunPublication) {
  return item.country?.trim() || null;
}

export function RunSourcePublications({ github, assistants = [] }: { github?: RunSummary; assistants?: (RunSummary | undefined)[] }) {
  const { locale } = useI18n();
  const be = locale === "be";
  const [feed, setFeed] = useState<Feed>("all");
  const label = (run: RunSummary | undefined, id: number) => id > 0
    ? `${be ? "Памочнік" : "Помощник"} ${id} №${run?.collectorNumber ?? "—"}`
    : `GitHub №${run?.runNumber ?? "—"}`;
  const streams = [
    { key: "github", run: github, label: label(github, 0) },
    { key: "assistant1", run: assistants[0], label: label(assistants[0], 1) },
    { key: "assistant2", run: assistants[1], label: label(assistants[1], 2) },
  ];
  const selected = feed;
  const chosen = streams.filter(stream => selected === "all" || selected === stream.key);
  const signature = chosen.filter(stream => stream.run).map(stream => `${stream.run!.id}:${stream.run!.importedAt}`).join("|");
  const [items, setItems] = useState<RunPublication[]>([]);
  const [loading, setLoading] = useState(Boolean(github || assistants.some(Boolean)));
  const [error, setError] = useState("");
  const [linkError, setLinkError] = useState("");
  const [selectedCountries, setSelectedCountries] = useState<(string | null)[]>([]);
  const [countryMenuOpen, setCountryMenuOpen] = useState(false);
  const [countryQuery, setCountryQuery] = useState("");
  const countryMenu = useRef<HTMLDivElement>(null);
  const countryTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const ids = signature.split("|").filter(Boolean).map(entry => Number(entry.split(":")[0]));
    if (!ids.length) {
      setItems([]);
      setLoading(false);
      return;
    }
    let revision = 0;
    const reload = () => {
      const request = ++revision;
      setLoading(true);
      setError("");
      void Promise.all(ids.map((id) => desktopApi.lMonitorRunPublications(id))).then((next) => {
        if (request === revision) setItems([...new Map(next.flat().map((item) => [item.id, item])).values()]);
      }).catch((reason) => {
        if (request === revision) setError(String(reason));
      }).finally(() => {
        if (request === revision) setLoading(false);
      });
    };
    reload();
    window.addEventListener("monitor:moderation-changed", reload);
    return () => {
      revision += 1;
      window.removeEventListener("monitor:moderation-changed", reload);
    };
  }, [signature]);

  useEffect(() => {
    if (!countryMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (countryMenu.current && !countryMenu.current.contains(event.target as Node)) setCountryMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [countryMenuOpen]);

  const countryFilterLabel = be ? "Краіны крыніц" : "Страны источников";
  const allCountries = be ? "Усе краіны" : "Все страны";
  const unknownCountry = be ? "Краіна не пазначана" : "Страна не указана";
  const countryOptions = useMemo(() => {
    const countries = new Set([...items.map(publicationCountry), ...selectedCountries]);
    return [...countries].sort((left, right) => (left ?? unknownCountry).localeCompare(right ?? unknownCountry, locale));
  }, [items, selectedCountries, locale, unknownCountry]);
  const countryNeedle = countryQuery.trim().toLocaleLowerCase(locale);
  const visibleCountries = countryOptions.filter(country =>
    (country ?? unknownCountry).toLocaleLowerCase(locale).includes(countryNeedle));
  const countrySelectionLabel = selectedCountries.length === 0 ? allCountries
    : selectedCountries.length === 1 ? selectedCountries[0] ?? unknownCountry
    : `${be ? "Выбрана" : "Выбрано"} ${selectedCountries.length}`;

  const sources = useMemo(() => {
    const groups = new Map<string, { source: string; country: string | null; publications: RunPublication[] }>();
    const allowed = new Set(selectedCountries);
    for (const item of items) {
      const country = publicationCountry(item);
      if (allowed.size && !allowed.has(country)) continue;
      const source = item.source ?? (be ? "Невядомая крыніца" : "Неизвестный источник");
      const key = JSON.stringify([source, country]);
      const group = groups.get(key);
      if (group) group.publications.push(item);
      else groups.set(key, { source, country, publications: [item] });
    }
    return [...groups].sort(([, left], [, right]) =>
      right.publications.length - left.publications.length || left.source.localeCompare(right.source, locale));
  }, [items, selectedCountries, be, locale]);
  const run = selected === "all" ? undefined : chosen[0]?.run;
  const runDate = run ? new Date(run.startedAt ?? run.importedAt) : null;
  const dateLabel = runDate && Number.isFinite(runDate.valueOf()) ? runDate.toLocaleDateString(be ? "be-BY" : "ru-RU") : "";
  const runLabel = chosen[0]?.label;

  return <section className="panel run-source-panel" aria-labelledby="run-source-heading" aria-busy={loading}>
    <div className="panel-head">
      <div>
        <h3 id="run-source-heading">{be ? "Публікацыі ў крыніцах" : "Публикации в источниках"}</h3>
        {run && <p>{[runLabel, dateLabel].filter(Boolean).join(" · ")}</p>}
        {selected === "all" && <p>{streams.filter(stream => stream.run).map(stream => stream.label).join(" · ")}</p>}
      </div>
      <div className="run-source-filters">
        {<div className="run-source-feed-filter"><select className="run-source-filter-control"
          aria-label={be ? "Паток публікацый" : "Поток публикаций"} value={selected}
          onChange={(event) => setFeed(event.target.value as Feed)}>
          <option value="all">{be ? "Агульны паток" : "Общий поток"}</option>
          {streams.map(stream => <option key={stream.key} value={stream.key} disabled={!stream.run}>{stream.label}</option>)}
        </select></div>}
        {countryOptions.length > 0 && <div className="source-multiselect run-source-country-filter" ref={countryMenu}
          onKeyDown={event => {
            if (event.key !== "Escape" || !countryMenuOpen) return;
            event.stopPropagation();
            setCountryMenuOpen(false);
            countryTrigger.current?.focus();
          }}>
          <button type="button" ref={countryTrigger}
            className="run-source-filter-control run-source-country-trigger"
            aria-label={`${countryFilterLabel} · ${countrySelectionLabel}`}
            title={countrySelectionLabel}
            aria-expanded={countryMenuOpen} aria-controls="run-source-countries"
            onClick={() => {
              if (!countryMenuOpen) setCountryQuery("");
              setCountryMenuOpen(!countryMenuOpen);
            }}>
            <span>{countrySelectionLabel}</span>
          </button>
          {countryMenuOpen && <div id="run-source-countries" className="source-multiselect-menu" role="group"
            aria-label={countryFilterLabel}>
            <div className="source-multiselect-actions">
              <button type="button" onClick={() => { setSelectedCountries([]); setCountryQuery(""); }}>{allCountries}</button>
            </div>
            <div className="source-multiselect-search">
              <span aria-hidden="true">⌕</span>
              <input autoFocus value={countryQuery} onChange={event => setCountryQuery(event.target.value)}
                aria-label={be ? "Знайсці краіну" : "Найти страну"} placeholder={be ? "Знайсці краіну" : "Найти страну"} />
            </div>
            <div className="source-multiselect-options">
              {visibleCountries.length === 0 && <p>{be ? "Краіны не знойдзены" : "Страны не найдены"}</p>}
              {visibleCountries.map(country => <label key={country ?? ""}>
                <input type="checkbox" checked={selectedCountries.includes(country)} onChange={event => {
                  const checked = event.target.checked;
                  setSelectedCountries(current => checked ? [...current, country] : current.filter(value => value !== country));
                }} />
                <span>{country ?? unknownCountry}</span>
              </label>)}
            </div>
          </div>}
        </div>}
      </div>
    </div>
    {linkError && <div className="notice error" role="alert">{linkError}</div>}
    {loading ? <div className="chart-empty">{be ? "Загрузка публікацый…" : "Загрузка публикаций…"}</div>
      : error ? <div className="notice error" role="alert">{error}</div>
        : !sources.length ? <div className="chart-empty" role="status">{selectedCountries.length
          ? (be ? "Няма публікацый з выбраных краін" : "Нет публикаций из выбранных стран")
          : github || assistants.some(Boolean) ? (be ? "У гэтым запуску няма публікацый" : "В этом прогоне нет публикаций")
            : (be ? "Запускаў пакуль няма" : "Прогоны ещё не загружены")}</div>
          : <div className="run-source-list">{sources.map(([key, { source, country, publications }]) => <details key={key}>
            <summary><span aria-hidden="true" className="run-source-chevron">›</span>
              <span className="run-source-name"><strong>{source}</strong>{country && <small>{country}</small>}</span>
              <span className="run-source-count">{publications.length}</span>
            </summary>
            <ul>{publications.map((item) => <li key={item.id}>
              {/^https?:\/\//i.test(item.url) ? <a href={item.url} onClick={(event) => {
                event.preventDefault();
                setLinkError("");
                void desktopApi.openUrl(item.url).catch((reason) => setLinkError(String(reason)));
              }}>{item.title} <span aria-hidden="true">↗</span></a> : item.title}
            </li>)}</ul>
          </details>)}</div>}
  </section>;
}
