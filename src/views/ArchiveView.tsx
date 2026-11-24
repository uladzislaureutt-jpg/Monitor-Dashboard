import { useEffect, useMemo, useRef, useState } from "react";
import { desktopApi } from "../api";
import { cachedFacets, cachedPage, facetsFresh, pageFresh, invalidateArchiveCache, saveFacets, savePage } from "../archiveCache";
import type { ArchiveFacets, ArchivePage, PeriodDays } from "../types";
import { useI18n } from "../i18n";
import { PublicationCard } from "../components/PublicationCard";
import { PeriodSelector } from "../components/PeriodSelector";
import { localizeDataLabel } from "../dataLabels";

const EMPTY_FACETS: ArchiveFacets = { categories: [], regions: [], sources: [] };

export function ArchiveView({ initialQuery = "", monitorKey }: { initialQuery?: string; monitorKey: string }) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState(initialQuery);
  const [period, setPeriod] = useState<PeriodDays>(30);
  const [category, setCategory] = useState("");
  const [region, setRegion] = useState("");
  const [sources, setSources] = useState<string[]>([]);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [sourceSearch, setSourceSearch] = useState("");
  const sourceMenuRef = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<"newest" | "oldest" | "score">("newest");
  const [facets, setFacets] = useState<ArchiveFacets>(() => cachedFacets(monitorKey) ?? EMPTY_FACETS);
  const [page, setPage] = useState<ArchivePage>(() => cachedPage(monitorKey, { query: initialQuery, periodDays: 30, limit: 30, offset: 0 }) ?? { total: 0, items: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const [moderationVersion, setModerationVersion] = useState(0);
  const pageSize = 30;

  useEffect(() => { setQuery(initialQuery); setOffset(0); }, [initialQuery]);
  useEffect(() => {
    const changed = () => { invalidateArchiveCache(monitorKey, true); setModerationVersion((value) => value + 1); };
    const updated = (event: Event) => {
      if ((event as CustomEvent<{ monitorKey: string }>).detail?.monitorKey === monitorKey) {
        invalidateArchiveCache(monitorKey);
        setModerationVersion((value) => value + 1);
      }
    };
    window.addEventListener("monitor:moderation-changed", changed);
    window.addEventListener("monitor:data-updated", updated);
    return () => {
      window.removeEventListener("monitor:moderation-changed", changed);
      window.removeEventListener("monitor:data-updated", updated);
    };
  }, [monitorKey]);
  useEffect(() => {
    const saved = cachedFacets(monitorKey);
    if (saved) { setFacets(saved); if (facetsFresh(monitorKey)) return; }
    let cancelled = false;
    desktopApi.archiveFacetsFor(monitorKey)
      .then((result) => { if (!cancelled) { saveFacets(monitorKey, result); setFacets(result); } })
      .catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [monitorKey, moderationVersion]);
  useEffect(() => {
    const options = { monitorKey, query, periodDays: period, category, region, sources, sort, limit: pageSize, offset };
    const saved = cachedPage(monitorKey, options);
    if (saved) { setPage(saved); if (pageFresh(monitorKey, options)) { setLoading(false); return; } }
    let cancelled = false;
    setLoading(!saved);
    const timer = window.setTimeout(() => {
      desktopApi.archive(options)
        .then((result) => { if (!cancelled) { savePage(monitorKey, options, result); setPage(result); setError(""); } })
        .catch((reason) => { if (!cancelled) setError(String(reason)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, query.trim() ? 250 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [monitorKey, query, period, category, region, sources, sort, offset, moderationVersion]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (sourceMenuRef.current && !sourceMenuRef.current.contains(event.target as Node)) setSourceMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);

  const pageNumber = Math.floor(offset / pageSize) + 1;
  const pages = Math.max(1, Math.ceil(page.total / pageSize));
  const visibleSources = useMemo(() => {
    const needle = sourceSearch.trim().toLocaleLowerCase(locale === "be" ? "be-BY" : "ru-RU");
    return needle ? facets.sources.filter((value) => value.toLocaleLowerCase(locale === "be" ? "be-BY" : "ru-RU").includes(needle)) : facets.sources;
  }, [facets.sources, sourceSearch, locale]);
  const sourceLabel = sources.length === 0 ? t("archive.allSources") : sources.length === 1 ? sources[0] : t("archive.selectedSources", { count: sources.length });
  const hasFilters = useMemo(() => Boolean(query || category || region || sources.length || period !== 30 || sort !== "newest"), [query, category, region, sources.length, period, sort]);
  function toggleSource(value: string) { setSources((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]); setOffset(0); }
  function reset() { setQuery(""); setPeriod(30); setCategory(""); setRegion(""); setSources([]); setSourceSearch(""); setSort("newest"); setOffset(0); }

  return <div className="view-stack">
    <section className="view-heading archive-heading"><div><div className="eyebrow dark">{t("archive.eyebrow")}</div><h2>{t("archive.title")}</h2><p>{t("archive.subtitle")}</p></div><PeriodSelector value={period} onChange={(value) => { setPeriod(value); setOffset(0); }} /></section>
    <section className="panel filters-panel">
      <div className="archive-search-row">
        <div className="archive-search-box"><span>⌕</span><input value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} placeholder={t("archive.search")} /></div>
        <div className="archive-filter-select">
          <select value={sort} onChange={(event) => { setSort(event.target.value as typeof sort); setOffset(0); }}>
            <option value="newest">{t("archive.newest")}</option>
            <option value="oldest">{t("archive.oldest")}</option>
            <option value="score">{t("archive.score")}</option>
          </select>
        </div>
      </div>
      <div className="filter-row">
        <div className="archive-filter-select">
          <select value={category} onChange={(event) => { setCategory(event.target.value); setOffset(0); }}>
            <option value="">{t("archive.allCategories")}</option>
            {facets.categories.map((value) => <option key={value} value={value}>{localizeDataLabel(value, locale, "category")}</option>)}
          </select>
        </div>
        <div className="archive-filter-select">
          <select value={region} onChange={(event) => { setRegion(event.target.value); setOffset(0); }}>
            <option value="">{t("archive.allRegions")}</option>
            {facets.regions.map((value) => <option key={value} value={value}>{localizeDataLabel(value, locale, "region")}</option>)}
          </select>
        </div>
        <div className="source-multiselect" ref={sourceMenuRef}>
          <button type="button" className="source-multiselect-trigger" onClick={() => setSourceMenuOpen((open) => !open)} aria-expanded={sourceMenuOpen}>
            <span>{sourceLabel}</span>
          </button>
          {sourceMenuOpen && <div className="source-multiselect-menu">
            <div className="source-multiselect-actions">
              <button type="button" onClick={() => { setSources([...facets.sources]); setOffset(0); }}>{t("archive.selectAllSources")}</button>
              <button type="button" onClick={() => { setSources([]); setOffset(0); }}>{t("archive.clearSources")}</button>
            </div>
            <div className="source-multiselect-search">
              <span>⌕</span><input autoFocus value={sourceSearch} onChange={(event) => setSourceSearch(event.target.value)} placeholder={t("archive.searchSources")} />
            </div>
            <div className="source-multiselect-options">
              {visibleSources.length === 0 ? <p>{t("archive.noSources")}</p> : visibleSources.map((value) =>
                <label key={value}><input type="checkbox" checked={sources.includes(value)} onChange={() => toggleSource(value)} /><span>{value}</span></label>,
              )}
            </div>
          </div>}
        </div>
        {hasFilters && <button className="ghost-button" onClick={reset}>{t("archive.reset")}</button>}
      </div>
    </section>
    {error && <div className="notice error">{error}</div>}
    <div className="archive-summary"><b>{loading ? t("archive.searching") : page.total}</b> {t("archive.materials")} <span>· {t("archive.page", { page: pageNumber, pages })}</span></div>
    <section className="archive-list">{!loading && page.items.length === 0 ? <div className="panel empty-state">{t("archive.empty")}</div> : page.items.map((item) => <PublicationCard key={item.id} item={item} />)}</section>
    <div className="pagination"><button className="secondary-button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - pageSize))}>{t("archive.back")}</button><span>{pageNumber} / {pages}</span><button className="secondary-button" disabled={offset + pageSize >= page.total || loading} onClick={() => setOffset(offset + pageSize)}>{t("archive.next")}</button></div>
  </div>;
}
