import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeZoom, zoomKeyAction, nextZoom } from "../src/appZoom.ts";
import { exactCompressionBasis, compressionDisplayBasis } from "../src/editorialWorkingText.ts";
import { exactCompressForProfile } from "../src/editorialCompression.ts";

test("Ctrl+plus/minus/numpad and Ctrl+0 control full UI zoom", () => {
  const e = (key, code, extra = {}) => ({ key, code, ctrlKey: true, altKey: false, metaKey: false, ...extra });
  assert.equal(zoomKeyAction(e("+", "Equal")), "in");
  assert.equal(zoomKeyAction(e("=", "Equal")), "in");
  assert.equal(zoomKeyAction(e("Add", "NumpadAdd")), "in");
  assert.equal(zoomKeyAction(e("-", "Minus")), "out");
  assert.equal(zoomKeyAction(e("Subtract", "NumpadSubtract")), "out");
  assert.equal(zoomKeyAction(e("0", "Digit0")), "reset");
  assert.equal(zoomKeyAction(e("+", "Equal", { ctrlKey: false })), null);
  assert.equal(zoomKeyAction(e("+", "Equal", { altKey: true })), null);
  assert.equal(nextZoom(100, "in"), 110);
  assert.equal(nextZoom(100, "out"), 90);
  assert.equal(nextZoom(170, "reset"), 100);
  assert.equal(normalizeZoom(999), 200);
  assert.equal(normalizeZoom("garbage"), 100);
});
test("Exact in L-Monitor compresses the Russian translation, never the Vietnamese source", () => {
  const vietnamese = "Tổng thống Belarus Lukashenko đến Việt Nam. Việt Nam coi trọng quan hệ hợp tác.";
  const russian = Array.from({ length: 16 }, (_, i) => `Президент Беларуси посетил Вьетнам для переговоров. Документ ${i+1} описывает сотрудничество двух стран.`).join(" ");
  const item = { sourceText: vietnamese, editorialText: russian, translatedText: russian };
  assert.equal(exactCompressionBasis(item, "l"), russian);
  assert.equal(compressionDisplayBasis(item, "l"), russian);
  const compressed = exactCompressForProfile(exactCompressionBasis(item, "l"), "extract", "l").text;
  assert.match(compressed, /Президент Беларуси/);
  assert.doesNotMatch(compressed, /Việt Nam|Lukashenko đến/);
  assert.ok(compressed.length < russian.length);
  assert.equal(exactCompressionBasis({ ...item, editorialText: compressed }, "l"), russian);
});
test("Pre-upgrade translated drafts preserve current editorial language; reset permits source", () => {
  const source = "Chính phủ Việt Nam công bố kế hoạch.";
  const editorial = "Правительство Вьетнама опубликовало план.";
  const legacy = { sourceText: source, editorialText: editorial };
  assert.equal(exactCompressionBasis(legacy, "l"), editorial);
  assert.equal(exactCompressionBasis({ ...legacy, compressionBaseText: editorial, editorialText: "Правительство." }, "l"), editorial);
  assert.equal(exactCompressionBasis({ sourceText: source, editorialText: source }, "l"), source);
  assert.equal(exactCompressionBasis(legacy, "sep"), source);
});
