/**
 * Goals: long-running, stateful agent missions.
 *
 * Unlike an Automation — which fires a *fresh, amnesiac* session on a cron tick
 * (automations.ts) — a Goal is a single managed session pursued over days/weeks.
 * It carries context across wakes (the engine session is resumed each time, so
 * the SDK compacts rather than forgets), paces itself (each wake sets its own
 * next wake), pauses for human sign-off, and stops when its success condition is
 * met. The mission is just a prompt string — nothing domain-specific lives here.
 *
 * This module is the pure data layer: the on-disk store + validation. The runner
 * (which drives the session) and the ticker live in opensession.ts next to the
 * session loop ticker, because they need the interactive MCP wiring; the two MCP
 * surfaces (opensession-goals management + opensession-goal-self self-cadence) live in
 * src/agents/slack/goal-tools.ts. Records are one JSON file per goal at
 * ~/.opensession-goals/<id>.json, mirroring the automation store.
 */
import { randomUUIDv7 } from "bun";
import { writeJsonAtomicAsync } from "./shared/atomic-write";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "fs/promises";
import { dirname } from "path";
import { isMissingFileError, readJsonOrUndefined } from "./shared/async-fs";
import { stateDir } from "./paths";

const GOALS_DIR = stateDir("goals");

export type GoalStatus = "active" | "paused" | "done" | "failed";

export interface Goal {
  id: string;
  name: string;
  /** The mission prompt — the whole point of the goal, restated every wake. */
  mission: string;
  status: GoalStatus;
  /** "ask" = read-only research/measure; "code" = persistent worktree + can open PRs. */
  mode: "ask" | "code";
  /** Repo id for code-mode worktrees (key in worktree.ts REPOS). Defaults to the instance default repo. */
  repo?: string;
  /** Open Session session this goal drives (context continuity). Set on first wake. */
  osSessionId?: string;
  /** Engine (Claude/Codex) session id to resume each wake. Set on first wake. */
  engineSessionId?: string;
  /** Persistent worktree path for code mode — stable cwd so resume keeps working. */
  worktreePath?: string;
  /** Branch the persistent worktree was created on (for revive-after-cleanup). */
  branch?: string;
  /** ISO8601 — the ticker wakes this goal at/after this instant. */
  nextWakeAt: string;
  /** Floor on self-scheduled cadence, so a buggy run can't hot-loop. */
  minWakeMinutes: number;
  /** Hard safety cap on total wakes; auto-pauses on hit. Unset = no cap. */
  maxWakes?: number;
  wakeCount: number;
  lastRunAt?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunError?: string;
  /** Agent-updated free text, e.g. "week 2: shipping roundup". */
  phase?: string;
  /** Set when status=paused — what/who it's blocked on. */
  pauseReason?: string;
  doneReason?: string;
  /** Path to the goal's append-only fact ledger (authoritative memory). */
  stateFile: string;
  model?: string;
  fallbackModel?: string;
  /** External MCP server allowlist for this goal's runs (least privilege). */
  mcpServers?: string[];
  createdBy: string;
  createdAt: string;
}

// GOALS_DIR is created by the first goal write; a missing directory reads as
// no goals.

// ── Store ────────────────────────────────────────────────────

