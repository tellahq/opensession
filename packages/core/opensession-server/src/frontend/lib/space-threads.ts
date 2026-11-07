/**
 * A space's threads: the sessions its coordinator (and their own children)
 * started inside the space's workspace (server/spaces.ts). Pure, so the
 * grouping, status lines and the "since you were last here" recap can be
 * tested without a browser.
 */

import {
  parseMcpTool,
  unwrapMcpDispatcher,
} from "@tellahq/opensession-protocol/tool-presentation";
import { z } from "zod";
import type { TranscriptEntry, UnifiedSession, Workspace } from "./types";

/** Where a thread stands, in the order the panel lists them. */
export type ThreadState = "blocked" | "ready" | "working" | "idle" | "shipped";

export const THREAD_STATE_ORDER: readonly ThreadState[] = [
  "blocked",
  "ready",
  "working",
  "idle",
  "shipped",
];

export const THREAD_STATE_LABEL: Record<ThreadState, string> = {
  blocked: "Blocked",
  ready: "Ready to ship",
  working: "Working",
  idle: "Idle",
  shipped: "Shipped",
};

/** Whether `workspace` is a space. */
export function isSpaceWorkspace(
  workspace: Pick<Workspace, "space"> | null | undefined,
): boolean {
  return workspace?.space === true;
}

/** Whether `session` is a root (coordinator) session of the space it sits in. */
export function isSpaceCoordinator(
  session: Pick<UnifiedSession, "parentSessionId" | "workspaceId">,
  workspace: Pick<Workspace, "id" | "space"> | null | undefined,
): boolean {
  return (
    isSpaceWorkspace(workspace) &&
    !session.parentSessionId &&
    session.workspaceId === workspace?.id
  );
}

/** Every thread in the space: its sessions that have a parent, newest first. */
export function spaceThreads(
  sessions: readonly UnifiedSession[],
  workspaceId: string,
): UnifiedSession[] {
  return sessions
    .filter(
      (session) =>
        session.workspaceId === workspaceId && !!session.parentSessionId,
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function threadState(session: UnifiedSession): ThreadState {
  if (session.prState === "MERGED" || session.manualStatus === "merged")
    return "shipped";
  if (session.waitingForInput || session.manualStatus === "needsinput")
    return "blocked";
  if (
    session.isRunning ||
    (session.queuedCount ?? 0) > 0 ||
    session.workspacePreparing
  )
    return "working";
  if (session.lastRunError) return "blocked";
  if (session.prState === "OPEN" && !session.prIsDraft) return "ready";
  return "idle";
}

/** One short line saying where a thread is, from what the list carries. */
export function threadStatusLine(session: UnifiedSession): string {
  const state = threadState(session);
  const pr = session.prNumber ? `#${session.prNumber}` : "PR";
  switch (state) {
    case "shipped":
      return session.prNumber ? `Merged ${pr}` : "Shipped";
    case "blocked":
      return session.waitingForInput
        ? "Waiting for an answer"
        : session.lastRunError
          ? "Run failed"
          : "Needs input";
    case "working":
      return session.workspacePreparing ? "Preparing its workspace" : "Working";
    case "ready": {
      const checks = session.prChecks;
      const verdict = !checks?.total
        ? "open"
        : checks.failed > 0
          ? "checks failing"
          : checks.pending > 0
            ? "checks running"
            : "checks passing";
      return `${pr} ${verdict}`;
    }
    case "idle":
      if (session.prState === "OPEN") return `Draft ${pr}`;
      if (session.prState === "CLOSED") return `${pr} closed`;
      return session.mode === "ask" ? "Answered" : "Idle";
  }
}

export interface GroupedThreads {
  state: ThreadState;
  threads: UnifiedSession[];
}

/** Threads by state in panel order; empty groups left out. */
export function groupThreads(threads: readonly UnifiedSession[]) {
  const groups: GroupedThreads[] = [];
  for (const state of THREAD_STATE_ORDER) {
    const inState = threads.filter((thread) => threadState(thread) === state);
    if (inState.length) groups.push({ state, threads: inState });
  }
  return groups;
}

/** What changed in a space since a person last looked at it. */
export interface SpaceRecap {
  started: UnifiedSession[];
  shipped: UnifiedSession[];
  ready: UnifiedSession[];
  blocked: UnifiedSession[];
}

/**
 * The recap for someone who last looked at the space at `seenAt` (ms epoch).
 * Blocked threads count whenever they changed since; they are what needs the
 * person. Null when nothing changed, or when they have never looked.
 */
export function spaceRecap(
  threads: readonly UnifiedSession[],
  seenAt: number | null,
): SpaceRecap | null {
  if (seenAt === null) return null;
  const changed = threads.filter(
    (thread) => Date.parse(thread.lastActivity) > seenAt,
  );
  const recap: SpaceRecap = {
    started: changed.filter((thread) => Date.parse(thread.createdAt) > seenAt),
    shipped: changed.filter((thread) => threadState(thread) === "shipped"),
    ready: changed.filter((thread) => threadState(thread) === "ready"),
    blocked: changed.filter((thread) => threadState(thread) === "blocked"),
  };
  const empty =
    !recap.started.length &&
    !recap.shipped.length &&
    !recap.ready.length &&
    !recap.blocked.length;
  return empty ? null : recap;
}

const SEEN_KEY = "opensession-space-seen";
const seenSchema = z.record(z.string(), z.number());

function readSeen(storage: Pick<Storage, "getItem">) {
  try {
    const parsed = seenSchema.safeParse(
      JSON.parse(storage.getItem(SEEN_KEY) ?? "{}"),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** When this browser last had `workspaceId`'s space on screen (ms epoch). */
export function spaceSeenAt(
  workspaceId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): number | null {
  return readSeen(storage)[workspaceId] ?? null;
}

export function markSpaceSeen(
  workspaceId: string,
  at: number,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): void {
  const seen = readSeen(storage);
  delete seen[workspaceId];
  seen[workspaceId] = at;
  // Keep the newest 200 spaces.
  const kept = Object.fromEntries(Object.entries(seen).slice(-200));
  try {
    storage.setItem(SEEN_KEY, JSON.stringify(kept));
  } catch {
    /* private mode: the recap just shows again next time */
  }
}

/**
 * The thread a spawn_task or create_session call started, read from the
 * call's result (`Spawned task \`bks-…\``). Null for any other tool, a call
 * still running, or a failed one.
 */
export function spawnedThreadId(
  rawName: string,
  rawInput: TranscriptEntry["toolInput"],
  result: string | undefined,
): string | null {
  const { toolName } = unwrapMcpDispatcher(rawName, rawInput);
  const mcp = parseMcpTool(toolName);
  if (mcp?.server !== "opensession-sessions") return null;
  if (mcp.tool !== "spawn_task" && mcp.tool !== "create_session") return null;
  const match = result?.match(
    /^(?:Spawned task|Started session) `([A-Za-z0-9_-]+)`/,
  );
  return match?.[1] ?? null;
}

const promptSchema = z.object({ prompt: z.string() });

/** The prompt a spawn_task or create_session call started its thread on. */
export function spawnedThreadPrompt(
  rawName: string,
  rawInput: TranscriptEntry["toolInput"],
): string {
  const { input } = unwrapMcpDispatcher(rawName, rawInput);
  const parsed = promptSchema.safeParse(input);
  return parsed.success ? parsed.data.prompt : "";
}
