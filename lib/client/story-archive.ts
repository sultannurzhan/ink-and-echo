import { validateImageDataUrl } from "../server/image-data-url.ts";

export const MAX_STORY_BYTES = 64 * 1024 * 1024;
export type StoryEntry = {
  round: number;
  kind: string;
  playerName?: string;
  text?: string;
  imageData?: string;
  rule?: string;
  metadata?: { expired?: boolean };
};
export type StoryArchive = { title: "Ink & Echo"; version: 1; mode: string; entries: StoryEntry[] };

function shortText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error("The story contains invalid or oversized text.");
  return value;
}

/** Accept the original unversioned Export story format, without importing credentials or room state. */
export function parseStoryArchive(raw: string): StoryArchive {
  if (new TextEncoder().encode(raw).byteLength > MAX_STORY_BYTES) throw new Error("Choose a story smaller than 64 MB.");
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error("This file is not valid story JSON."); }
  if (!data || data.title !== "Ink & Echo" || (data.version !== undefined && data.version !== 1) ||
      !Array.isArray(data.entries) || data.entries.length > 80) {
    throw new Error("Choose an Ink & Echo story export (up to 80 turns).");
  }
  const mode = shortText(data.mode, 80) ?? "Classic Chain";
  const entries = data.entries.map((value: unknown): StoryEntry => {
    if (!value || typeof value !== "object") throw new Error("The story has an invalid turn.");
    const entry = value as Record<string, unknown>;
    if (!Number.isInteger(entry.round) || Number(entry.round) < 1 || Number(entry.round) > 80 ||
        typeof entry.kind !== "string" || !/^[a-z-]{1,32}$/.test(entry.kind)) {
      throw new Error("The story has an invalid turn.");
    }
    const metadata = entry.metadata as Record<string, unknown> | undefined;
    const expired = metadata?.expired === true;
    let imageData: string | undefined;
    if (entry.imageData != null && !expired) {
      validateImageDataUrl(entry.imageData);
      imageData = entry.imageData as string;
    }
    return {
      round: Number(entry.round), kind: entry.kind,
      playerName: shortText(entry.playerName ?? entry.authorName, 80),
      text: shortText(entry.text, 2000), imageData,
      rule: shortText(entry.rule, 500), metadata: expired ? { expired: true } : undefined,
    };
  });
  return { title: "Ink & Echo", version: 1, mode, entries };
}

export function storyArchive(mode: string, entries: StoryEntry[]): StoryArchive {
  // Whitelist fields: never export room credentials, hidden prompts, or backend settings.
  return parseStoryArchive(JSON.stringify({ title: "Ink & Echo", version: 1, mode, entries }));
}

export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
