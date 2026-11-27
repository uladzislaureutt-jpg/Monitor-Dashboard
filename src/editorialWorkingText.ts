import type { ReportDraftItem } from "./types";

/** The publisher's source remains immutable. Exact works on the Russian translation
 * when one exists, and on an edited legacy draft rather than unexpectedly reverting
 * it to the source language. */
export function exactCompressionBasis(
  item: Pick<ReportDraftItem, "sourceText" | "editorialText" | "translatedText" | "compressionBaseText">,
  profile: "l" | "sep",
): string {
  if (profile === "sep") return item.sourceText;
  if (item.translatedText?.trim()) return item.translatedText;
  if (item.compressionBaseText?.trim()) return item.compressionBaseText;
  // Pre-upgrade drafts stored only editorialText. Preserve that working language.
  const current = item.editorialText.trim();
  return current && current !== item.sourceText.trim() ? item.editorialText : item.sourceText;
}

export function compressionDisplayBasis(
  item: Pick<ReportDraftItem, "sourceText" | "translatedText" | "compressionBaseText">,
  profile: "l" | "sep",
): string {
  if (profile === "l") return item.translatedText?.trim() || item.compressionBaseText?.trim() || item.sourceText;
  return item.sourceText;
}