export async function listGoals(): Promise<Goal[]> {
  const out: Goal[] = [];
  let files: string[];
  try {
    files = await readdir(GOALS_DIR);
  } catch (error) {
    if (isMissingFileError(error)) return out;
    throw error;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(
        JSON.parse(await readFile(`${GOALS_DIR}/${file}`, "utf-8")) as Goal,
      );
    } catch {}
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function getGoal(id: string): Promise<Goal | null> {
  return (await readJsonOrUndefined<Goal>(`${GOALS_DIR}/${id}.json`)) ?? null;
}

export function saveGoal(g: Goal): Promise<void> {
  return writeJsonAtomicAsync(`${GOALS_DIR}/${g.id}.json`, g);
}

export async function deleteGoal(id: string): Promise<boolean> {
  try {
    await unlink(`${GOALS_DIR}/${id}.json`);
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
  await unlink(`${GOALS_DIR}/${id}.ledger.md`).catch(() => {});
  return true;
}

/** Append a timestamped entry to a goal's fact ledger (its durable memory). */
export async function appendLedger(goal: Goal, text: string): Promise<void> {
  const stamp = new Date().toISOString();
  await mkdir(dirname(goal.stateFile), { recursive: true });
  await appendFile(goal.stateFile, `\n\n## ${stamp}\n\n${text.trim()}\n`);
}

// ── Create / update ──────────────────────────────────────────

const MIN_WAKE_FLOOR = 5; // never allow a cadence under 5 minutes

function sanitizeMcpList(list?: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list
    .filter((s): s is string => typeof s === "string" && !!s.trim())
    .map((s) => s.trim());
}

export async function createGoal(input: {
  name: string;
  mission: string;
  mode?: "ask" | "code";
  repo?: string;
  model?: string;
  fallbackModel?: string;
  mcpServers?: string[];
  minWakeMinutes?: number;
  maxWakes?: number;
  /** ISO8601 first wake; omitted/empty = wake on the next tick. */
  firstWakeAt?: string;
  createdBy: string;
}): Promise<Goal | { error: string }> {
  if (!input.name?.trim()) return { error: "Name is required" };
  if (!input.mission?.trim()) return { error: "Mission is required" };

  let nextWakeAt = new Date().toISOString();
  if (input.firstWakeAt?.trim()) {
    const t = Date.parse(input.firstWakeAt.trim());
    if (Number.isNaN(t))
      return { error: `Invalid firstWakeAt: "${input.firstWakeAt}"` };
    nextWakeAt = new Date(t).toISOString();
  }

  const id = `goal-${randomUUIDv7()}`;
  const minWakeMinutes = Math.max(
    MIN_WAKE_FLOOR,
    typeof input.minWakeMinutes === "number" && input.minWakeMinutes > 0
      ? input.minWakeMinutes
      : 30,
  );

  const g: Goal = {
    id,
    name: input.name.trim(),
    mission: input.mission.trim(),
    status: "active",
    mode: input.mode === "code" ? "code" : "ask",
    repo: input.repo?.trim() || undefined,
    nextWakeAt,
    minWakeMinutes,
    maxWakes:
      typeof input.maxWakes === "number" && input.maxWakes > 0
        ? Math.floor(input.maxWakes)
        : undefined,
    wakeCount: 0,
    stateFile: `${GOALS_DIR}/${id}.ledger.md`,
    model: input.model?.trim() || undefined,
    fallbackModel: input.fallbackModel?.trim() || undefined,
    mcpServers: sanitizeMcpList(input.mcpServers),
    createdBy: input.createdBy || "Anonymous",
    createdAt: new Date().toISOString(),
  };
  await saveGoal(g);

  // Seed the ledger so the first wake has something to read.
  await writeFile(
    g.stateFile,
    `# Ledger — ${g.name}\n\n` +
      `This is the durable, authoritative record of this goal's work: baselines, ` +
      `decisions, shipped PRs and their measured effect. The agent reads it first ` +
      `every wake and appends to it last. It survives context compaction.\n\n` +
      `## Mission\n\n${g.mission}\n`,
  );
  return g;
}

/** Fields an operator (via opensession-goals) may patch. Runtime/scheduling fields
 *  (engineSessionId, wakeCount, lastRun*, worktreePath) are owned by the runner. */
export async function updateGoal(
  id: string,
  patch: Partial<
    Pick<
      Goal,
      | "name"
      | "mission"
      | "status"
      | "mode"
      | "repo"
      | "nextWakeAt"
      | "minWakeMinutes"
      | "maxWakes"
      | "model"
      | "fallbackModel"
      | "mcpServers"
      | "phase"
      | "pauseReason"
      | "doneReason"
    >
  >,
): Promise<Goal | { error: string }> {
  const g = await getGoal(id);
  if (!g) return { error: "Goal not found" };
  const next: Goal = { ...g, ...patch };
  if ("mcpServers" in patch)
    next.mcpServers = sanitizeMcpList(patch.mcpServers);
  if (typeof next.minWakeMinutes === "number") {
    next.minWakeMinutes = Math.max(MIN_WAKE_FLOOR, next.minWakeMinutes);
  }
  await saveGoal(next);
  return next;
}

/** Resume a paused/done goal: mark active and (re)schedule a wake. */
export async function resumeGoal(
  id: string,
  firstWakeAt?: string,
): Promise<Goal | { error: string }> {
  const g = await getGoal(id);
  if (!g) return { error: "Goal not found" };
  let nextWakeAt = new Date().toISOString();
  if (firstWakeAt?.trim()) {
    const t = Date.parse(firstWakeAt.trim());
    if (Number.isNaN(t)) return { error: `Invalid time: "${firstWakeAt}"` };
    nextWakeAt = new Date(t).toISOString();
  }
  const next: Goal = {
    ...g,
    status: "active",
    pauseReason: undefined,
    nextWakeAt,
  };
  await saveGoal(next);
  return next;
}
