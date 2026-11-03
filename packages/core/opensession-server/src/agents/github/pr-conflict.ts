/**
 * "Your PR now conflicts" as a system event, delivered to the one session that
 * owns the PR.
 *
 * GitHub has no webhook for this. The `pull_request` action list has nothing
 * for a mergeability change; the `mergeable` field in a delivery is computed
 * lazily, so it arrives null or stale; and the usual cause of a conflict is
 * SOMEONE ELSE's PR landing on the base branch, which fires no event carrying
 * the affected PR's number at all. So the event is synthesized here, off the
 * 60s bulk sweep (pr-cache.ts) that already tracks `mergeable` per PR. No new
 * GitHub subscription and no extra API calls.
 *
 * The transition that matters is MERGEABLE → CONFLICTING. Two properties of the
 * tracking are deliberate:
 *  - UNKNOWN is ignored rather than recorded. GitHub reports it whenever the
 *    background merge test hasn't finished, so a flicker through UNKNOWN must
 *    not hide a real transition or manufacture a fake one.
 *  - Last-known mergeability is in memory, so a PR first seen as CONFLICTING
 *    stays quiet. Once a real transition is observed, its delivery intent is
 *    persisted until SessionControl durably admits it, including across restarts.
 *
 * Delivery goes to exactly ONE session, which is how sibling sessions on the
 * same branch agree on who handles it: the notice names that session as the
 * one assigned. The procedure (merge the base branch, claim the shared
 * worktree's merge, resolve, check, push) lives in the branch discipline note
 * (session-repos.ts buildConflictNote), not here. Nothing here touches git.
 */
import type { UnifiedSession } from "../../server/types";
import type { PrInfo } from "../../server/pr-cache";
import { stateDir } from "../../server/paths";
import { coalescedWriter } from "../../server/shared/coalesced-write";
import { readFile, rm } from "fs/promises";

export interface PrConflictEvent {
  repoId: string;
  branch: string;
  number: number;
  title: string;
  url: string;
  /** Unique transition identity; a later re-conflict gets another receipt. */
  conflictId: string;
  /** Session id from the PR body's attribution footer, when it carried one. */
  sessionRef?: string;
}

const lastKnown = new Map<string, string>();
const delivering = new Set<string>();
let conflictSequence = 0;
let pendingPathOverride: string | undefined;

function prKeyOf(repoId: string, number: number): string {
  return `${repoId}#${number}`;
}

function pendingPath(): string {
  return pendingPathOverride || `${stateDir("github")}/conflict-intents.json`;
}

async function readPendingFile(): Promise<Map<string, PrConflictEvent>> {
  try {
    const stored = JSON.parse(await readFile(pendingPath(), "utf8")) as {
      intents?: PrConflictEvent[];
    };
    return new Map(
      (stored.intents || []).map((event) => [
        prKeyOf(event.repoId, event.number),
        event,
      ]),
    );
  } catch {
    return new Map();
  }
}

/** This process is the file's only writer, so after one async load the
 *  in-memory map is the source of truth and the file follows it. */
let pendingCache: Map<string, PrConflictEvent> | undefined;
let pendingLoad: Promise<Map<string, PrConflictEvent>> | undefined;

function loadPending(): Promise<Map<string, PrConflictEvent>> {
  if (pendingCache) return Promise.resolve(pendingCache);
  pendingLoad ??= readPendingFile().then((loaded) => (pendingCache = loaded));
  return pendingLoad;
}

const pendingWriter = coalescedWriter({
  path: pendingPath,
  render: () =>
    JSON.stringify(
      { version: 1, intents: [...(pendingCache?.values() ?? [])] },
      null,
      2,
    ),
  label: "github",
});

function writePending(): void {
  pendingWriter.schedule();
}

export function __setConflictIntentPathForTest(path?: string): void {
  pendingPathOverride = path;
}

/** Test seam: forget remembered state and pending test intents. */
export async function resetConflictWatch(): Promise<void> {
  lastKnown.clear();
  delivering.clear();
  conflictSequence = 0;
  await pendingWriter.flush();
  pendingCache = undefined;
  pendingLoad = undefined;
  await rm(pendingPath(), { force: true }).catch(() => {});
}

