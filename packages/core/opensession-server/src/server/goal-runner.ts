/**
 * Goals: long-running, self-pacing missions. A Goal drives ONE managed session
 * across many wakes, resuming the engine session each time (so context carries
 * and the SDK compacts rather than forgets), pacing itself via the
 * opensession-goal-self MCP, and stopping when done. The store + validation live in
 * goals.ts; this is the runner + ticker (they need the run/MCP wiring).
 */

import { randomUUIDv7 } from "bun";
import { existsSync } from "fs";
import { createHumansMcpServer } from "../agents/slack/humans-tools";
import { createGoalSelfMcpServer } from "../agents/slack/goal-tools";
import { runAgent, isAgentSessionBusy } from "./agent-runner";
import { defaultRepo, personaName } from "./config";
import { isDevInstance } from "./dev-mode";
import { getGoal, listGoals, saveGoal, type Goal } from "./goals";
import { automaticFallbackModel, providerFor } from "./models";
import { engineSessionPatch } from "./sessions";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { gitIdentityFor } from "./shared/user-mappings";
import {
  createWorktree,
  getRepo,
  reviveWorktree,
  worktreeHeadBranch,
} from "./worktree";
import { updateSessionFile } from "./session-cache";
import { attachSessionWatchersToEngineTranscript } from "./run-session";
import type { NativeSessionFile } from "./types";
import { shouldPersistModelSwitch } from "./run-events";
import { shellQuoteWord } from "./sandbox/adapters/bootstrap";
import { newSessionId } from "./paths";
import { createWebMcpServer } from "./web-mcp";

const g = globalThis as any;

// ── Goals: long-running, self-pacing missions ───────────────────────────────
// A Goal drives ONE managed session across many wakes, resuming the engine
// session each time (so context carries and the SDK compacts rather than
// forgets), pacing itself via the opensession-goal-self MCP, and stopping when done.
// The store + validation live in src/server/goals.ts; this is the runner +
// ticker (here because they need the interactive MCP wiring), mirroring how the
// session loop ticker lives in this file.

export const runningGoals: Set<string> = (g.__runningGoals ??= new Set());

/** MCP surface for a goal's own run: pull-a-human-in + its self-cadence controls.
 *  Deliberately excludes opensession-admin / opensession-sessions — an autonomous,
 *  weeks-long run gets least privilege (can't reconfigure the agent or steer other
 *  sessions); human sign-off goes through opensession-humans ask_human. */
function goalMcpServers(
  osSessionId: string,
  goalId: string,
  createdBy: string,
): Record<string, unknown> {
  return {
    "opensession-humans": createHumansMcpServer({
      sessionId: osSessionId,
      createdBy,
      isAdmin: true,
    }),
    "opensession-goal-self": createGoalSelfMcpServer(goalId),
    // Goals often measure public URLs over time. Give them the same bounded,
    // SSRF-safe reader as interactive sessions instead of opening curl in the
    // ask-mode shell allowlist.
    "opensession-web": createWebMcpServer({ sessionId: osSessionId }),
  };
}

function buildGoalWakePrompt(goal: Goal, wake: number, cwd: string): string {
  const parts = [
    `# Your mission (pinned)\n\n${goal.mission}`,
    `---`,
    `## This is wake #${wake} of your mission.`,
    `Your durable fact ledger is at:\n    ${goal.stateFile}\nRead it FIRST every wake — it is the authoritative record of what you've baselined, decided, shipped, and measured. Your in-context memory may have been compacted; the ledger is not.`,
    `Do ONE meaningful increment this wake. Then, before you finish, ALWAYS:\n` +
      `- Append what you learned/did this wake (concrete numbers, PR URLs, decisions) to the ledger via the opensession-goal-self \`append_ledger\` tool.\n` +
      `- Decide what happens next with opensession-goal-self: \`set_next_wake\` (e.g. "in 7 days" after shipping, so metrics can actually move before you re-measure), or \`mark_paused\` if you're blocked on a human decision, or \`mark_done\`/\`mark_failed\` when the mission is settled. If you set none, you'll be woken again in ~24h by default.\n` +
      `- Keep \`update_phase\` current so progress is visible at a glance.`,
    `Human gates: to get sign-off or a decision from a teammate, use the opensession-humans \`ask_human\` tool — it DMs them as ${personaName()} and folds their reply back into this session. Do NOT email or impersonate anyone.`,
  ];
  if (goal.mode === "code") {
    const repo = getRepo(goal.repo);
    const branchLabel = JSON.stringify(repo.defaultBranch);
    const branchArg = shellQuoteWord(repo.defaultBranch);
    const remoteRefArg = shellQuoteWord(`origin/${repo.defaultBranch}`);
    if (repo.sharedCheckout) {
      // Shared-checkout repos (opensession) have NO isolated worktree — `cwd` is
      // the live main checkout the running server and every other session share.
      // A `git checkout -B`/`reset`/`pull` here yanks the working tree out from
      // under everyone and orphans their un-pushed commits, so forbid it.
      parts.push(
        `Shipping code: you are in the SHARED, live main checkout at ${cwd} on branch ${branchLabel}. The running server and other sessions use this exact working tree at the same time. NEVER create or switch branches, \`reset\`, \`pull\`, \`stash\`, or \`checkout\` (that rips the tree out from under everyone and orphans their commits). Just edit files, then \`git add <your specific files>\` → \`git commit\` → \`git push origin ${branchArg}\`. Commit + push frequently. No feature branch and no PR. This repo ships directly from branch ${branchLabel}.`,
      );
    } else if (repo.host === "codestorage") {
      parts.push(
        `Shipping code: you are in a persistent worktree at ${cwd} (kept stable across wakes so your session resumes cleanly). For each change, start clean from the default branch (\`git fetch origin ${branchArg} && git checkout -B <feature-branch> ${remoteRefArg}\`), make edits, follow the repo's AGENTS.md and run its checks/format, then commit and push your branch with \`git push -u origin <feature-branch>\`. This repo is hosted on Code Storage; there is no gh CLI and no pull requests; a pushed branch IS the change request. NEVER merge into branch ${branchLabel}. The merge is the human gate.`,
      );
    } else {
      parts.push(
        `Shipping code: you are in a persistent worktree at ${cwd} (kept stable across wakes so your session resumes cleanly). For each change, start clean from the default branch (\`git fetch origin ${branchArg} && git checkout -B <feature-branch> ${remoteRefArg}\`), make edits, follow the repo's AGENTS.md and run its checks/format, then open a PR with \`gh pr create --base ${branchArg}\`. NEVER merge. A PR is the human gate.`,
      );
    }
  }
  return parts.join("\n\n");
}

