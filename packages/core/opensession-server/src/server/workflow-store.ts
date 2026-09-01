/**
 * Workflow persistence + live registry + broadcast.
 *
 * Disk layout: ~/.opensession-workflows/<runId>/ with
 *   run.json      — WorkflowRunSnapshot (the UI payload)
 *   journal.jsonl — one record per completed agent(), mcp.* or durable-session
 *                   API call. This is the resume-replay unit and the UI's
 *                   agent drill-in detail.
 *   script.mjs    — the workflow script source, verbatim
 * Tests point OPENSESSION_WORKFLOWS_DIR at a tmp dir.
 *
 * Live state is parked on globalThis (same pattern as queue-state.ts /
 * asks.ts) so a `bun --hot` reload keeps running workflows' snapshots and
 * cancel hooks intact. Every snapshot change broadcasts a `workflow_update`
 * to the session's watchers — wrapped in try/catch so ws fan-out can never
 * take down a store write.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "fs";
import { stateDir } from "./paths";
import { writeFileAtomic, writeJsonAtomic } from "./shared/atomic-write";
import { broadcastSessionActivityStatus, broadcastToSession } from "./ws-hub";
import {
  holdSessionRunning,
  releaseSessionRunning,
} from "./session-state-events";
import {
  WORKFLOW_LIMITS,
  type WorkflowJournalRecord,
  type WorkflowRecoverySnapshot,
  type WorkflowRunSnapshot,
  type WorkflowStateCasResult,
  type WorkflowStateValue,
} from "./workflow-types";
import {
  workflowPhaseStats,
  workflowWarnings,
} from "../shared/workflow-observability";

const g = globalThis as any;

export type WorkflowAgentControlAction = "skip" | "retry";

export interface WorkflowLiveControls {
  cancel: () => void;
  pause: (reason?: string) => boolean;
  resume: () => boolean;
  controlAgent: (seq: number, action: WorkflowAgentControlAction) => boolean;
}

type LiveWorkflow = {
  snapshot: WorkflowRunSnapshot;
  controls: WorkflowLiveControls;
};

const NOOP_CONTROLS: WorkflowLiveControls = {
  cancel: () => {},
  pause: () => false,
  resume: () => false,
  controlAgent: () => false,
};

function workflowRunningKey(runId: string): string {
  return `workflow:${runId}`;
}

/** runId → live snapshot + cancel hook (hot-reload survivable). */
const liveWorkflows: Map<string, LiveWorkflow> = (g.__opensessionWorkflows ??=
  new Map());

function workflowsDir(): string {
  return process.env.OPENSESSION_WORKFLOWS_DIR || stateDir("workflows");
}

function runDir(runId: string): string {
  return `${workflowsDir()}/${runId}`;
}

// readdir results for the list scan, invalidated on create and after a short
// TTL (list is polled by the UI; the dirent scan is the only part worth
// caching — run.json reads stay fresh).
let direntCache: { dir: string; at: number; names: string[] } | null = null;
const DIRENT_CACHE_MS = 2_000;

function runIdsOnDisk(): string[] {
  const dir = workflowsDir();
  const now = Date.now();
  if (
    direntCache &&
    direntCache.dir === dir &&
    now - direntCache.at < DIRENT_CACHE_MS
  ) {
    return direntCache.names;
  }
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.startsWith("wf-"));
  } catch {}
  direntCache = { dir, at: now, names };
  return names;
}

function readRunJson(runId: string): WorkflowRunSnapshot | undefined {
  try {
    return JSON.parse(
      readFileSync(`${runDir(runId)}/run.json`, "utf-8"),
    ) as WorkflowRunSnapshot;
  } catch {
    return undefined;
  }
}

function persistSnapshot(snapshot: WorkflowRunSnapshot): void {
  mkdirSync(runDir(snapshot.runId), { recursive: true });
  writeJsonAtomic(`${runDir(snapshot.runId)}/run.json`, snapshot);
}

