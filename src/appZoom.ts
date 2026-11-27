/** Accessible zoom for the entire desktop WebView, not merely article text.
 * Ctrl + (+/=)/NumpadAdd increases, Ctrl + (-)/NumpadSubtract decreases,
 * Ctrl + 0 resets. Zoom is saved locally per installation. */
export const ZOOM_STORAGE_KEY = "monitor-desktop-zoom-v1";
export const MIN_ZOOM = 80;
export const MAX_ZOOM = 200;
export const ZOOM_STEP = 10;

export function normalizeZoom(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number)) return 100;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(number / ZOOM_STEP) * ZOOM_STEP));
}

export function zoomKeyAction(event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey" | "key" | "code">): "in" | "out" | "reset" | null {
  if (!event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") return "in";
  if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") return "out";
  if (event.key === "0" || event.code === "Numpad0") return "reset";
  return null;
}

export function nextZoom(current: number, action: "in" | "out" | "reset") {
  return normalizeZoom(action === "reset" ? 100 : current + (action === "in" ? ZOOM_STEP : -ZOOM_STEP));
}

export function installAppZoom() {
  let current = 100;
  try { current = normalizeZoom(localStorage.getItem(ZOOM_STORAGE_KEY)); } catch { /* no storage */ }
  document.documentElement.style.zoom = `${current}%`;

  const onKeyDown = (event: KeyboardEvent) => {
    const action = zoomKeyAction(event);
    if (!action) return;
    event.preventDefault(); // Don't zoom twice through WebView's native shortcut.
    event.stopPropagation();
    const next = nextZoom(current, action);
    if (next === current) return;
    current = next;
    document.documentElement.style.zoom = `${next}%`;
    try { localStorage.setItem(ZOOM_STORAGE_KEY, String(next)); } catch { /* temporary preference */ }
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
}