/** Run one wake of a goal: resume (or create) its session, drive one increment,
 *  then persist whatever cadence/status the run chose (with a 24h fallback). */
export async function runGoal(goal: Goal): Promise<void> {
  if (runningGoals.has(goal.id)) return;
  runningGoals.add(goal.id);
  const startedAt = new Date();
  const wake = goal.wakeCount + 1;
  const bksId = goal.osSessionId || newSessionId();
  try {
    // Code goals keep ONE persistent worktree so the engine session (keyed on
    // cwd) resumes cleanly across wakes; ask goals read the main checkout.
    let cwd = defaultRepo().repo;
    let branch = goal.branch || "";
    if (goal.mode === "code") {
      const repo = getRepo(goal.repo);
      branch = goal.branch || `goal-${goal.id.slice(-8)}`;
      if (goal.worktreePath && existsSync(goal.worktreePath)) {
        cwd = goal.worktreePath;
      } else {
        try {
          cwd = await reviveWorktree(branch, repo.id);
        } catch {
          cwd = await createWorktree(branch, repo.id);
        }
      }
    }

    saveGoal({
      ...goal,
      osSessionId: bksId,
      branch: branch || undefined,
      worktreePath: goal.mode === "code" ? cwd : undefined,
      lastRunAt: startedAt.toISOString(),
      lastRunStatus: "running",
      lastRunError: undefined,
    });

    const createdBy = `${goal.name} (goal)`;
    let effectiveModel = goal.model;
    let selectedModel = goal.model;
    let effectiveProvider = providerFor(effectiveModel);
    // Field-scoped write: creation fields are create-if-absent defaults (the
    // first wake creates the file, later wakes keep it); each wake owns the
    // engine-id/model fields plus the goal's live config projection
    // (mode/repo/worktree/branch/title track the goal record). Serialized
    // via updateSessionFile.
    const persistSession = (engineSessionId: string) =>
      updateSessionFile(bksId, (data) => {
        // Widen to Partial: the file may not exist yet (create-if-absent).
        const existing: Partial<NativeSessionFile> = data;
        return {
          id: bksId,
          claudeSessionId: "",
          createdBy,
          createdAt: goal.createdAt,
          ...existing,
          ...(engineSessionId
            ? engineSessionPatch(effectiveProvider, engineSessionId)
            : {}),
          ...(engineSessionId ? { lastEngineProvider: effectiveProvider } : {}),
          ...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          // Actual worktree HEAD wins over the recorded name — the agent may
          // have switched branches mid-run (see run-session.ts's same sync).
          branch: goal.mode === "code" ? worktreeHeadBranch(cwd) || branch : "",
          worktreeDir: cwd,
          ...(goal.mode === "code" ? { repo: getRepo(goal.repo).id } : {}),
          title: `${goal.name} — goal`,
          mode: goal.mode,
          goalId: goal.id,
          lastActivity: new Date().toISOString(),
        };
      });

    console.log(`[goals] Wake #${wake} of "${goal.name}" → ${bksId}`);

    let engineSessionId = goal.engineSessionId || "";
    let errorMsg = "";
    for await (const event of runAgent({
      prompt: buildGoalWakePrompt(goal, wake, cwd),
      sessionId: goal.engineSessionId || undefined,
      cwd,
      mode: goal.mode,
      model: goal.model,
      mcpServers: goal.mcpServers ?? "all",
      inProcessMcp: goalMcpServers(bksId, goal.id, createdBy),
      confirmTools: STRIPE_CONFIRM_TOOLS,
      aws: true,
      author: gitIdentityFor(goal.name),
      // A goal runs on behalf of its creator; gate per-user MCP servers to them.
      user: createdBy,
      fallbackModel:
        goal.fallbackModel === "none"
          ? undefined
          : goal.fallbackModel || automaticFallbackModel(goal.model),
      journal: { osSessionId: bksId, kind: "goal" },
      // Headless: no onAskUser. Human gates go through opensession-humans ask_human
      // (async) and hard blocks through opensession-goal-self mark_paused.
    })) {
      if (event.type === "init") {
        engineSessionId = event.sessionId || engineSessionId;
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) {
          effectiveModel = event.model;
          if (!selectedModel) selectedModel = event.model;
        }
        await persistSession(engineSessionId);
        // A goal wake's transcript file is new each wake — attach anyone
        // already viewing the goal session so the turn streams live.
        if (engineSessionId) {
          attachSessionWatchersToEngineTranscript(
            bksId,
            effectiveProvider,
            cwd,
            engineSessionId,
          );
        }
      }
      if (event.type === "model_switch") {
        const to = event.toModel || "";
        if (to) {
          effectiveModel = to;
          effectiveProvider = providerFor(to);
          if (shouldPersistModelSwitch(event)) {
            selectedModel = to;
            const current = getGoal(goal.id) || goal;
            saveGoal({ ...current, model: to });
          }
        }
      }
      if (event.type === "done") {
        engineSessionId = event.sessionId || engineSessionId;
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) effectiveModel = event.model;
      }
      if (event.type === "error") errorMsg = event.content || "Unknown error";
    }
    await persistSession(engineSessionId);

    // The run may have rescheduled / paused / finished itself via
    // opensession-goal-self — reload so we don't clobber those, then apply
    // bookkeeping and a 24h fallback if it left no next wake.
    const fresh = getGoal(goal.id) || goal;
    const next: Goal = {
      ...fresh,
      osSessionId: bksId,
      engineSessionId,
      model: selectedModel || fresh.model,
      branch: branch || fresh.branch,
      worktreePath: goal.mode === "code" ? cwd : fresh.worktreePath,
      wakeCount: wake,
      lastRunAt: startedAt.toISOString(),
      lastRunStatus: errorMsg ? "error" : "ok",
      lastRunError: errorMsg || undefined,
    };
    if (
      next.status === "active" &&
      Date.parse(next.nextWakeAt) <= startedAt.getTime()
    ) {
      next.nextWakeAt = new Date(
        startedAt.getTime() + 24 * 60 * 60 * 1000,
      ).toISOString();
      console.log(
        `[goals] "${goal.name}" set no next wake — defaulting to +24h`,
      );
    }
    saveGoal(next);
    console.log(
      `[goals] "${goal.name}" wake #${wake} ${errorMsg ? `error: ${errorMsg}` : "ok"} (status ${next.status})`,
    );
  } catch (e: any) {
    console.error(`[goals] "${goal.name}" wake failed:`, e);
    const fresh = getGoal(goal.id);
    if (fresh) {
      saveGoal({
        ...fresh,
        lastRunAt: startedAt.toISOString(),
        lastRunStatus: "error",
        lastRunError: e?.message || String(e),
        // Back off a day on a hard failure so it can't hot-loop crashing.
        nextWakeAt:
          fresh.status === "active" &&
          Date.parse(fresh.nextWakeAt) <= startedAt.getTime()
            ? new Date(startedAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
            : fresh.nextWakeAt,
      });
    }
  } finally {
    runningGoals.delete(goal.id);
  }
}

