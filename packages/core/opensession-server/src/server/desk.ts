/**
 * Desk — the per-user standing concierge session behind the summonable Desk
 * overlay (⌘J / the floating button). One durable ask-mode session per user
 * (session file flag `desk: true`, fixed title, hidden from the normal
 * regular session lists) that the user can open on top of whatever
 * they're doing: manage their todo list (todos.ts), ask quick questions, and
 * delegate real work to worker sessions via the opensession-sessions tools
 * every interactive run carries.
 *
 * Deliberately NOT an event feed — the deleted HQ feature (84f8bbfa) showed
 * that a passive event digest gets skipped. The Desk only ever speaks when
 * spoken to; the pull is the persistent todo list.
 */
import { existsSync, readFileSync } from "node:fs";
import { newSessionId, stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import {
  findSession,
  touchNativeSession,
  updateSessionFile,
} from "./session-cache";
import type { NativeSessionFile } from "./types";

interface DeskStore {
  users: Record<string, { sessionId?: string; clearedAt?: string }>;
}

const CONFIG_DIR = stateDir("desk");
const CONFIG_PATH = `${CONFIG_DIR}/config.json`;

function readStore(): DeskStore {
  try {
    if (existsSync(CONFIG_PATH))
      return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as DeskStore;
  } catch (e) {
    console.error("[desk] failed to read config:", e);
  }
  return { users: {} };
}

/** Desk turns should feel instant: quick capture / list ops / delegation,
 *  not deep reasoning — so the session defaults to Sonnet on low effort
 *  rather than the interactive dial. /model in the expanded view overrides. */
const DESK_MODEL = "pi/anthropic/claude-sonnet-5";
const DESK_EFFORT = "low";

/** Get or create the user's repo-less Desk session. */
export function ensureDeskSession(user: string): {
  sessionId: string;
  clearedAt?: string;
} {
  const store = readStore();
  const st = store.users[user] ?? (store.users[user] = {});
  const existing = st.sessionId ? findSession(st.sessionId) : undefined;
  if (st.sessionId && existing) {
    const patch: Partial<NativeSessionFile> = {};
    // Backfill the fast-model default onto Desks minted before it existed —
    // but never clobber a deliberate /model choice.
    if (!existing.model) {
      patch.model = DESK_MODEL;
      patch.effort = DESK_EFFORT;
    }
    // A Desk is a standing scratch session, never a project workspace. Older
    // Desks were stamped with the instance repo, which leaked into the expanded
    // viewer's breadcrumb and offered sibling tabs that do not belong here.
    if (
      !existing.repoLess ||
      existing.repo ||
      existing.worktreeDir ||
      existing.branch ||
      existing.workspaceId ||
      existing.attachedRepos?.length
    ) {
      patch.repo = undefined;
      patch.repoLess = true;
      patch.worktreeDir = "";
      patch.branch = "";
      patch.workspaceId = null;
      patch.attachedRepos = [];
    }
    if (Object.keys(patch).length > 0) touchNativeSession(st.sessionId, patch);
    return { sessionId: st.sessionId, clearedAt: st.clearedAt };
  }
  const id = newSessionId();
  const now = new Date().toISOString();
  // Field-scoped create via the serialized session-file writer — this site
  // owns every creation field (the fresh id means the file never pre-exists,
  // so the create-if-absent overlay is just belt-and-braces). Uncontended
  // writes run synchronously, so the caller can open the session immediately.
  updateSessionFile(id, (data) => {
    const existing: Partial<NativeSessionFile> = data;
    return {
      id,
      claudeSessionId: "",
      branch: "",
      worktreeDir: "",
      mode: "ask" as const,
      desk: true,
      repoLess: true,
      createdBy: user,
      createdAt: now,
      lastActivity: now,
      title: "Desk",
      model: DESK_MODEL,
      effort: DESK_EFFORT,
      ...existing,
    };
  }).catch((e) =>
    console.error(`[desk] failed to write Desk session ${id}:`, e),
  );
  st.sessionId = id;
  writeJsonAtomic(CONFIG_PATH, store);
  console.log(`[desk] created Desk session ${id} for ${user}`);
  return { sessionId: id, clearedAt: st.clearedAt };
}

/** "Clear" in the Desk overlay: hide everything before now from the modal's
 *  transcript view. A display marker only — the transcript itself is untouched and
 *  fully visible in the expanded session view. */
export function clearDesk(user: string): { clearedAt: string } {
  const store = readStore();
  const st = store.users[user] ?? (store.users[user] = {});
  st.clearedAt = new Date().toISOString();
  writeJsonAtomic(CONFIG_PATH, store);
  return { clearedAt: st.clearedAt };
}

/** The role charter prepended to every Desk-session prompt (run-session.ts). */
export const DESK_NOTE = `## Your role: the Desk

This session is the user's Desk — their standing concierge, summoned as a quick overlay on top of whatever they're doing. Discipline:

- Keep answers short and immediate; the user is mid-task and will close this overlay in seconds.
- Manage their todo list with the opensession-todos tools: capture items the moment they mention wanting/needing to do something ("I want to finish X today" → add_todo), mark things done when they say so, and use list_todos before answering "what's on my plate?".
- Ask mode only makes the repository checkout read-only; it does not prevent updating todos through their tools. If earlier messages in this Desk conversation claim otherwise, those refusals are outdated: correct them and use the requested Desk tool directly.
- You are an orchestrator, not the worker: for anything beyond a quick answer or a list edit, spawn a scoped worker session via opensession-sessions create_session and tell the user you did — never start long implementation work inside this session.
- Never drop a todo without the user asking; when in doubt, ask.`;
