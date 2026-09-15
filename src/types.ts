export type RunSummary = {
  id: number;
  monitorKey: string;
  monitorName: string;
  runNumber: number | null;
  externalRunId: string | null;
  startedAt: string | null;
  lookbackHours: number | null;
  dryRun: boolean | null;
  contractVersion: string;
  importedAt: string;
  publications: number;
  sourcesInResult: number;
  sourcesInCoverage: number;
};

export type DatabaseStats = {
  databasePath: string;
  databaseSizeBytes: number;
  schemaVersion: number;
  monitors: number;
  runs: number;
  documents: number;
  sources: number;
  monitorItems: number;
};

export type ImportResult = {
  status: "imported" | "replaced" | "already_imported";
  runId: number;
  monitorKey: string;
  runNumber: number | null;
  dryRun: boolean | null;
  contractVersion: string;
  publications: number;
  sourcesInResult: number;
  sourcesInCoverage: number;
  bundleSha256: string;
  inputKind: "direct_bundle" | "github_artifact_wrapper";
};
