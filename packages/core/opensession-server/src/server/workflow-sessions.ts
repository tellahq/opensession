import { $ } from "bun";
import { configuredServer } from "./config";
import { findSession } from "./session-cache";
import {
  getSessionControl,
  type SessionControl,
  type SessionSummary,
} from "./session-control";
import { resolveSessionRepoContext } from "./session-repos";
import { buildChildSessionPrompt } from "../agents/slack/sessions-tools";
import { getRepo } from "./worktree";
import { onSessionStateChange } from "./session-state-events";
import { publishSessionBranch } from "./session-publication";
import type {
  WorkflowAutomationSessionPolicy,
  WorkflowSessionController,
  WorkflowSessionState,
  WorkflowSessionStatus,
  WorkflowSpawnedSession,
  WorkflowSpawnSessionOpts,
} from "./workflow-types";

export interface WorkflowSessionControllerDeps {
  control: SessionControl;
  branchPushed: (session: SessionSummary) => Promise<boolean>;
  requireCommittedRef: (repoId: string, ref: string) => Promise<void>;
  hasUncommittedChanges: (session: SessionSummary) => Promise<boolean>;
  defaultBranch: (repoId: string) => string;
  publicationRepo: (repoId: string) => string;
  publishSessionBranch: typeof publishSessionBranch;
  resolveRepo: typeof resolveSessionRepoContext;
  baseUrl: string;
}

export interface WorkflowSessionControllerOpts {
  parentSessionId: string;
  user?: string;
  /** An automation workflow is deliberately read/fan-out only unless a future
   * narrowly scoped policy explicitly grants durable session creation. */
  allowSpawning: boolean;
  automationSessionPolicy?: WorkflowAutomationSessionPolicy;
  mcpAllowlist?: string[];
  maxDepth: number;
  /** Test seam; production uses SessionControl + the registered Git repos. */
  deps?: Partial<WorkflowSessionControllerDeps>;
}

function branchPushed(session: SessionSummary): Promise<boolean> {
  if (!session.branch || !session.repo) return Promise.resolve(false);
  const repo = getRepo(session.repo);
  return Promise.all([
    $`git -C ${repo.repo} rev-parse --verify --quiet refs/heads/${session.branch}`
      .nothrow()
      .text(),
    $`git -C ${repo.repo} rev-parse --verify --quiet refs/remotes/origin/${session.branch}`
      .nothrow()
      .text(),
  ]).then(([local, remote]) =>
    Boolean(local.trim() && local.trim() === remote.trim()),
  );
}

async function hasUncommittedChanges(
  session: SessionSummary,
): Promise<boolean> {
  if (!session.worktreeDir) return false;
  const [status, head] = await Promise.all([
    $`git -C ${session.worktreeDir} status --porcelain`.nothrow(),
    $`git -C ${session.worktreeDir} branch --show-current`.nothrow(),
  ]);
  if (status.exitCode !== 0 || head.exitCode !== 0)
    throw new Error(
      `Could not inspect base session \`${session.id}\` worktree before branching`,
    );
  const actualBranch = head.stdout.toString().trim();
  if (session.branch && actualBranch !== session.branch)
    throw new Error(
      `Base session \`${session.id}\` worktree is on \`${actualBranch || "a detached HEAD"}\`, not \`${session.branch}\``,
    );
  return Boolean(status.stdout.toString().trim());
}

async function requireCommittedRef(repoId: string, ref: string): Promise<void> {
  const repo = getRepo(repoId);
  const valid = await $`git check-ref-format --branch ${ref}`.nothrow();
  if (valid.exitCode !== 0) throw new Error(`Invalid Git base ref: ${ref}`);
  const local =
    await $`git -C ${repo.repo} rev-parse --verify --quiet ${ref}^{commit}`.nothrow();
  if (local.exitCode === 0) return;
  const remote =
    await $`git -C ${repo.repo} rev-parse --verify --quiet origin/${ref}^{commit}`.nothrow();
  if (remote.exitCode !== 0)
    throw new Error(
      `Base ref \`${ref}\` is not a usable committed branch in repo \`${repoId}\``,
    );
}

