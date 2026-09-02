import { z } from "zod";

// The session last open in each workspace, so re-entering a workspace (sidebar
// click, bare /workspace/<id> URL) lands on the session tab it was left on
// rather than the oldest session. A per-device working preference, like the
// per-workspace view tab in active-view-tab.ts.
const KEY = "opensession-workspace-last-sessions";

// Workspaces accumulate over time, so cap the map. Entries are kept in
// insertion order; a save re-appends its workspace, so trimming from the
// front evicts the least recently saved.
const MAX_ENTRIES = 200;

function read(): Record<string, string> {
  try {
    const parsed = z
      .record(z.string(), z.unknown())
      .safeParse(JSON.parse(localStorage.getItem(KEY) || "{}"));
    if (!parsed.success) return {};
    const entries: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(parsed.data)) {
      const sessionId = z.string().safeParse(value);
      if (sessionId.success) entries.push([key, sessionId.data]);
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

/** `undefined` means no session has been opened in this workspace on this device. */
export function getWorkspaceLastSession(
  workspaceId: string,
): string | undefined {
  return read()[workspaceId];
}

export function saveWorkspaceLastSession(
  workspaceId: string,
  sessionId: string,
): void {
  if (!workspaceId || !sessionId) return;
  const map = read();
  if (map[workspaceId] === sessionId) return;
  delete map[workspaceId];
  map[workspaceId] = sessionId;
  const ids = Object.keys(map);
  for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_ENTRIES)))
    delete map[stale];
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* private mode / quota: landing just falls back to the default pick */
  }
}
