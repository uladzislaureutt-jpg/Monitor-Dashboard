import { ensureWorkroomSession, loadWorkroomConfig } from "./workroom";
import type { WorkroomSession } from "./types";

export type AdminNote = {
  id: string;
  title: string;
  body: string;
  image_paths: string[];
  created_at: string;
  updated_at: string;
};
export type NotebookImage = { path: string; url: string };

export async function adminNotebookRequest(
  session: WorkroomSession,
  action: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const config = loadWorkroomConfig();
  const active = await ensureWorkroomSession(config, session);
  const response = await fetch(config.url.replace(/\/+$/, "") + "/functions/v1/admin-notebook", {
    method: "POST",
    headers: {
      apikey: config.anonKey,
      Authorization: "Bearer " + active.accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, ...args }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.error || "admin_notebook_error"));
  return payload;
}

export async function encodeNotebookImage(file: File): Promise<{ base64: string; mime: string }> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("image_format_unsupported");
  // Preserve small sharp screenshots; shrink large ones to reduce network and Storage usage.
  let blob: Blob = file;
  if (file.size > 1_600_000) {
    const image = await createImageBitmap(file);
    try {
      const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("image_processing_unavailable");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const reduced = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", .83));
      if (reduced) blob = reduced;
    } finally { image.close(); }
  }
  if (blob.size > 3_000_000) throw new Error("image_too_large");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return { base64: btoa(binary), mime: blob.type };
}