function broadcastSnapshot(snapshot: WorkflowRunSnapshot): void {
  // ws-hub must never crash a store write.
  try {
    broadcastToSession(snapshot.sessionId, {
      type: "workflow_update",
      sessionId: snapshot.sessionId,
      run: snapshot,
    });
  } catch {}
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** Keep snapshot payloads bounded no matter what a mutator wrote — the
 *  snapshot is persisted AND re-broadcast to every session watcher on each
 *  mutation, so every string a script can influence (labels, log lines,
 *  errors, phase titles) gets capped here, not just the previews. */
function refreshDerivedProgress(snapshot: WorkflowRunSnapshot): void {
  snapshot.phaseStats = workflowPhaseStats(snapshot);
  snapshot.warnings = workflowWarnings(snapshot);
}

function enforceSnapshotLimits(snapshot: WorkflowRunSnapshot): void {
  for (const session of snapshot.sessions || []) {
    session.label = truncate(session.label || "", 200);
    session.repo = truncate(session.repo || "", 200);
    session.branch = truncate(session.branch || "", 500);
    session.worktreeDir = session.worktreeDir
      ? truncate(session.worktreeDir, 1_000)
      : undefined;
    session.prUrl = session.prUrl ? truncate(session.prUrl, 1_000) : undefined;
    session.error = session.error ? truncate(session.error, 1_000) : undefined;
  }
  for (const agent of snapshot.agents) {
    agent.label = truncate(agent.label || "", 200);
    agent.promptPreview = truncate(
      agent.promptPreview || "",
      WORKFLOW_LIMITS.previewChars,
    );
    if (agent.resultPreview !== undefined) {
      agent.resultPreview = truncate(
        agent.resultPreview,
        WORKFLOW_LIMITS.previewChars,
      );
    }
    if (agent.error !== undefined) agent.error = truncate(agent.error, 1000);
  }
  if (snapshot.error !== undefined)
    snapshot.error = truncate(snapshot.error, 2000);
  if (snapshot.phases.length > 100)
    snapshot.phases = snapshot.phases.slice(0, 100);
  if (snapshot.logs.length > WORKFLOW_LIMITS.maxLogLines) {
    snapshot.logs = snapshot.logs.slice(-WORKFLOW_LIMITS.maxLogLines);
  }
  for (const l of snapshot.logs) l.message = truncate(l.message, 500);
}

export function createWorkflowRun(init: {
  runId: string;
  replayRootRunId?: string;
  sessionId: string;
  name: string;
  description?: string;
  phases: string[];
  user?: string;
  cwd: string;
  script: string;
  recovery?: WorkflowRecoverySnapshot;
}): WorkflowRunSnapshot {
  const snapshot: WorkflowRunSnapshot = {
    runId: init.runId,
    ...(init.replayRootRunId ? { replayRootRunId: init.replayRootRunId } : {}),
    sessionId: init.sessionId,
    name: init.name,
    ...(init.description !== undefined
      ? { description: init.description }
      : {}),
    status: "running",
    ...(init.recovery ? { recovery: init.recovery } : {}),
    phases: [...init.phases],
    agents: [],
    sessions: [],
    logs: [],
    startedAt: new Date().toISOString(),
    totals: { agents: 0, tokensIn: 0, tokensOut: 0 },
    ...(init.user !== undefined ? { user: init.user } : {}),
    cwd: init.cwd,
  };
  refreshDerivedProgress(snapshot);
  persistSnapshot(snapshot);
  writeFileAtomic(`${runDir(init.runId)}/script.mjs`, init.script);
  direntCache = null;
  // Park the snapshot in the live map now; registerLiveWorkflow fills in the
  // real cancel hook once the runner has one.
  const existing = liveWorkflows.get(init.runId);
  liveWorkflows.set(init.runId, {
    snapshot,
    controls: existing?.controls ?? NOOP_CONTROLS,
  });
  holdSessionRunning(init.sessionId, workflowRunningKey(init.runId));
  broadcastSnapshot(snapshot);
  broadcastSessionActivityStatus(init.sessionId, true);
  return snapshot;
}

/** Apply a mutation, persist run.json, broadcast. Returns the snapshot, or
 *  undefined when the run doesn't exist (live or on disk). */
export function updateWorkflowRun(
  runId: string,
  mutate: (s: WorkflowRunSnapshot) => void,
): WorkflowRunSnapshot | undefined {
  const snapshot = liveWorkflows.get(runId)?.snapshot ?? readRunJson(runId);
  if (!snapshot) return undefined;
  mutate(snapshot);
  refreshDerivedProgress(snapshot);
  enforceSnapshotLimits(snapshot);
  persistSnapshot(snapshot);
  broadcastSnapshot(snapshot);
  return snapshot;
}

export function getWorkflowRun(runId: string): WorkflowRunSnapshot | undefined {
  return liveWorkflows.get(runId)?.snapshot ?? readRunJson(runId);
}

/** The run's script source (script.mjs), for resume without a new script. */
export function readWorkflowScript(runId: string): string | undefined {
  try {
    return readFileSync(`${runDir(runId)}/script.mjs`, "utf8");
  } catch {
    return undefined;
  }
}

/** All of a session's runs, newest first. */
export function listWorkflowRunsForSession(
  sessionId: string,
): WorkflowRunSnapshot[] {
  const runs: WorkflowRunSnapshot[] = [];
  for (const runId of runIdsOnDisk()) {
    const snapshot = liveWorkflows.get(runId)?.snapshot ?? readRunJson(runId);
    if (snapshot?.sessionId === sessionId) runs.push(snapshot);
  }
  runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return runs;
}

type PersistedWorkflowState = {
  entries: Record<string, { version: number; value: unknown }>;
  operations: Record<string, WorkflowStateCasResult>;
};

function workflowStatePath(scopeId: string): string {
  return `${runDir(scopeId)}/state.json`;
}

function validStateKey(key: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key))
    throw new Error("Workflow state keys must be 1-128 safe characters");
}

