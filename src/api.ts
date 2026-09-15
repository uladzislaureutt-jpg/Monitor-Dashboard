import { invoke } from "@tauri-apps/api/core";
import type { DatabaseStats, ImportResult, RunSummary } from "./types";

export const desktopApi = {
  stats: () => invoke<DatabaseStats>("get_database_stats"),
  runs: () => invoke<RunSummary[]>("list_runs"),
  importBundle: (path: string) =>
    invoke<ImportResult>("import_dashboard_bundle", { path }),
};
