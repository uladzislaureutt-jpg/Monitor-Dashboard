/** The editor owns only membership and order. Never delete saved transcripts or archive entries. */
export function removeReviewVideo(slots: string[], index: number): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= slots.length) return slots;
  const remaining = [...new Set(slots.filter((_, i) => i !== index).map((url) => url.trim()).filter(Boolean))].slice(0, 5);
  return remaining.length ? remaining : [""];
}

export function clearReviewVideos(): string[] {
  return [""];
}

export function selectedVideoCount(slots: string[]): number {
  return new Set(slots.map((url) => url.trim()).filter(Boolean)).size;
}