function stateOf(
  session: SessionSummary,
  cancelled: boolean,
): WorkflowSessionState {
  if (cancelled && session.state !== "running" && session.state !== "queued")
    return "cancelled";
  if (session.lastRunError) return "error";
  if (session.state === "waiting_question") return "waiting";
  if (session.state === "running" || session.state === "queued")
    return "running";
  // Pushed-branch and PR-opened are monotonic wait conditions represented by
  // branchPushed/prUrl. Lifecycle status remains done once the opening turn is
  // idle, rather than getting stuck forever on an earlier milestone.
  // A just-announced opening session can briefly project as idle before its
  // engine id lands. It has not completed yet.
  if (
    !session.claudeSessionId &&
    !session.codexThreadId &&
    !session.piSessionId
  )
    return "running";
  return "done";
}

function waitForSessionWake(
  sessionId: string,
  timeout: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      signal.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    const off = onSessionStateChange((event) => {
      if (event.sessionId === sessionId) finish();
    });
    const timer = setTimeout(() => finish(), timeout);
    const onAbort = () => finish(new Error("workflow cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function reached(
  current: WorkflowSessionStatus,
  until: WorkflowSessionState,
): boolean {
  if (current.status === until) return true;
  if (until === "running") return true;
  if (until === "branch_pushed")
    return current.branchPushed || Boolean(current.prUrl);
  if (until === "pr_opened") return Boolean(current.prUrl);
  if (until === "pr_merged") return current.prState === "MERGED";
  if (until === "pr_changes_requested")
    return current.prReviewDecision === "CHANGES_REQUESTED";
  if (until === "pr_approved") return current.prReviewDecision === "APPROVED";
  if (until === "pr_checks_failed") return (current.prChecks?.failed || 0) > 0;
  if (until === "pr_checks_passed")
    return Boolean(
      current.prChecks?.total &&
      current.prChecks.failed === 0 &&
      current.prChecks.pending === 0,
    );
  return false;
}

/** Durable child-session adapter for workflow-runner. All control goes through
 * SessionControl; this module only applies workflow ownership, repo and Git-base
 * policy around that existing implementation. */
export function createWorkflowSessionController(
  opts: WorkflowSessionControllerOpts,
): WorkflowSessionController {
  const deps: WorkflowSessionControllerDeps = {
    control: opts.deps?.control ?? getSessionControl(),
    branchPushed: opts.deps?.branchPushed ?? branchPushed,
    requireCommittedRef: opts.deps?.requireCommittedRef ?? requireCommittedRef,
    hasUncommittedChanges:
      opts.deps?.hasUncommittedChanges ?? hasUncommittedChanges,
    defaultBranch:
      opts.deps?.defaultBranch ?? ((repoId) => getRepo(repoId).defaultBranch),
    publicationRepo:
      opts.deps?.publicationRepo ?? ((repoId) => getRepo(repoId).ghRepo),
    publishSessionBranch:
      opts.deps?.publishSessionBranch ?? publishSessionBranch,
    resolveRepo: opts.deps?.resolveRepo ?? resolveSessionRepoContext,
    baseUrl: opts.deps?.baseUrl ?? configuredServer().publicBaseUrl,
  };
  const control = deps.control;
  const owned = new Set<string>();
  const cancelled = new Set<string>();

  const assertOwned = (id: string): void => {
    if (!owned.has(id))
      throw new Error(`Session \`${id}\` was not spawned by this workflow`);
  };

  const status = async (id: string): Promise<WorkflowSessionStatus> => {
    assertOwned(id);
    const session = control.getSession(id);
    if (!session) throw new Error(`No child session with id \`${id}\``);
    const pushed = await deps.branchPushed(session);
    return {
      id: session.id,
      url: `${deps.baseUrl}/session/${encodeURIComponent(session.id)}`,
      repo: session.repo || "",
      branch: session.branch || "",
      parentSessionId: session.parentSessionId || opts.parentSessionId,
      status: stateOf(session, cancelled.has(id)),
      branchPushed: pushed,
      ...(session.worktreeDir ? { worktreeDir: session.worktreeDir } : {}),
      ...(session.prUrl ? { prUrl: session.prUrl } : {}),
      ...(session.prState ? { prState: session.prState } : {}),
      ...(session.prReviewDecision
        ? { prReviewDecision: session.prReviewDecision }
        : {}),
      ...(session.prChecks ? { prChecks: session.prChecks } : {}),
      ...(session.runner?.id ? { runner: session.runner.id } : {}),
      ...(session.lastRunError ? { error: session.lastRunError.message } : {}),
      ...(session.usage
        ? {
            tokens:
              session.usage.inputTokens +
              session.usage.outputTokens +
              session.usage.cacheReadTokens +
              session.usage.cacheCreationTokens,
            costUsd: session.usage.costUsd,
          }
        : {}),
    };
  };

  return {
    adopt(session) {
      if (session.parentSessionId !== opts.parentSessionId)
        throw new Error("Replayed child session belongs to another parent");
      owned.add(session.id);
    },

    async spawn(input, requestId) {
      if (!opts.allowSpawning)
        throw new Error(
          "spawnSession() is unavailable in automation workflows because their tool restrictions cannot be widened into an interactive code session",
        );
      if (!input?.prompt?.trim())
        throw new Error("spawnSession() needs a prompt");
      if (typeof input.repo !== "string" || !input.repo.trim())
        throw new Error("spawnSession() needs a repo");
      if (input.mode !== undefined && !["ask", "code"].includes(input.mode))
        throw new Error('spawnSession() mode must be "ask" or "code"');
      if (
        input.workspace !== undefined &&
        input.workspace?.type !== "isolated-worktree"
      )
        throw new Error(
          'spawnSession() workspace.type must be "isolated-worktree"',
        );
      if (input.branch !== undefined && typeof input.branch !== "string")
        throw new Error("spawnSession() branch must be a string");
      if (input.runner !== undefined && !input.runner.trim())
        throw new Error("spawnSession() runner must be a non-empty id");
      if (input.admission !== undefined) {
        if (
          !Number.isFinite(input.admission.tokens) ||
          input.admission.tokens < 0
        )
          throw new Error(
            "spawnSession() admission.tokens must be non-negative",
          );
        if (
          input.admission.costUsd !== undefined &&
          (!Number.isFinite(input.admission.costUsd) ||
            input.admission.costUsd < 0)
        )
          throw new Error(
            "spawnSession() admission.costUsd must be non-negative",
          );
      }
      if (
        input.workspace?.baseRef !== undefined &&
        (typeof input.workspace.baseRef !== "string" ||
          !input.workspace.baseRef.trim())
      )
        throw new Error(
          "spawnSession() workspace.baseRef must be a non-empty string",
        );
      if (
        input.workspace?.baseSessionId !== undefined &&
        typeof input.workspace.baseSessionId !== "string"
      )
        throw new Error(
          "spawnSession() workspace.baseSessionId must be a session id",
        );
      const parent =
        control.getSession(opts.parentSessionId) ||
        findSession(opts.parentSessionId);
      if (!parent) throw new Error("Workflow parent session no longer exists");
      const depth = (parent.spawnDepth || 0) + 1;
      if (depth > opts.maxDepth)
        throw new Error(
          `Nested session depth ${depth} exceeds the configured maximum ${opts.maxDepth}`,
        );
      const automationPolicy = opts.automationSessionPolicy;
      if (automationPolicy) {
        if (parent.automationId !== automationPolicy.automationId)
          throw new Error(
            "Automation durable-session policy does not belong to the workflow parent",
          );
        if (!automationPolicy.allowedRepos.includes(input.repo))
          throw new Error(
            `Automation is not allowed to spawn sessions in repo \`${input.repo}\``,
          );
        if (
          input.runner &&
          !automationPolicy.allowedRunners.includes(input.runner)
        )
          throw new Error(
            `Automation is not allowed to use Runner \`${input.runner}\``,
          );
      }
      const parentRepo = deps.resolveRepo(parent, input.repo, input.prompt);
      if (!parentRepo)
        throw new Error(
          `Repo \`${input.repo}\` is not registered on the workflow parent session`,
        );

      const mode = input.mode || "code";
      const isolated = input.workspace?.type === "isolated-worktree";
      if (input.workspace && mode !== "code")
        throw new Error('An isolated worktree requires mode: "code"');
      if (input.workspace?.baseRef && input.workspace?.baseSessionId)
        throw new Error(
          "Choose either workspace.baseRef or workspace.baseSessionId, not both",
        );
      let baseRef = input.workspace?.baseRef;
      let stackBase: string | undefined;
      if (input.workspace?.baseSessionId) {
        const baseId = input.workspace.baseSessionId;
        assertOwned(baseId);
        const base = control.getSession(baseId);
        if (!base)
          throw new Error(`Base session \`${baseId}\` no longer exists`);
        if (base.repo !== input.repo)
          throw new Error(
            `Base session \`${baseId}\` belongs to repo \`${base.repo || "unknown"}\`, not \`${input.repo}\``,
          );
        if (!base.branch)
          throw new Error(`Base session \`${baseId}\` has no usable branch`);
        if (!(await deps.branchPushed(base)))
          throw new Error(
            `Base session \`${baseId}\` branch \`${base.branch}\` is not pushed at its current commit`,
          );
        if (await deps.hasUncommittedChanges(base))
          throw new Error(
            `Base session \`${baseId}\` has uncommitted changes; commit and push them before branching from it`,
          );
        baseRef = base.branch;
        stackBase = base.branch;
      }
      if (baseRef) await deps.requireCommittedRef(input.repo, baseRef);
      if (input.runner) {
        const defaultBranch = deps.defaultBranch(input.repo);
        if (stackBase || (baseRef && baseRef !== defaultBranch))
          throw new Error(
            `Runner sessions currently require the repository default branch \`${defaultBranch}\` as their base`,
          );
      }

      const prompt = [
        buildChildSessionPrompt({
          prompt: input.prompt,
          parentSessionId: opts.parentSessionId,
          reportBack: true,
        }),
        "This session was launched by a dynamic workflow. You may commit, push, and open a pull request, but never merge a pull request or merge the branch into its base. A human owns every merge decision.",
      ].join("\n\n");
      const inheritedMcp =
        opts.mcpAllowlist !== undefined ? opts.mcpAllowlist : parent.mcpServers;
      const created = await control.createSession({
        requestId,
        requestScope: opts.parentSessionId,
        prompt,
        repo: input.repo,
        mode,
        branch: input.branch,
        isolatedWorktree: isolated,
        baseRef,
        stackedOnBranch: stackBase,
        parentSessionId: opts.parentSessionId,
        reportBack: true,
        agentStarted: true,
        user: opts.user || parent.createdBy || parent.startedBy || undefined,
        model: parent.model,
        effort: parent.effort,
        fastMode: parent.fastMode,
        accountId: parent.accountId,
        mcpServers: inheritedMcp,
        runner: input.runner,
        ...(automationPolicy
          ? {
              automationDescendantPolicy: {
                automationId: automationPolicy.automationId,
                automationName: automationPolicy.automationName,
                mcpServers: [],
                repo: input.repo,
                publicationRepo: deps.publicationRepo(input.repo),
                baseBranch: deps.defaultBranch(input.repo),
                allowedRunners: [...automationPolicy.allowedRunners],
                publication: "branch-pr-only" as const,
              },
            }
          : {}),
        spawnDepth: depth,
      });
      const child = control.getSession(created.id);
      const result: WorkflowSpawnedSession = {
        id: created.id,
        url: `${deps.baseUrl}/session/${encodeURIComponent(created.id)}`,
        repo: child?.repo || input.repo,
        branch: child?.branch || (mode === "code" ? input.branch : "") || "",
        parentSessionId: opts.parentSessionId,
      };
      owned.add(result.id);
      return result;
    },

    status,

    async wait(id, waitOpts, signal) {
      assertOwned(id);
      const timeout = waitOpts.timeout ?? 60 * 60_000;
      if (!Number.isFinite(timeout) || timeout < 0)
        throw new Error(
          "waitSession() timeout must be a non-negative number of milliseconds",
        );
      const deadline = Date.now() + timeout;
      for (;;) {
        if (signal.aborted) throw new Error("workflow cancelled");
        const current = await status(id);
        if (reached(current, waitOpts.until)) return current;
        // An idle code turn is not terminal for Git/PR milestones: branch and
        // GitHub projections commonly settle after the model turn ends.
        if (
          current.status === "error" ||
          current.status === "cancelled" ||
          (current.status === "done" &&
            (waitOpts.until === "running" || waitOpts.until === "waiting"))
        )
          throw new Error(
            `Session \`${id}\` reached ${current.status} before ${waitOpts.until}${current.error ? `: ${current.error}` : ""}`,
          );
        if (Date.now() >= deadline)
          throw Object.assign(
            new Error(
              `Timed out waiting for session \`${id}\` to reach ${waitOpts.until}`,
            ),
            { retryable: true },
          );
        // Primary turn boundaries wake immediately. PR projection changes do
        // not yet have a dedicated event, so retain a low-frequency fallback.
        await waitForSessionWake(
          id,
          Math.min(3_000, Math.max(1, deadline - Date.now())),
          signal,
        );
      }
    },

    async send(id, message, requestId) {
      assertOwned(id);
      if (!message.trim()) throw new Error("sendToSession() needs a message");
      return await control.deliverToSession(id, message, opts.user, {
        deliveryId: requestId,
      });
    },

    async autofix(id, reason, requestId) {
      assertOwned(id);
      const current = await status(id);
      if (!current.prUrl)
        throw new Error(`Session \`${id}\` has no pull request to autofix`);
      if (current.prState && current.prState !== "OPEN")
        throw new Error(
          `Session \`${id}\` pull request is ${current.prState.toLowerCase()}, not open`,
        );
      const prompt = [
        "Re-open the current pull request and address every open review comment and failing CI check. Push the fixes, reply honestly in each addressed thread, and do not merge.",
        reason?.trim() ? `Coordinator context: ${reason.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return await control.deliverToSession(id, prompt, opts.user, {
        deliveryId: requestId,
        busy: "queue",
        reviewHandoff: true,
      });
    },

    async publish(id, requestId) {
      assertOwned(id);
      const result = await deps.publishSessionBranch(id, requestId);
      const current = await status(id);
      return { ...result, status: current };
    },

    async cancel(id, requestId) {
      assertOwned(id);
      const didCancel = await control.cancelSession(id, { requestId });
      if (!didCancel)
        throw new Error(`Session \`${id}\` could not be cancelled`);
      cancelled.add(id);
      return await status(id);
    },

    async cancelActive(requestIdPrefix) {
      await Promise.all(
        [...owned].map(async (id, index) => {
          try {
            const current = await status(id);
            if (current.status === "running" || current.status === "waiting") {
              await control.cancelSession(id, {
                requestId: `${requestIdPrefix}:${index}`,
              });
              cancelled.add(id);
            }
          } catch {}
        }),
      );
    },
  };
}