function readState(scopeId: string): PersistedWorkflowState {
  let raw: string;
  try {
    raw = readFileSync(workflowStatePath(scopeId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      return { entries: {}, operations: {} };
    throw error;
  }
  if (Buffer.byteLength(raw) > WORKFLOW_LIMITS.maxStateBytes)
    throw new Error(`Workflow state for ${scopeId} exceeds the byte limit`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Workflow state for ${scopeId} is corrupt JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`Workflow state for ${scopeId} has an invalid shape`);
  const candidate = parsed as Partial<PersistedWorkflowState>;
  const entries = candidate.entries;
  const operations = candidate.operations;
  if (
    !entries ||
    typeof entries !== "object" ||
    Array.isArray(entries) ||
    !operations ||
    typeof operations !== "object" ||
    Array.isArray(operations)
  )
    throw new Error(`Workflow state for ${scopeId} has an invalid shape`);
  if (Object.keys(entries).length > WORKFLOW_LIMITS.maxStateKeys)
    throw new Error(`Workflow state for ${scopeId} exceeds the key limit`);
  for (const [key, row] of Object.entries(entries)) {
    try {
      validStateKey(key);
    } catch {
      throw new Error(`Workflow state key ${key} is corrupt`);
    }
    const valueEncoded = row && JSON.stringify(row.value);
    if (
      !row ||
      typeof row !== "object" ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1 ||
      !("value" in row) ||
      valueEncoded === undefined ||
      valueEncoded.length > 250_000
    )
      throw new Error(`Workflow state key ${key} is corrupt`);
  }
  for (const [operationId, result] of Object.entries(operations)) {
    const valueEncoded = result && JSON.stringify(result.value);
    let validKey = true;
    try {
      if (result && typeof result.key === "string") validStateKey(result.key);
      else validKey = false;
    } catch {
      validKey = false;
    }
    if (
      !operationId ||
      operationId.length > 200 ||
      !result ||
      typeof result !== "object" ||
      !validKey ||
      typeof result.swapped !== "boolean" ||
      !Number.isSafeInteger(result.version) ||
      result.version < 0 ||
      valueEncoded === undefined ||
      valueEncoded.length > 250_000
    )
      throw new Error(`Workflow state operation ${operationId} is corrupt`);
  }
  return { entries, operations };
}

/** Replay-lineage-scoped state for long-running coordinators. The synchronous
 * atomic write makes each compare-and-set indivisible on the server event loop. */
export function readWorkflowState(
  scopeId: string,
  key: string,
): WorkflowStateValue {
  validStateKey(key);
  const current = readState(scopeId).entries[key];
  return { key, version: current?.version || 0, value: current?.value ?? null };
}

export function compareAndSetWorkflowState(
  scopeId: string,
  key: string,
  expectedVersion: number,
  value: unknown,
  operationId?: string,
): WorkflowStateCasResult {
  validStateKey(key);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
    throw new Error(
      "Workflow state expectedVersion must be a non-negative integer",
    );
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > 250_000)
    throw new Error(
      "Workflow state values must be JSON and at most 250000 characters",
    );
  const state = readState(scopeId);
  if (operationId && state.operations[operationId])
    return state.operations[operationId];
  const current = state.entries[key];
  if (
    !current &&
    Object.keys(state.entries).length >= WORKFLOW_LIMITS.maxStateKeys
  )
    throw new Error(
      `Workflow state key limit reached (${WORKFLOW_LIMITS.maxStateKeys})`,
    );
  const version = current?.version || 0;
  const result: WorkflowStateCasResult =
    version !== expectedVersion
      ? { key, version, value: current?.value ?? null, swapped: false }
      : {
          key,
          version: version + 1,
          value: JSON.parse(encoded),
          swapped: true,
        };
  if (result.swapped)
    state.entries[key] = { version: result.version, value: result.value };
  if (operationId) state.operations[operationId] = result;
  const stateEncoded = JSON.stringify(state);
  if (Buffer.byteLength(stateEncoded) > WORKFLOW_LIMITS.maxStateBytes)
    throw new Error(
      `Workflow state byte limit exceeded (${WORKFLOW_LIMITS.maxStateBytes})`,
    );
  mkdirSync(runDir(scopeId), { recursive: true });
  writeJsonAtomic(workflowStatePath(scopeId), state);
  return result;
}

export function appendWorkflowJournal(
  runId: string,
  entry: WorkflowJournalRecord,
): void {
  mkdirSync(runDir(runId), { recursive: true });
  appendFileSync(
    `${runDir(runId)}/journal.jsonl`,
    JSON.stringify(entry) + "\n",
  );
}

/** Journal entries in append order; a partial/corrupt trailing line (crash
 *  mid-append) is skipped, not fatal. */
export function readWorkflowJournal(runId: string): WorkflowJournalRecord[] {
  const path = `${runDir(runId)}/journal.jsonl`;
  if (!existsSync(path)) return [];
  const entries: WorkflowJournalRecord[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as WorkflowJournalRecord);
    } catch {}
  }
  return entries;
}

