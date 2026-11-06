/** Pure conversion of shared server moderation rows into the existing local shape. */
import type { NetworkModeration } from "./networks";

export type CloudModerationRow = { item_id: string; flagged: boolean; deleted: boolean };
export function cloudModerationToLocal(rows: CloudModerationRow[]): NetworkModeration {
  return {
    flagged: rows.filter((row) => row.flagged && !row.deleted).map((row) => row.item_id),
    deleted: rows.filter((row) => row.deleted).map((row) => row.item_id),
  };
}
