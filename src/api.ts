import { invoke } from "@tauri-apps/api/core";
import type {
  ArchiveFacets,
  ArchivePage,
  ArchiveQuery,
  DatabaseStats,
  DashboardOverview,
  ImportResult,
  RunSummary,
  SourceSummary,
  SyncResult,
} from "./types";

const MONITOR_KEY = "social_economic";

export const desktopApi = {
  stats: () => invoke<DatabaseStats>("get_database_stats"),
  runs: () => invoke<RunSummary[]>("list_runs"),
  importBundle: (path: string) =>
    invoke<ImportResult>("import_dashboard_bundle", { path }),
  dashboard: (periodDays: number | null) =>
    invoke<DashboardOverview>("get_dashboard_overview", {
      monitorKey: MONITOR_KEY,
      periodDays,
    }),
  archiveFacets: () =>
    invoke<ArchiveFacets>("get_archive_facets", { monitorKey: MONITOR_KEY }),
  archive: (options: ArchiveQuery = {}) =>
    invoke<ArchivePage>("list_publications", {
      monitorKey: options.monitorKey ?? MONITOR_KEY,
      query: options.query ?? "",
      periodDays: options.periodDays ?? null,
      category: options.category ?? "",
      region: options.region ?? "",
      source: options.source ?? "",
      sort: options.sort ?? "newest",
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
    }),
  search: (query: string, limit = 12) =>
    invoke<ArchivePage>("list_publications", {
      monitorKey: MONITOR_KEY,
      query,
      periodDays: null,
      category: "",
      region: "",
      source: "",
      sort: "newest",
      limit,
      offset: 0,
    }),
  sources: () =>
    invoke<SourceSummary[]>("list_sources", { monitorKey: MONITOR_KEY }),
  syncGithub: (repository: string, token: string) =>
    invoke<SyncResult>("sync_github_artifacts", { repository, token }),
  openUrl: (url: string) => invoke<void>("open_external_url", { url }),
};