export function registerLiveWorkflow(
  runId: string,
  controls: WorkflowLiveControls | (() => void),
): void {
  const resolved =
    typeof controls === "function"
      ? { ...NOOP_CONTROLS, cancel: controls }
      : controls;
  const existing = liveWorkflows.get(runId);
  if (existing) {
    existing.controls = resolved;
    return;
  }
  const snapshot = readRunJson(runId);
  if (snapshot) liveWorkflows.set(runId, { snapshot, controls: resolved });
}

export function unregisterLiveWorkflow(runId: string): void {
  const live = liveWorkflows.get(runId);
  liveWorkflows.delete(runId);
  if (!live) return;
  const sessionId = live.snapshot.sessionId;
  const isRunning = releaseSessionRunning(sessionId, workflowRunningKey(runId));
  broadcastSessionActivityStatus(sessionId, isRunning);
}

/** Invoke a live run's cancel hook. False when the run isn't live here. */
export function cancelLiveWorkflow(runId: string): boolean {
  const live = liveWorkflows.get(runId);
  if (!live) return false;
  try {
    live.controls.cancel();
  } catch (e) {
    console.warn(`[workflow] cancel hook for ${runId} threw:`, e);
  }
  return true;
}

export function pauseLiveWorkflow(runId: string, reason?: string): boolean {
  return liveWorkflows.get(runId)?.controls.pause(reason) ?? false;
}

export function resumeLiveWorkflow(runId: string): boolean {
  return liveWorkflows.get(runId)?.controls.resume() ?? false;
}

export function controlLiveWorkflowAgent(
  runId: string,
  seq: number,
  action: WorkflowAgentControlAction,
): boolean {
  return liveWorkflows.get(runId)?.controls.controlAgent(seq, action) ?? false;
}

/** Pause every coordinator before a graceful process restart. Active detached
 * agents receive their normal cancellation signal, and the next process
 * replays completed journal entries while restarting unfinished calls. */
export function pauseWorkflowsForShutdown(): number {
  let paused = 0;
  for (const live of liveWorkflows.values()) {
    if (live.controls.pause("server restart")) paused++;
  }
  return paused;
}

export function recoverableWorkflowRunIds(): string[] {
  return runIdsOnDisk().filter((runId) => {
    const snapshot = readRunJson(runId);
    return (
      snapshot?.status === "interrupted" &&
      snapshot.recovery?.autoResume === true &&
      !snapshot.recoveredAsRunId
    );
  });
}

/** Boot pass: a run.json still "running" with no live entry died with the
 *  previous process — mark it interrupted so the UI doesn't show a zombie.
 *  (Callers guard this behind the boot flag; the function itself is safe to
 *  re-run.) */
export function markInterruptedWorkflows(): void {
  direntCache = null;
  for (const runId of runIdsOnDisk()) {
    if (liveWorkflows.has(runId)) continue;
    const snapshot = readRunJson(runId);
    if (!snapshot) continue;
    const pendingCancellation =
      snapshot.status === "cancelled" &&
      snapshot.sessions?.some((session) => session.cancelPending);
    if (
      snapshot.status !== "running" &&
      snapshot.status !== "paused" &&
      !pendingCancellation
    )
      continue;
    snapshot.status = "interrupted";
    snapshot.endedAt = new Date().toISOString();
    for (const agent of snapshot.agents) {
      if (agent.status === "pending" || agent.status === "running") {
        agent.status = "cancelled";
        agent.endedAt = snapshot.endedAt;
      }
    }
    try {
      persistSnapshot(snapshot);
    } catch (e) {
      console.warn(`[workflow] failed to mark ${runId} interrupted:`, e);
      continue;
    }
    broadcastSnapshot(snapshot);
  }
}
