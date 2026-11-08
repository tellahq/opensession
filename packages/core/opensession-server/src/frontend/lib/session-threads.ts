/**
 * A session's threads: the sessions it started (and their own children),
 * which coordinator mode hands work to (server/coordinator.ts). Pure, so the
 * grouping and status lines can be tested without a browser.
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

/**
 * Whether `session` is in coordinator mode. Its own setting wins; without
 * one, the root session of a legacy space workspace coordinates.
 */
export function isCoordinating(
  session: Pick<
    UnifiedSession,
    "coordinator" | "parentSessionId" | "workspaceId"
  >,
  workspace: Pick<Workspace, "id" | "space"> | null | undefined,
): boolean {
  if (session.coordinator !== undefined) return session.coordinator;
  return (
    workspace?.space === true &&
    !session.parentSessionId &&
    session.workspaceId === workspace.id
  );
}

/** The sessions `rootId` started, and theirs in turn, newest first. */
export function sessionThreads(
  sessions: readonly UnifiedSession[],
  rootId: string,
): UnifiedSession[] {
  const inside = new Set([rootId]);
  const out: UnifiedSession[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const session of sessions)
      if (
        session.parentSessionId &&
        inside.has(session.parentSessionId) &&
        !inside.has(session.id)
      ) {
        inside.add(session.id);
        out.push(session);
        grew = true;
      }
  }
  return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
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

const SEEN_KEY = "opensession-threads-seen";
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

/** When this browser last had `sessionId` on screen, for its threads'
 *  catch-up (ms epoch). */
export function threadsSeenAt(
  sessionId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): number | null {
  return readSeen(storage)[sessionId] ?? null;
}

export function markThreadsSeen(
  sessionId: string,
  at: number,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): void {
  const seen = readSeen(storage);
  delete seen[sessionId];
  seen[sessionId] = at;
  // Keep the newest 200.
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
