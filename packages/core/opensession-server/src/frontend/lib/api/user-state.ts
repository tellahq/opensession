import { z } from "zod";
import type { MapDelta } from "../user-map";
import { request } from "./request";

const stringMapSchema = z.record(z.string(), z.string());
const remoteDraftMapSchema = z.record(
  z.string(),
  z.object({ text: z.string(), updatedAt: z.string() }),
);
const readsResponseSchema = z.object({ reads: stringMapSchema.optional() });
const draftsResponseSchema = z.object({
  drafts: remoteDraftMapSchema.optional(),
});
const prefsResponseSchema = z.object({ prefs: stringMapSchema.optional() });
const lanesResponseSchema = z.object({ lanes: stringMapSchema.optional() });
const snoozesResponseSchema = z.object({ snoozes: stringMapSchema.optional() });
const hidesResponseSchema = z.object({ hides: stringMapSchema.optional() });
const colorsResponseSchema = z.object({ colors: stringMapSchema.optional() });

// ── Pins (per-user pinned tabs) ──

export async function fetchPins(user: string): Promise<string[]> {
  const body = await request<{ pins?: string[] }>(
    `/pins?user=${encodeURIComponent(user)}`,
    { label: "Failed to fetch pins" },
  );
  return Array.isArray(body?.pins) ? body.pins : [];
}

export async function savePinsApi(
  user: string,
  pins: string[],
): Promise<string[]> {
  const body = await request<{ pins?: string[] }>("/pins", {
    method: "PUT",
    body: { user, pins },
    label: "Failed to save pins",
  });
  return Array.isArray(body?.pins) ? body.pins : pins;
}

// ── Mentions (sessions where a teammate tagged you) ──

export interface MentionRecord {
  sessionId: string;
  by: string;
  source: "prompt" | "note";
  preview: string;
  ts: number;
}

export async function fetchMentions(user: string): Promise<MentionRecord[]> {
  const body = await request<{ mentions?: MentionRecord[] }>(
    `/mentions?user=${encodeURIComponent(user)}`,
    { label: "Failed to fetch mentions" },
  );
  return Array.isArray(body?.mentions) ? body.mentions : [];
}

/** Clear one session's mention, or every one when `sessionId` is omitted. */
export async function clearMentionApi(
  user: string,
  sessionId?: string,
): Promise<void> {
  const body = sessionId ? { user, sessionId } : { user };
  await request("/mentions/clear", {
    method: "POST",
    body,
    label: "Failed to clear mention",
  });
}

// ── Reads (per-user unread marks; server mirror of localStorage) ──

export async function fetchReads(
  user: string,
): Promise<Record<string, string>> {
  const body = await request<unknown>(
    `/reads?user=${encodeURIComponent(user)}`,
    { label: "Failed to fetch reads" },
  );
  const parsed = readsResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data.reads ?? {}) : {};
}

export async function saveReadsApi(
  user: string,
  reads: Record<string, string>,
): Promise<void> {
  await request<{ reads?: Record<string, string> }>("/reads", {
    method: "PUT",
    body: { user, reads },
    label: "Failed to save reads",
  });
}

// ── Drafts (per-user unsent composer text, synced across devices) ──

export interface RemoteDraft {
  text: string;
  updatedAt: string;
}

export async function fetchDrafts(
  user: string,
): Promise<Record<string, RemoteDraft>> {
  const body = await request<unknown>(
    `/drafts?user=${encodeURIComponent(user)}`,
    { label: "Failed to fetch drafts" },
  );
  const parsed = draftsResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data.drafts ?? {}) : {};
}

/** Store one session's draft (empty text deletes it). `applied` comes back
 *  false when the server holds a newer copy, which is then in `draft`. */
export async function saveDraftApi(
  user: string,
  sessionId: string,
  text: string,
  updatedAt: string,
  keepalive = false,
): Promise<{ draft: RemoteDraft | null; applied: boolean }> {
  const body = await request<{ draft?: RemoteDraft | null; applied?: boolean }>(
    "/drafts",
    {
      method: "PUT",
      body: { user, sessionId, text, updatedAt },
      keepalive,
      label: "Failed to save draft",
    },
  );
  return { draft: body?.draft ?? null, applied: body?.applied !== false };
}

