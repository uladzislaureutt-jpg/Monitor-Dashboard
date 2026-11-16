/** Pure conversion of shared server moderation rows into the existing local shape. */
import type { NetworkModeration, TikTokMoveSection } from "./networks";

export type CloudModerationRow = { item_id: string; flagged: boolean; deleted: boolean; operator_section?: TikTokMoveSection | null };
export function cloudModerationToLocal(rows: CloudModerationRow[]): NetworkModeration {
  const sections: NonNullable<NetworkModeration["sections"]> = {};
  for (const row of rows) {
    if (!row.deleted && (row.operator_section === "appeals" || row.operator_section === "complaints")) {
      sections[row.item_id] = row.operator_section;
    }
  }
  return {
    flagged: rows.filter((row) => row.flagged && !row.deleted).map((row) => row.item_id),
    deleted: rows.filter((row) => row.deleted).map((row) => row.item_id),
    ...(Object.keys(sections).length ? { sections } : {}),
  };
}
