/**
 * Auto-archive opensession sessions when their Plain ticket reaches DONE.
 * Two paths: the Plain webhook (status transition events) and a periodic
 * sweep as a safety net in case the webhook subscription misses them.
 *
 * A session that reports into an auto-triage discussion has that discussion
 * resolved first and is archived only once that succeeded. A failed
 * resolution therefore leaves the session unarchived, which keeps it in the
 * sweep's catalog candidate set: the next pass retries both steps, so the
 * metadata itself is the retry index and no separate pending-resolution state exists.
 */
import { catalogNativeSessions } from "./session-catalog-read";
import { executeSessionProjection } from "./session-projection-executor";
import { readFileSync, existsSync } from "fs";
import { plainApiUrl } from "./config";
import {
  discussionAgentConfigured,
  resolveDiscussion,
  withDiscussionOrder,
} from "../agents/plain/discussion-api";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { updateSessionFile } from "./session-cache";
import { releasePreviewPathLease } from "./preview-path-leases";
import type { NativeSessionFile } from "./types";

const SESSIONS_DIR = OPENSESSION_SESSIONS_DIR;

const PLAIN_ARCHIVE_BATCH = 40;

type PlainSessionCandidate = { data: NativeSessionFile };
type SessionProjector = typeof executeSessionProjection;
type DiscussionResolver = (discussionId: string) => Promise<void>;

/** Resolve the discussion a triage session reports into. Throws on failure,
 *  a missing agent key included (the session proves the discussion exists,
 *  and an archived session never comes back to the sweep), so the caller
 *  keeps the session for a later retry. */
export async function resolvePlainDiscussion(
  discussionId: string,
): Promise<void> {
  if (!discussionAgentConfigured())
    throw new Error("Plain discussion agent is not configured");
  await withDiscussionOrder(discussionId, () =>
    resolveDiscussion(discussionId),
  );
}

export async function activePlainSessions(): Promise<PlainSessionCandidate[]> {
  return (await catalogNativeSessions())
    .filter((data) => data.plainThreadId && !data.archived)
    .map((data) => ({ data }));
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
    const data = JSON.parse(readFileSync(path, "utf-8")) as NativeSessionFile;
    if (!data.archived && !data.archivedAt) return false;
    return await executeSessionProjection(
      id,
      "plain_archive_clear",
      async () => {
        let cleared = false;
        await updateSessionFile(id, (current) => {
          if (!current.archived && !current.archivedAt) return current;
          cleared = true;
          const { archived, archivedAt, archivedReason, ...rest } = current;
          return rest as NativeSessionFile;
        });
        return cleared;
      },
    );
  } catch {
    return false;
  }
}

/** Resolve the discussions of every session tied to this thread and mark the
 *  sessions archived. Returns how many sessions were archived. */
export async function archiveSessionsForThread(
  threadId: string,
): Promise<number> {
  return archivePlainSessionCandidates(
    threadId,
    await activePlainSessions(),
    executeSessionProjection,
  );
}

/** Archive matching files independently so one quarantined session cannot
 * abort the Plain sweep before the remaining sessions are processed. A
 * session whose discussion cannot be resolved is reported and left
 * unarchived so the next webhook or sweep pass retries it. */
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
  resolveSessionDiscussion: DiscussionResolver = resolvePlainDiscussion,
  stopPortals: (sessionId: string) => Promise<void> = async (sessionId) => {
    const { stopArchivedSessionPortals } = await import("./portal-supervisor");
    await stopArchivedSessionPortals(sessionId);
  },
): Promise<number> {
  let archived = 0;
  for (const { data } of sessions
    .filter((row) => row.data.plainThreadId === threadId)
    .slice(0, PLAIN_ARCHIVE_BATCH)) {
    try {
      if (data.plainDiscussionId)
        await resolveSessionDiscussion(data.plainDiscussionId);
      await project(data.id, "plain_archive_set", () =>
        updateSessionFile(data.id, (current) => {
          if (
            current.archived ||
            current.plainThreadId !== threadId ||
            current.plainDiscussionId !== data.plainDiscussionId
          )
            throw new Error(
              "Plain session changed since candidate selection; retry from the catalog",
            );
          return {
            ...current,
            archived: true,
            archivedAt: new Date().toISOString(),
            archivedReason: "plain",
          };
        }),
      );
      try {
        releaseLease(data.id);
      } catch (error) {
        reportFailure(data.id, error);
      }
      try {
        await stopPortals(data.id);
      } catch (error) {
        // The archive is committed. The Portal reaper retries cleanup from
        // the catalog's archived flag, including after a gateway restart.
        reportFailure(data.id, error);
      }
      archived++;
    } catch (error) {
      reportFailure(data.id, error);
    }
  }
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

/** Every archive here commits through the metadata facade, which publishes
 * the changed row itself, so the sweep has nothing further to announce. */
export function startPlainArchiveSweep(): void {
  if (sweepInterval) return;

  let afterId = "";
  let running = false;
  const sweep = async () => {
    const all = await activePlainSessions();
    let pending = all.filter((row) => row.data.id > afterId);
    if (!pending.length) pending = all;
    const sessions = pending.slice(0, PLAIN_ARCHIVE_BATCH);
    afterId = sessions.at(-1)?.data.id ?? "";
    const threadIds = [...new Set(sessions.map((s) => s.data.plainThreadId!))];
    let archived = 0;
    for (const threadId of threadIds) {
      const status = await fetchThreadStatus(threadId);
      if (status === "DONE")
        archived += await archivePlainSessionCandidates(threadId, sessions);
    }
    if (archived > 0)
      console.log(
        `[plain-archive] Archived ${archived} session(s) for done tickets`,
      );
  };

  const runSweep = () => {
    if (running) return;
    running = true;
    void sweep()
      .catch((error) => console.error("[plain-archive] Sweep failed:", error))
      .finally(() => {
        running = false;
      });
  };

  sweepInterval = setInterval(runSweep, 15 * 60 * 1000);
  setTimeout(runSweep, 60 * 1000); // first pass shortly after boot
  console.log("[plain-archive] Sweep started (15m interval)");
}
