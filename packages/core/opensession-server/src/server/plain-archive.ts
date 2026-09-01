/**
 * Auto-archive opensession sessions when their Plain ticket reaches DONE.
 * Two paths: the Plain webhook (status transition events) and a periodic
 * sweep as a safety net in case the webhook subscription misses them.
 */
import { executeSessionProjection } from "./session-projection-executor";
import { readdirSync, readFileSync, existsSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { plainApiUrl } from "./config";
import { homeDir, OPENSESSION_SESSIONS_DIR } from "./paths";
import { invalidateSessionsCache } from "./session-cache";
import { releasePreviewPathLease } from "./preview-path-leases";
import type { NativeSessionFile } from "./types";

const HOME = homeDir();
const SESSIONS_DIR = OPENSESSION_SESSIONS_DIR;

type PlainSessionCandidate = { path: string; data: NativeSessionFile };
type SessionProjector = typeof executeSessionProjection;

function activePlainSessions(): PlainSessionCandidate[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const out: Array<{ path: string; data: NativeSessionFile }> = [];
  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const path = `${SESSIONS_DIR}/${file}`;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as NativeSessionFile;
      if (data.plainThreadId && !data.archived) out.push({ path, data });
    } catch {}
  }
  return out;
}

/**
 * Clear the file-level `archived` flag on a opensession session (set by the Plain
 * done-ticket path above). Manual unarchive only clears the archive registry, so
 * without this a Plain-archived session would stay archived and never return to
 * "My sessions". No-op for non-opensession sessions (no session file). Returns true
 * if a flag was cleared.
 */
export async function clearSessionFileArchive(id: string): Promise<boolean> {
  const path = `${SESSIONS_DIR}/${id}.json`;
  if (!existsSync(path)) return false;
  try {
    return await executeSessionProjection(id, "plain_archive_clear", () => {
      const data = JSON.parse(readFileSync(path, "utf-8")) as NativeSessionFile;
      if (!data.archived && !data.archivedAt) return false;
      const { archived, archivedAt, archivedReason, ...rest } = data;
      writeJsonAtomic(path, rest);
      return true;
    });
  } catch {
    return false;
  }
}

/** Mark every session tied to this thread as archived. Returns count. */
export async function archiveSessionsForThread(
  threadId: string,
): Promise<number> {
  return archivePlainSessionCandidates(
    threadId,
    activePlainSessions(),
    executeSessionProjection,
  );
}

/** Archive matching files independently so one quarantined session cannot
 * abort the Plain sweep before the remaining sessions are processed. */
export async function archivePlainSessionCandidates(
  threadId: string,
  sessions: PlainSessionCandidate[],
  project: SessionProjector = executeSessionProjection,
  reportFailure: (sessionId: string, error: unknown) => void = (
    sessionId,
    error,
  ) =>
    console.warn(
      `[plain-archive] Could not archive session ${sessionId}:`,
      error,
    ),
  releaseLease: (sessionId: string) => void = releasePreviewPathLease,
): Promise<number> {
  let archived = 0;
  for (const { path, data } of sessions) {
    if (data.plainThreadId !== threadId) continue;
    try {
      await project(data.id, "plain_archive_set", () =>
        writeJsonAtomic(path, {
          ...data,
          archived: true,
          archivedAt: new Date().toISOString(),
          archivedReason: "plain",
        }),
      );
      try {
        releaseLease(data.id);
      } catch (error) {
        reportFailure(data.id, error);
      }
      archived++;
    } catch (error) {
      reportFailure(data.id, error);
    }
  }
  if (archived > 0) invalidateSessionsCache();
  return archived;
}

async function fetchThreadStatus(threadId: string): Promise<string | null> {
  const key = process.env.PLAIN_API_KEY;
  if (!key) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(plainApiUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query($id: ID!) { thread(threadId: $id) { status } }`,
        variables: { id: threadId },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = await res.json();
    return json?.data?.thread?.status || null;
  } catch {
    return null;
  }
}

let sweepInterval: ReturnType<typeof setInterval> | null = null;

export function startPlainArchiveSweep(onChange?: () => void): void {
  if (sweepInterval) return;

  const sweep = async () => {
    const sessions = activePlainSessions();
    const threadIds = [
      ...new Set(sessions.map((s) => s.data.plainThreadId!)),
    ].slice(0, 40);
    let archived = 0;
    for (const threadId of threadIds) {
      const status = await fetchThreadStatus(threadId);
      if (status === "DONE")
        archived += await archiveSessionsForThread(threadId);
    }
    if (archived > 0) {
      console.log(
        `[plain-archive] Archived ${archived} session(s) for done tickets`,
      );
      onChange?.();
    }
  };

  const runSweep = () => {
    void sweep().catch((error) =>
      console.error("[plain-archive] Sweep failed:", error),
    );
  };

  sweepInterval = setInterval(runSweep, 15 * 60 * 1000);
  setTimeout(runSweep, 60 * 1000); // first pass shortly after boot
  console.log("[plain-archive] Sweep started (15m interval)");
}
