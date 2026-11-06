/** TikTok / Сети — shared ADMINISTRATOR-only Supabase archive & moderation.
 * GitHub bundles remain the evidence source. The cloud database makes final
 * cards and deletion/flag decisions converge across Windows devices.
 * Transcription drafts remain intentionally device-local.
 */
import { ensureWorkroomSession, loadWorkroomConfig, loadWorkroomSession } from "./workroom";
import { includedInOperatorOverview, type NetworkCard, type NetworkModeration } from "./networks";

type CloudModerationRow = { item_id: string; flagged: boolean; deleted: boolean };
type CloudCardRow = { item_id: string; card: NetworkCard };
const PAGE_SIZE = 500;
const PUSH_SIZE = 100;
const MAX_REMOTE = 20_000;

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const config = loadWorkroomConfig();
  const session = loadWorkroomSession();
  if (!session) throw new Error("TIKTOK_CLOUD_AUTH_REQUIRED");
  const active = await ensureWorkroomSession(config, session);
  if (session.userId !== active.userId) throw new Error("TIKTOK_CLOUD_ACCOUNT_CHANGED");
  const response = await fetch(`${config.url.replace(/\/+$/, "")}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${active.accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await response.text();
  let payload: unknown = null;
  try { payload = body ? JSON.parse(body) : null; } catch { payload = body; }
  if (!response.ok) {
    const detail = typeof payload === "object" && payload && "message" in payload
      ? String((payload as { message: unknown }).message)
      : String(body);
    throw new Error(`TIKTOK_CLOUD_HTTP_${response.status}: ${detail.slice(0, 240)}`);
  }
  return payload;
}

async function pagedRead<T>(table: string, columns: string): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; offset < MAX_REMOTE; offset += PAGE_SIZE) {
    const params = new URLSearchParams({
      select: columns, order: "item_id.asc",
      limit: String(PAGE_SIZE), offset: String(offset),
    });
    const rows = await request(`${table}?${params.toString()}`);
    if (!Array.isArray(rows)) throw new Error("TIKTOK_CLOUD_INVALID_LIST");
    all.push(...rows as T[]);
    if (rows.length < PAGE_SIZE) return all;
  }
  throw new Error("TIKTOK_CLOUD_ARCHIVE_LIMIT");
}

export function cloudModerationToLocal(rows: CloudModerationRow[]): NetworkModeration {
  return {
    flagged: rows.filter((row) => row.flagged && !row.deleted).map((row) => row.item_id),
    deleted: rows.filter((row) => row.deleted).map((row) => row.item_id),
  };
}

export async function downloadTikTokCloud(): Promise<{
  cards: NetworkCard[];
  moderation: NetworkModeration;
}> {
  const [cardRows, moderationRows] = await Promise.all([
    pagedRead<CloudCardRow>("tiktok_network_cards", "item_id,card"),
    pagedRead<CloudModerationRow>("tiktok_network_moderation", "item_id,flagged,deleted"),
  ]);
  const cards = cardRows.map((row) => row.card);
  if (cards.some((card) => !card || card.platform !== "tiktok" || !includedInOperatorOverview(card))) {
    throw new Error("TIKTOK_CLOUD_INVALID_CARDS");
  }
  return { cards, moderation: cloudModerationToLocal(moderationRows) };
}

/** Only send final-report cards, never the pre-semantic 300-item discovery pool. */
export async function uploadTikTokFinalCards(cards: NetworkCard[]): Promise<number> {
  const approved = cards.filter(includedInOperatorOverview);
  let sent = 0;
  for (let i = 0; i < approved.length; i += PUSH_SIZE) {
    const batch = approved.slice(i, i + PUSH_SIZE);
    await request("rpc/tiktok_upsert_cards", {
      method: "POST", body: JSON.stringify({ p_cards: batch }),
    });
    sent += batch.length;
  }
  return sent;
}

/** One-time monotonic migration of each old PC's local deletions and flags. */
export async function migrateTikTokLocalModeration(local: NetworkModeration): Promise<void> {
  await request("rpc/tiktok_migrate_moderation", {
    method: "POST",
    body: JSON.stringify({ p_deleted: local.deleted, p_flagged: local.flagged }),
  });
}

export async function applyTikTokCloudModeration(
  itemId: string, change: { flagged?: boolean; delete?: boolean },
): Promise<{ item_id: string; flagged: boolean; deleted: boolean }> {
  const response = await request("rpc/tiktok_apply_moderation", {
    method: "POST",
    body: JSON.stringify({
      p_item_id: itemId, p_flagged: change.flagged ?? null, p_delete: change.delete === true,
    }),
  });
  const row = response as CloudModerationRow;
  if (!row || row.item_id !== itemId || typeof row.deleted !== "boolean" || typeof row.flagged !== "boolean") {
    throw new Error("TIKTOK_CLOUD_MODERATION_INVALID_RESPONSE");
  }
  return row;
}
