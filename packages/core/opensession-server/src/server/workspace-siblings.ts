/**
 * Workspace siblings note: the first turn of a session in a workspace learns
 * which other conversations already live there.
 *
 * A workspace is one piece of work, and people expect a new chat in it to
 * know what its siblings did without attaching anything by hand. Inlining
 * every sibling transcript would be expensive and cloud an unrelated task,
 * so the note is an index: title, state, PR, the last ask and a one-line
 * outcome per sibling. The agent reads a full transcript with the
 * opensession-sessions `get_session` tool only when one matters.
 *
 * Siblings come from the cached session list (a memory projection), capped
 * at MAX_SIBLINGS, and each one costs a single bounded transcript tail read.
 */

import { isContextInjection } from "@tellahq/opensession-protocol/notices";
import { transcript } from "./actor-transcript";
import { getCachedSessionsAsync } from "./session-cache";
import type { TranscriptEntry, UnifiedSession } from "./types";
import { getWorkspace } from "./workspaces";

const MAX_SIBLINGS = 8;
const TAIL_ENTRIES = 40;
const ASK_CHARS = 200;
const OUTCOME_CHARS = 240;

export interface WorkspaceSibling {
  id: string;
  title: string;
  isRunning: boolean;
  lastActivity: string;
  branch?: string | null;
  prNumber?: number;
  prState?: string;
  lastAsk?: string;
  lastAnswer?: string;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Text of a message with any fenced harness context removed. */
function spokenText(entry: TranscriptEntry): string {
  return entry.content
    .replace(
      /<(opensession|backstage):context[^>]*>[\s\S]*?<\/\1:context>/g,
      "",
    )
    .trim();
}

/** The last human ask and the last assistant answer in a transcript tail. */
export function lastExchange(entries: readonly TranscriptEntry[]): {
  lastAsk?: string;
  lastAnswer?: string;
} {
  let lastAsk: string | undefined;
  let lastAnswer: string | undefined;
  for (let i = entries.length - 1; i >= 0 && !(lastAsk && lastAnswer); i--) {
    const entry = entries[i];
    if (isContextInjection(entry)) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const text = spokenText(entry);
    if (!text) continue;
    if (entry.type === "user" && !lastAsk) lastAsk = oneLine(text, ASK_CHARS);
    if (entry.type === "assistant" && !lastAnswer && !lastAsk)
      lastAnswer = oneLine(text, OUTCOME_CHARS);
  }
  return { lastAsk, lastAnswer };
}

function relativeAge(iso: string, now: number): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function buildWorkspaceSiblingsNote(input: {
  workspaceName?: string;
  siblings: readonly WorkspaceSibling[];
  more: number;
  now?: number;
}): string | null {
  if (!input.siblings.length) return null;
  const now = input.now ?? Date.now();
  const sections = input.siblings.map((s) => {
    const age = relativeAge(s.lastActivity, now);
    const state = s.isRunning ? "running" : age ? `idle · ${age}` : "idle";
    const pr = s.prNumber
      ? `PR #${s.prNumber}${s.prState ? ` ${s.prState.toLowerCase()}` : ""}`
      : null;
    const head = [
      `- ${s.title || "Untitled session"} · @session:${s.id}`,
      state,
      s.branch ? `branch ${s.branch}` : null,
      pr,
    ]
      .filter(Boolean)
      .join(" · ");
    const lines = [head];
    if (s.lastAsk) lines.push(`  Last ask: ${s.lastAsk}`);
    if (s.lastAnswer) lines.push(`  Outcome: ${s.lastAnswer}`);
    return lines.join("\n");
  });
  const where = input.workspaceName
    ? `the workspace "${input.workspaceName}"`
    : "this workspace";
  return [
    `## Other sessions in ${where}`,
    "This session is one of several conversations on the same piece of work. Treat what they asked and did as shared background, and do not redo or contradict finished work without reason. Excerpts are short: when one of them bears on the request, read it with the opensession-sessions `get_session` tool and the session id shown.",
    sections.join("\n"),
    input.more > 0
      ? `${input.more} older session${input.more === 1 ? "" : "s"} not listed.`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function hasRun(s: UnifiedSession): boolean {
  return !!(
    s.claudeSessionId ||
    s.codexThreadId ||
    s.piSessionId ||
    s.transcriptPath
  );
}

/** The siblings note for a session's first turn, or null when it has none. */
export async function workspaceSiblingsNoteFor(session: {
  id: string;
  workspaceId?: string | null;
  workspaceName?: string;
}): Promise<string | null> {
  const workspaceId = session.workspaceId;
  if (!workspaceId) return null;
  // No list (catalog unavailable): start without the note rather than fail.
  const sessions = await getCachedSessionsAsync("exclude").catch(() => null);
  if (!sessions) return null;
  const candidates = sessions
    .filter(
      (s) =>
        s.workspaceId === workspaceId &&
        s.id !== session.id &&
        !s.archived &&
        !s.automation &&
        hasRun(s),
    )
    .sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""));
  if (!candidates.length) return null;
  const shown = candidates.slice(0, MAX_SIBLINGS);
  const siblings = await Promise.all(
    shown.map(async (s): Promise<WorkspaceSibling> => {
      const exchange = await transcript
        .readTail(s.id, TAIL_ENTRIES)
        .then((page) => lastExchange(page.entries))
        .catch(() => ({}));
      return {
        id: s.id,
        title: s.title,
        isRunning: s.isRunning,
        lastActivity: s.lastActivity,
        branch: s.branch,
        prNumber: s.prNumber,
        prState: s.prState,
        ...exchange,
      };
    }),
  );
  return buildWorkspaceSiblingsNote({
    workspaceName:
      session.workspaceName ??
      (await getWorkspace(workspaceId).catch(() => null))?.name,
    siblings,
    more: candidates.length - shown.length,
  });
}
