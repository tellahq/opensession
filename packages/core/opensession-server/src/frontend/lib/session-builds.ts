// Which builds and rollouts the session's card shows, grouped per commit.
import type { SessionBuildWire } from "@tellahq/opensession-protocol/session";
import type { CheckVisual } from "./pr-checks";
import { hiddenIdStore } from "./hidden-ids";

/** An ended commit stays on screen this long, so its outcome is seen. A
 * failure stays until it is closed or a newer commit replaces it. */
export const ENDED_VISIBLE_MS = 5 * 60_000;

/** A rollout that reported "deploying" and then nothing for this long gets
 * no more news: a CD tool posts its result once per change, and a sync that
 * changed nothing it reports on may never post one. */
export const ROLLOUT_STALE_MS = 45 * 60_000;

/** The rollouts of one app, one entry per target (cluster, environment). */
export interface RolloutApp {
  app: string;
  targets: SessionBuildWire[];
}

/** Everything one commit started: a push's CI, or a merge's deploy. */
export interface BuildGroup {
  key: string;
  repo: string;
  sha: string;
  branch?: string;
  /** Set for the merge commit of this PR. */
  prNumber?: number;
  workflows: SessionBuildWire[];
  rollouts: RolloutApp[];
  live: boolean;
  failed: boolean;
  startedAt: string;
  /** When the last row ended, once none is live. */
  endedAt?: string;
}

/** The PR a deploy group shipped, else the commit a branch build ran on. */
export function buildGroupUrl(group: BuildGroup): string {
  const base = `https://github.com/${group.repo}`;
  return group.prNumber != null
    ? `${base}/pull/${group.prNumber}`
    : `${base}/commit/${group.sha}`;
}

export function buildVisual(state: SessionBuildWire["state"]): CheckVisual {
  switch (state) {
    case "queued":
    case "running":
      return "pending";
    case "success":
      return "success";
    case "failure":
      return "failure";
    case "cancelled":
      return "neutral";
  }
}

/** A run whose end never arrived (a webhook lost to a restart) stops
 * counting once even GitHub's job time limit would have ended it. */
const RUN_STALE_MS = 6 * 60 * 60_000;

/** Still going, and still likely to say how it ended. */
export function isBuildLive(b: SessionBuildWire, now: number): boolean {
  if (b.state !== "queued" && b.state !== "running") return false;
  const stale = b.kind === "rollout" ? ROLLOUT_STALE_MS : RUN_STALE_MS;
  return now - Date.parse(b.updatedAt) < stale;
}

/** The key a hide is stored under: closing a passing group does not hide a
 * failure that arrives later. */
export function hideKey(group: BuildGroup): string {
  return group.failed ? `${group.key}!` : group.key;
}

function toGroup(
  key: string,
  rows: SessionBuildWire[],
  now: number,
): BuildGroup {
  const first = rows[0]!;
  const byApp = new Map<string, SessionBuildWire[]>();
  const workflows: SessionBuildWire[] = [];
  for (const row of rows) {
    if (row.kind === "workflow") workflows.push(row);
    else byApp.set(row.title, [...(byApp.get(row.title) ?? []), row]);
  }
  const byStart = (a: SessionBuildWire, b: SessionBuildWire) =>
    a.startedAt.localeCompare(b.startedAt) || a.title.localeCompare(b.title);
  workflows.sort(byStart);
  const live = rows.some((r) => isBuildLive(r, now));
  const ends = rows.map((r) => r.endedAt ?? r.updatedAt).sort();
  const group: BuildGroup = {
    key,
    repo: first.repo,
    sha: first.sha,
    branch: rows.find((r) => r.branch)?.branch,
    prNumber: rows.find((r) => r.prNumber != null)?.prNumber,
    workflows,
    rollouts: [...byApp]
      .map(([app, targets]) => ({ app, targets: targets.sort(byStart) }))
      .sort((a, b) => a.app.localeCompare(b.app)),
    live,
    failed: rows.some((r) => r.state === "failure"),
    startedAt: rows.map((r) => r.startedAt).sort()[0]!,
  };
  if (!live) group.endedAt = ends[ends.length - 1];
  return group;
}

/**
 * The groups worth showing, oldest first so the newest sits by the composer:
 * only the newest commit of each branch and the newest merge, and of those
 * only the ones still running, failed, or ended a moment ago.
 */
export function visibleBuildGroups(
  builds: SessionBuildWire[],
  hidden: Set<string>,
  now: number,
): BuildGroup[] {
  const byCommit = new Map<string, SessionBuildWire[]>();
  for (const row of builds) {
    const key = `${row.repo.toLowerCase()}@${row.sha}`;
    byCommit.set(key, [...(byCommit.get(key) ?? []), row]);
  }
  const newestPerLane = new Map<string, BuildGroup>();
  for (const [key, rows] of byCommit) {
    const group = toGroup(key, rows, now);
    const lane =
      group.prNumber != null
        ? `merge:${group.repo.toLowerCase()}`
        : `branch:${group.repo.toLowerCase()}:${group.branch ?? ""}`;
    const prev = newestPerLane.get(lane);
    if (!prev || prev.startedAt < group.startedAt)
      newestPerLane.set(lane, group);
  }
  return [...newestPerLane.values()]
    .filter(
      (g) =>
        !hidden.has(hideKey(g)) &&
        (g.live ||
          g.failed ||
          (g.endedAt != null &&
            now - Date.parse(g.endedAt) < ENDED_VISIBLE_MS)),
    )
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** What the session view needs to know about the groups: whether there is a
 * flap at all, and whether one is still running (which sets how often the
 * clock ticks). Only a change here re-renders the session view. */
export function buildsFlapStatus(
  groups: BuildGroup[],
): "none" | "live" | "ended" {
  if (!groups.length) return "none";
  return groups.some((g) => g.live) ? "live" : "ended";
}

/** One clock for every builds row, read through useSyncExternalStore, so a
 * tick re-renders only what reads the time it moved. */
export function createBuildsClock(now = Date.now()) {
  const listeners = new Set<() => void>();
  return {
    get: () => now,
    set(next: number) {
      now = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type BuildsClock = ReturnType<typeof createBuildsClock>;

const hiddenGroups = hiddenIdStore("opensession-hidden-build-groups");

export function hiddenBuildGroupKeys(now = Date.now()): Set<string> {
  return hiddenGroups.ids(now);
}

export function hideBuildGroup(group: BuildGroup, now = Date.now()): void {
  hiddenGroups.hide(hideKey(group), now);
}
