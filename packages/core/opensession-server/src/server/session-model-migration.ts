/**
 * Migrate a opensession session onto another engine — the "flip the model, let
 * the next turn hand off" affordance behind the opensession-sessions
 * `migrate_session_engine` tool and scripts/migrate-sessions-to-pi.ts.
 *
 * Deliberately does NOT start a run: it only sets `session.model` to an
 * engine-routed id (recording the switch in modelHistory, exactly like a
 * /model command). The session's NEXT prompt takes the normal cross-engine
 * path in runSessionPromptInner: the engine changed ⇒ the prior engine's
 * transcript becomes an engine-switch handoff note, a fresh session starts on
 * the target engine carrying it, and the new id is persisted in that engine's
 * slot. The session keeps its file, workspace, branch, title and UI history —
 * only the engine changes.
 *
 * Hard gates (fail closed):
 *  - automation-owned sessions may move to Pi, which supports unattended run
 *    kinds, but not to another engine.
 *  - sessions with an in-flight run (per the shared run journal): flipping the
 *    model mid-turn races the run's own end-of-turn session patch.
 *  - targets that don't name an engine.
 */
import { executeSessionProjection } from "./session-projection-executor";
import { existsSync, readFileSync } from "fs";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { explicitEngineFor, resolveModel } from "./models";
import type { ActiveRunRecord } from "./run-journal";
import type { NativeSessionFile } from "./types";

export type MigrateEngineResult =
  | { ok: true; sessionId: string; from?: string; to: string }
  | { ok: false; error: string };

function readJson<T>(path: string): T | null {
  try {
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf-8")) as T)
      : null;
  } catch {
    return null;
  }
}

/** Journal read (file-level, not via claude-runner's in-memory maps) so this
 *  module stays import-light and usable from standalone scripts. */
function journaledRuns(): ActiveRunRecord[] {
  const path =
    process.env.OPENSESSION_RUN_JOURNAL ||
    `${OPENSESSION_SESSIONS_DIR}/active-runs.json`;
  const journal = readJson<Record<string, ActiveRunRecord>>(path);
  return journal ? Object.values(journal) : [];
}

export function isAutomationOwnedSession(
  data: Pick<NativeSessionFile, "automation" | "createdBy">,
): boolean {
  return !!data.automation || !!data.createdBy?.endsWith(" (automation)");
}

/** Whether the shared run journal shows an in-flight run for this session. */
export function sessionHasJournaledRun(
  sessionId: string,
  data?: Pick<
    NativeSessionFile,
    "claudeSessionId" | "codexThreadId" | "piSessionId"
  >,
): boolean {
  const engineIds = new Set(
    [
      sessionId,
      data?.claudeSessionId,
      data?.codexThreadId,
      data?.piSessionId,
    ].filter(Boolean) as string[],
  );
  return journaledRuns().some(
    (r) =>
      (r.osSessionId && engineIds.has(r.osSessionId)) ||
      (r.claudeSessionId && engineIds.has(r.claudeSessionId)) ||
      engineIds.has(r.runKey),
  );
}

/**
 * Flip an Open Session session's model to an engine-routed id so its next turn
 * migrates via the transcript handoff. Pure session-file operation. See the
 * module doc for what it deliberately does not do.
 */
export async function migrateSessionEngine(
  sessionId: string,
  targetModel: string,
  by = "engine-migration",
  options: { preserveActivity?: boolean } = {},
): Promise<MigrateEngineResult> {
  const path = `${OPENSESSION_SESSIONS_DIR}/${sessionId}.json`;
  const data = readJson<NativeSessionFile>(path);
  if (!data?.id) {
    return {
      ok: false,
      error: `No opensession session file for "${sessionId}".`,
    };
  }

  const resolved = resolveModel(targetModel);
  // The target must NAME an engine: an engine-prefixed id, or a preset id
  // (dial/…, orchestrator/…) which the pi engine resolves at dispatch. A
  // bare native slug ("claude-opus-5") names a model, not an engine, and is
  // rejected the way it always was.
  const engine = resolved ? explicitEngineFor(resolved.id) : null;
  if (!resolved || !engine) {
    return {
      ok: false,
      error:
        `"${targetModel}" is not an engine model id — expected ` +
        "pi/<provider>/<model>, e.g. pi/anthropic/claude-opus-5.",
    };
  }
  if (isAutomationOwnedSession(data) && engine !== "pi") {
    return {
      ok: false,
      error:
        `Session ${sessionId} is automation-owned ("${data.automation || data.createdBy}"). ` +
        "Automation sessions can only migrate to Pi.",
    };
  }

  if (sessionHasJournaledRun(sessionId, data)) {
    return {
      ok: false,
      error: `Session ${sessionId} has an in-flight run — let it finish (or cancel it) before migrating.`,
    };
  }

  if (data.model === resolved.id) {
    return { ok: true, sessionId, from: data.model, to: resolved.id };
  }

  const from = data.model;
  await executeSessionProjection(sessionId, "model_migration", () =>
    writeJsonAtomic(path, {
      ...data,
      model: resolved.id,
      modelHistory: [
        ...(data.modelHistory || []),
        { model: resolved.id, from, at: new Date().toISOString(), by },
      ],
      ...(options.preserveActivity
        ? {}
        : { lastActivity: new Date().toISOString() }),
    }),
  );
  return { ok: true, sessionId, from, to: resolved.id };
}