/**
 * Goals ticker: wake due goals (self-pacing, so this only fires them).
 * Called once from opensession.ts's boot block; idempotent, so a hot reload
 * never stacks a second interval. Never arm this at module scope — a wake is
 * a real engine run, so any script or test importing this module would start
 * driving live goals. Dev instances skip it (see src/server/dev-mode.ts).
 */
export function startGoalTicker(): void {
  if (g.__goalTicker || isDevInstance()) return;
  g.__goalTicker = setInterval(() => {
    const now = Date.now();
    for (const goal of listGoals()) {
      if (goal.status !== "active") continue;
      if (Date.parse(goal.nextWakeAt) > now) continue;
      if (runningGoals.has(goal.id)) continue;
      // A prior process's run may still be resuming from the journal — don't
      // double-drive the same engine session.
      if (isAgentSessionBusy(goal.engineSessionId, goal.osSessionId)) continue;
      // Safety cap: stop an out-of-control mission until a human resumes it.
      if (goal.maxWakes && goal.wakeCount >= goal.maxWakes) {
        saveGoal({
          ...goal,
          status: "paused",
          pauseReason: `Hit safety cap of ${goal.maxWakes} wakes — resume to continue.`,
        });
        console.log(
          `[goals] "${goal.name}" hit maxWakes ${goal.maxWakes}; paused`,
        );
        continue;
      }
      void runGoal(goal);
    }
  }, 60_000);
}
