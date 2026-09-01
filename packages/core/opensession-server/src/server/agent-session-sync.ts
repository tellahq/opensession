/**
 * Engine-session sync for agent-owned session stores (~/.slack-sessions,
 * ~/.linear-sessions).
 *
 * Those stores belong to the Slack/Linear loops and the server treats them as
 * read-only — with this one deliberate exception. When an interactive run on a
 * slack/linear-source session mints a NEW engine session id (first run, engine
 * rotation, or a cross-provider usage/infra fallback), the id previously lived
 * only in the runner's journal: the session file kept pointing at the dead
 * engine session, so the UI transcript froze there, queued prompts forked the
 * stale thread, and the owning loop's next turn resumed it too (2026-07-16,
 * slack-can-you-try: a mid-turn Opus→Sol fallback minted ses_09528e… while
 * both slack files still said ses_099d38…). The owning loops persist ids only
 * for runs THEY drive, so runs driven from the web UI must sync the store
 * themselves.
 *
 * Writes are surgical: only existing files are patched (never created), only
 * the engine-session fields are touched, and the shape matches what the
 * owners write (atomic JSON; slack/linear files carry the pi id in the
 * claude slot). Pi engine ids get their own `piSessionId` slot — pi uuids are
 * shape-indistinguishable from claude ids, so the claude slot alone can't
 * say which engine owns the id (the run-start arm in run-session resolved
 * undefined and minted a fresh pi session every web-UI turn) — while a
 * claude-slot mirror still rides along, because the owning loops' own resume
 * paths read that slot (slack handlers pass session.claudeSessionId). The
 * slack loop's in-memory session is updated too so a thread reply arriving
 * before its next disk load doesn't resurrect the stale id.
 */

import { existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { statePath } from "./paths";
import {
  activeSessions as slackActiveSessions,
  getSessionKey as slackSessionKey,
  SESSION_DIR as SLACK_SESSION_DIR,
} from "../agents/slack/state";
import type { UnifiedSession } from "./types";

// statePath: isolated under OPENSESSION_STATE_DIR for dev/demo instances,
// $HOME when unset (production, unchanged) — see sessions.ts's store block.
const LINEAR_SESSION_DIR = statePath(".linear-sessions");

export interface EngineSessionPatch {
  engineSessionId?: string;
  /** Pi engine session id — lands in the file's own piSessionId slot AND
   *  mirrors into the claude slot (see module doc). Callers pick this field
   *  over engineSessionId when the run's provider is "pi". */
  piSessionId?: string;
  model?: string;
}

function patchFile(
  path: string,
  patch: EngineSessionPatch,
  activityField: string,
): boolean {
  if (!existsSync(path)) return false;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    let changed = false;
    if (
      patch.engineSessionId &&
      data.claudeSessionId !== patch.engineSessionId
    ) {
      data.claudeSessionId = patch.engineSessionId;
      changed = true;
    }
    if (patch.piSessionId) {
      if (data.piSessionId !== patch.piSessionId) {
        data.piSessionId = patch.piSessionId;
        changed = true;
      }
      if (data.claudeSessionId !== patch.piSessionId) {
        data.claudeSessionId = patch.piSessionId;
        changed = true;
      }
    }
    if (patch.model && data.model !== patch.model) {
      data.model = patch.model;
      changed = true;
    }
    if (!changed) return false;
    data[activityField] = new Date().toISOString();
    writeJsonAtomic(path, data);
    return true;
  } catch (e) {
    console.error(`[agent-session-sync] failed to patch ${path}:`, e);
    return false;
  }
}

/**
 * Persist a new engine session id (and/or model) for a slack/linear-source
 * session. No-op for other sources and for empty patches. Returns true when
 * anything was actually written.
 */
export function syncAgentSessionEngine(
  session: Pick<UnifiedSession, "id" | "source" | "branch" | "slackThread">,
  patch: EngineSessionPatch,
): boolean {
  if (!patch.engineSessionId && !patch.piSessionId && !patch.model)
    return false;

  if (session.source === "slack") {
    // Both file shapes exist: the key-named file the loop owns
    // (<channel>-<threadTs>.json) and the branch-named mirror written by
    // `wt new-slack` — the sessions scan ids off either, so patch both.
    const files = new Set<string>();
    files.add(`${SLACK_SESSION_DIR}/${session.id.replace(/^slack-/, "")}.json`);
    if (session.slackThread?.channel)
      files.add(
        `${SLACK_SESSION_DIR}/${slackSessionKey(session.slackThread.channel, session.slackThread.threadTs || undefined)}.json`,
      );
    if (session.branch)
      files.add(`${SLACK_SESSION_DIR}/${session.branch}.json`);
    let wrote = false;
    for (const f of files) wrote = patchFile(f, patch, "lastActivity") || wrote;

    // The loop's live copy, so an in-flight thread doesn't fork the old id.
    if (session.slackThread?.channel) {
      const live = slackActiveSessions.get(
        slackSessionKey(
          session.slackThread.channel,
          session.slackThread.threadTs || undefined,
        ),
      );
      if (live) {
        if (patch.engineSessionId) live.claudeSessionId = patch.engineSessionId;
        // The loop's resume path reads claudeSessionId — the mirror is what
        // keeps its next thread-driven turn on the fresh pi session.
        if (patch.piSessionId) live.claudeSessionId = patch.piSessionId;
        if (patch.model) live.model = patch.model;
      }
    }
    return wrote;
  }

  if (session.source === "linear") {
    if (!session.branch) return false;
    return patchFile(
      `${LINEAR_SESSION_DIR}/${session.branch}.json`,
      patch,
      "updatedAt",
    );
  }

  return false;
}