// ── UI prefs (per-user cross-device view preferences) ──

export async function fetchUiPrefs(
  user: string,
): Promise<Record<string, string>> {
  const body = await request<unknown>(
    `/ui-prefs?user=${encodeURIComponent(user)}`,
    { label: "Failed to fetch UI prefs" },
  );
  const parsed = prefsResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data.prefs ?? {}) : {};
}

/** Merge a patch into the user's server-side prefs (null value deletes). */
export async function saveUiPrefsApi(
  user: string,
  prefs: Record<string, string | null>,
  expected?: Record<string, string | null>,
): Promise<Record<string, string>> {
  const body = await request<unknown>("/ui-prefs", {
    method: "PUT",
    body: { user, prefs, expected },
    label: "Failed to save UI prefs",
  });
  const parsed = prefsResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data.prefs ?? {}) : {};
}

// ── The per-user maps (lanes, snoozes, hides, tab colors) ──
// Writes send only what changed. A whole-map PUT from a client whose cache
// predates another device's write deleted that write; see lib/user-map.ts.

// ── Lanes (per-user sidebar status lanes) ──

export async function fetchLanes(
  user: string,
): Promise<Record<string, string>> {
  const body = await request<unknown>(
    `/lanes?user=${encodeURIComponent(user)}`,
    { label: "Failed to fetch lanes" },
  );
  const parsed = lanesResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data.lanes ?? {}) : {};
}

export async function saveLanesApi(
  user: string,
  delta: MapDelta<string>,
): Promise<Record<string, string>> {
  const body = await request<unknown>("/lanes", {
    method: "PUT",
    body: { user, ...delta },
    label: "Failed to save lanes",
  });
  const parsed = lanesResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data.lanes ?? {}) : {};
}

// ── Snoozes (per-user workspace snoozes) ──

export async function fetchSnoozes(
  user: string,
): Promise<Record<string, string>> {
  const body = await request<unknown>(
    `/snoozes?user=${encodeURIComponent(user)}`,
    { label: "Failed to fetch snoozes" },
  );
  const parsed = snoozesResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data.snoozes ?? {}) : {};
}

export async function saveSnoozesApi(
  user: string,
  delta: MapDelta<string>,
): Promise<Record<string, string>> {
  const body = await request<unknown>("/snoozes", {
    method: "PUT",
    body: { user, ...delta },
    label: "Failed to save snoozes",
  });
  const parsed = snoozesResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data.snoozes ?? {}) : {};
}

// ── Hides (per-user sidebar hides) ──

export async function fetchHides(
  user: string,
): Promise<Record<string, string>> {
  const body = await request<unknown>(
    `/hides?user=${encodeURIComponent(user)}`,
    { label: "Failed to fetch hides" },
  );
  const parsed = hidesResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data.hides ?? {}) : {};
}

export async function saveHidesApi(
  user: string,
  delta: MapDelta<string>,
): Promise<Record<string, string>> {
  const body = await request<unknown>("/hides", {
    method: "PUT",
    body: { user, ...delta },
    label: "Failed to save hides",
  });
  const parsed = hidesResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data.hides ?? {}) : {};
}

// ── Tab colors (per-user session tab colors) ──

export async function fetchTabColors(
  user: string,
): Promise<Record<string, string>> {
  const body = await request<unknown>(
    `/tab-colors?user=${encodeURIComponent(user)}`,
    { label: "Failed to fetch tab colors" },
  );
  const parsed = colorsResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data.colors ?? {}) : {};
}

export async function saveTabColorsApi(
  user: string,
  delta: MapDelta<string>,
): Promise<Record<string, string>> {
  const body = await request<unknown>("/tab-colors", {
    method: "PUT",
    body: { user, ...delta },
    label: "Failed to save tab colors",
  });
  const parsed = colorsResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data.colors ?? {}) : {};
}
