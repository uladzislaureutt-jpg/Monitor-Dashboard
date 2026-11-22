import { ensureWorkroomSession, loadWorkroomConfig, loadWorkroomSession } from "./workroom";

export type EventEntry = {
  id: string; url: string; title: string; publisher: string; excerpt: string;
  published: string | null; updated: string | null; outsideWindow: boolean;
  access: "readable" | "lead" | "metadata";
  publicationEvidence?: string;
  updateEvidence?: string;
  extraction?: "html" | "readability" | "telegram";
  issue?: "redirect_home" | "timeout" | "unavailable";
  originKind?: "official" | "media";
  country?: string;
  namedSources?: string[];
  citations: Array<{ sourceId: string; evidence: string }>;
};

export type EventTraceResult = {
  entries: EventEntry[];
  earliestId: string | null;
  citedSourceIds: string[];
  checked: number;
  search: {
    tavily: number;
    brightData: number;
    newscatcher?: number;
    newscatcherPages?: number;
    newscatcherStatus?: "partial" | "rate_limit" | "unavailable";
  };
  warnings: string[];
  summary: string | null;
  summarySources?: string[];
  observations?: Array<{ sourceId: string; excerpt: string; kind: "statement" | "detail" | "disputed" }>;
  checkedAt?: string;
};

export type EventRun = {
  id: string;
  task: string;
  status: "running" | "complete" | "partial" | "failed";
  stage: "search" | "sources" | "reserve" | "summary" | "done";
  options: { from: string | null; through: string | null };
  result: EventTraceResult | null;
  created_at: string;
  updated_at?: string;
};

type Request = { action: "latest" } | { action: "status" | "clear"; id: string } |
  { action: "start"; id: string; task: string; from: string; through: string; locale: "ru" | "be" };

export async function eventRun(body: Request, signal?: AbortSignal): Promise<EventRun | null> {
  const config = loadWorkroomConfig();
  const current = loadWorkroomSession();
  if (!current) throw new Error("unauthorized");
  const session = await ensureWorkroomSession(config, current);
  const response = await fetch(`${config.url.replace(/\/+$/, "")}/functions/v1/event-trace`, {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${session.accessToken}`, apikey: config.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `HTTP_${response.status}`);
  return payload.run ?? null;
}