export async function scanConflictTransitions(
  data: Map<string, Map<string, PrInfo>>,
  freshRepos: Set<string>,
): Promise<PrConflictEvent[]> {
  const events: PrConflictEvent[] = [];
  const pending = await loadPending();
  let pendingChanged = false;
  const seen = new Set<string>();
  for (const repoId of freshRepos) {
    for (const [branch, pr] of data.get(repoId) || []) {
      if (pr.state !== "OPEN") continue;
      const key = prKeyOf(repoId, pr.number);
      seen.add(key);
      if (pr.mergeable !== "MERGEABLE" && pr.mergeable !== "CONFLICTING")
        continue;
      const prev = lastKnown.get(key);
      lastKnown.set(key, pr.mergeable);
      if (pr.mergeable === "MERGEABLE" && pending.delete(key))
        pendingChanged = true;
      if (prev === "MERGEABLE" && pr.mergeable === "CONFLICTING") {
        const event: PrConflictEvent = {
          repoId,
          branch,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          conflictId: `${pr.headRefOid || "unknown"}:${Date.now().toString(36)}:${++conflictSequence}`,
          ...(pr.sessionRef ? { sessionRef: pr.sessionRef } : {}),
        };
        pending.set(key, event);
        pendingChanged = true;
        events.push(event);
      }
    }
  }
  for (const key of [...lastKnown.keys()]) {
    const repoId = key.slice(0, key.lastIndexOf("#"));
    if (freshRepos.has(repoId) && !seen.has(key)) {
      lastKnown.delete(key);
      if (pending.delete(key)) pendingChanged = true;
    }
  }
  const emitted = new Set(
    events.map((event) => prKeyOf(event.repoId, event.number)),
  );
  for (const [key, event] of pending) {
    if (
      !emitted.has(key) &&
      freshRepos.has(event.repoId) &&
      lastKnown.get(key) === "CONFLICTING"
    )
      events.push(event);
  }
  if (pendingChanged) writePending();
  return events;
}

export function conflictMessage(event: PrConflictEvent): string {
  return `PR #${event.number} “${event.title}” now has merge conflicts with its base branch. ${event.url} This session is assigned to handle it.`;
}

export function isCurrentConflictIntent(event: PrConflictEvent): boolean {
  return (
    pendingCache?.get(prKeyOf(event.repoId, event.number))?.conflictId ===
    event.conflictId
  );
}

export function settleConflictIntent(event: PrConflictEvent): void {
  const pending = pendingCache;
  const key = prKeyOf(event.repoId, event.number);
  if (!pending || pending.get(key)?.conflictId !== event.conflictId) return;
  pending.delete(key);
  writePending();
}

/** Whether the session a PR's attribution footer names can take review
 *  findings on that PR: live, not one of the PR agent's own review/fix runs,
 *  and able to change code. The footer says this session opened the PR, so an
 *  automation-started session qualifies too: it wrote the code. */
export function canFixOwnPr(
  session: UnifiedSession & { state?: string },
): boolean {
  return (
    session.state !== "archived" &&
    !session.archived &&
    !session.id.startsWith("bks-ghpr-") &&
    session.mode !== "ask" &&
    session.mode !== "scratch"
  );
}

/** Whether a session can be handed work on its PR: live, not one of the PR
 *  agent's own review/fix runs, not an automation run, and able to change
 *  code. */
export function canOwnPrWork(
  session: UnifiedSession & { state?: string },
): boolean {
  return canFixOwnPr(session) && !session.automation;
}

/**
 * The ONE session a PR event is assigned to: the session named in the PR
 * body's attribution footer while it can take the work, else the oldest
 * session that owns the branch (checkouts before linked-only followers).
 * Throws SessionOwnershipOverflowError when the branch has too many owners.
 */
export async function owningPrSession(
  repoId: string,
  branch: string,
  sessionRef?: string,
): Promise<UnifiedSession | undefined> {
  const { tryGetSessionControl } = await import("../../server/session-control");
  const referenced = sessionRef
    ? tryGetSessionControl()?.getSession(sessionRef)
    : undefined;
  if (referenced && canOwnPrWork(referenced)) return referenced;
  const { matchSessions } = await import("./session-notify");
  return (await matchSessions(repoId, branch, { order: "created" })).find(
    canOwnPrWork,
  );
}

export async function notifyConflictedPrSession(
  event: PrConflictEvent,
): Promise<void> {
  const key = `${prKeyOf(event.repoId, event.number)}:${event.conflictId}`;
  if (delivering.has(key)) return;
  delivering.add(key);
  try {
    const { tryGetSessionControl } =
      await import("../../server/session-control");
    const control = tryGetSessionControl();
    if (!control) return;

    const target = await owningPrSession(
      event.repoId,
      event.branch,
      event.sessionRef,
    );
    if (!target) return;

    const { audit } = await import("../../server/audit");
    const res = await control.deliverToSession(
      target.id,
      conflictMessage(event),
      "GitHub",
      {
        deliveryId: `github-conflict:${event.repoId}:${event.number}:${event.conflictId}`,
        admissionKey: event.conflictId,
        admit: () => isCurrentConflictIntent(event),
      },
    );
    console.log(
      `[github] PR #${event.number} now conflicting → ${target.id}: ${res.status}`,
    );
    audit({
      msg: "github_pr_conflict_notified",
      pr_number: event.number,
      repo_id: event.repoId,
      head_ref: event.branch,
      session_id: target.id,
      matched_by: event.sessionRef === target.id ? "pr_footer" : "head_branch",
      delivery: res.status,
    });
    if (res.status !== "error") settleConflictIntent(event);
  } catch (error) {
    console.error(
      `[github] conflict notification failed for PR #${event.number}:`,
      error,
    );
  } finally {
    delivering.delete(key);
  }
}
