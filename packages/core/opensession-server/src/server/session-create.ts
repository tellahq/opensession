/**
 * Session creation — the ONE create path shared by the web UI and the
 * opensession-sessions MCP (session-control-wiring.ts).
 *
 * Layout:
 *  - Each entry point resolves its own inputs (repo/worktree/workspace/opening
 *    prompt) into a `ResolvedCreate` — that's where the paths deliberately
 *    differ (the web palette knows PR rows and stacked worktrees; the MCP
 *    knows parent/worker inheritance and prompt-derived branch names).
 *  - `openCreatedSession()` is the shared engine: persist the session file,
 *    announce the id, materialize a deferred worktree, launch the opening run
 *    (sandboxed or host) and drive the full event ladder (init → model_switch
 *    → text_chunk → tool_use → tool_result → usage_snapshot → done → error),
 *    then persist the outcome. Path-specific transport (who hears the events,
 *    how failures surface) rides the `CreateSessionIO` callbacks.
 *
 * `handleCreateSessionMessage` is the web UI adapter (the WebSocket
 * `create_session` case delegates here); the MCP adapter lives in
 * session-control-wiring.ts.
 */

import type { ServerWebSocket } from "bun";
import { randomUUIDv7 } from "bun";
import { existsSync } from "node:fs";
import {
  activeAgentRecoveryRecord,
  currentAgentRunToken,
  isAgentSessionCancelled,
  type StreamEvent,
  markSessionStarting,
  unmarkSessionStarting,
} from "./agent-runner";
import {
  activeRunRecords,
  journalClearIfLineage,
  journalRecordAbnormalCompletion,
} from "./run-journal";
import { makeAskHandler } from "./asks";
import { getAccountById } from "./claude-accounts";
import { getCodexAccountById } from "./codex-accounts";
import { getXaiAccountById } from "./xai-accounts";
import { buildForkHandoffNote } from "./fork-handoff";
import { ensureGeneratedTitle } from "./generated-titles";
import { nameKnownSessionReferencesForTitle } from "./session-reference-title";
import { onSessionIdle as onHumanAsksSessionIdle } from "./human-asks";
import { interactiveMcpServers } from "./interactive-mcp";
import { runAgentHosted } from "./host-client";
import {
  accountProviderForModel,
  interactiveFallbackModel,
  modelLabel,
  providerFor,
  resolveModel,
} from "./models";
import { configuredInteractiveDefaultModel } from "./model-catalog";
import { notifyMentions } from "./mentions";
import { newSessionId } from "./paths";
import { enablesPstackMode, PSTACK_MODE_NOTE } from "./pstack-mode";
import {
  pastedTextsFromWire,
  withPastedTexts,
} from "@tellahq/opensession-protocol/pasted-text";
import { wrapContext } from "./prompt-context";
import {
  acknowledgePromptDispatch,
  acknowledgeSteerDelivery,
  beginPromptDispatch,
  promptDispatches,
  promptQueues,
} from "./queue-state";
import { type ImageInput, shouldPersistModelSwitch } from "./run-events";
import {
  attachSessionWatchersToEngineTranscript,
  drainQueue,
  foldSessionUsage,
  maybeLaunchSandboxedRun,
  maybeQueueAutoContinue,
  sessionMentionsNote,
  watchExternalRunAndDrain,
} from "./run-session";
import { type McpScope, STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import {
  isRemoteSandboxProvider,
  resolveRequestedSandbox,
  sandboxConfig,
  sandboxesEnabled,
} from "./sandbox/config";
import { resolveInteractiveSandbox } from "./sandbox/defaults";
import {
  getRunner,
  runnerAvailableForSession,
  runnerWorkspacePath,
} from "./runners";
import { isRunnerConnected, prepareRunnerWorkspace } from "./runner-ws";
import { maybeLaunchRunnerRun } from "./runner-session";
import { githubAppRepositoryToken } from "./github-app";

/** Sandbox provider id as resolveRequestedSandbox resolves it (null = host). */
type ResolvedSandboxProvider = Extract<
  ReturnType<typeof resolveRequestedSandbox>,
  { ok: true }
>["provider"];

import {
  SESSION_EFFORTS,
  findSession,
  findSessionAsync,
  invalidateSessionsCache,
  recordRunOutcome,
  touchNativeSession,
  updateSessionFile,
} from "./session-cache";
import {
  attachRepo,
  buildBranchNote,
  buildReposNote,
  memoryNoteFor,
  planCreateAttachRepos,
  retrievedMemoryNoteFor,
  workspaceOwningWorktree,
} from "./session-repos";

import { ownedWorktree } from "./session-workspace";
import { engineSessionPatch, mergedSessionTranscriptAsync } from "./sessions";
import { commitAuthorFor, userMatchesAny } from "./shared/user-mappings";
import { envCapacity } from "./shared/env-capacity";
import { sanitizeBranchSlug } from "./suggest-branch";
import {
  type NativeSessionFile,
  type SessionUsage,
  type UnifiedSession,
} from "./types";
import {
  storeAppendUserLineEarly,
  transcriptLineUser,
} from "./transcript-persistence";
import {
  creationAttachmentPath,
  parseImageDataUrls,
  prepareCreationAttachmentSources,
  withUploadsNote,
} from "./uploads";
import { resolvePlainWorkspace } from "./workspace-resolve";
import { resolveWorkspaceModelPreset } from "./workspace-model-presets";
import { type Workspace, getWorkspace, updateWorkspace } from "./workspaces";
import {
  type CreationOpeningEffectItem,
  type CreationSetupPlan,
  SESSION_KERNEL_MAX_OPENING_PLAN_BYTES,
  ensureCreationPlanned,
  isCreationEffectPendingError,
  requestCreationAttachment,
  requestCreationBranch,
  requestCreationCredential,
  requestCreationOpening,
  patchCreationSetupPlan,
  requestCreationWorkspace,
  settleCreationCancelled,
  settleCreationFailed,
  settleCreationSucceeded,
  sessionKernel,
  sessionRunStateSnapshot,
  sessionTurn,
  sessionTurnSnapshot,
} from "./session-kernel";
import {
  ensureAskCheckout,
  ensureScratchDir,
  getRepo,
  isRegisteredWorktree,
  listWorktrees,
  NO_REPO,
  repoForPath,
  repoForPathOrNull,
  resolveUniqueBranch,
  sharedCheckoutForSessionCreate,
  worktreeHeadBranch,
  worktreePathFor,
} from "./worktree";
import {
  type WSClientData,
  broadcastToSession,
  preparingWorkspaces,
} from "./ws-hub";
import {
  holdPendingOpening,
  releasePendingOpening,
} from "./session-state-events";
import {
  markReplayedCommandResult,
  replayedSessionCreatedResult,
} from "./command-replay";
import { sessionIdForRequest } from "./session-request-id";
import { isClientSessionId } from "./paths";
import {
  clearCreatePlan,
  createPlanWorkspaceId,
  readCreatePlan,
  readCreatePlanForRecovery,
  restoreResolvedCreate,
  snapshotOpeningCreate,
} from "./session-create-plan";
import {
  githubCredentialForLogin,
  githubCredentialForPrincipal,
  soleGithubAccount,
} from "./github-auth";

/**
 * The `create_session` client message fields the flow reads. Fields typed
 * `unknown` are validated at their use site exactly as before (the message
 * arrives as parsed JSON and was previously read off an `any`).
 */
export interface CreateSessionMessage {
  /** Client-minted native id used to replay this create safely after reconnect. */
  clientSessionId?: unknown;
  prompt: string;
  titlePrompt?: unknown;
  requestId?: string;
  user?: string;
  mode?: string;
  branch: string;
  images?: unknown;
  files?: unknown;
  /** Large pastes, folded after the opening prompt (protocol pasted-text.ts). */
  pastedTexts?: unknown;
  fromPr?: unknown;
  forkFrom?: unknown;
  model?: unknown;
  effort?: unknown;
  fastMode?: unknown;
  accountId?: string;
  mcpServers?: unknown;
  repo?: unknown;
  /** Repos to work in beside `repo` (the palette's multi-select picker). */
  attachRepos?: unknown;
  sandbox?: unknown;
  runner?: unknown;
  worktreeMode?: unknown;
  checkoutMode?: unknown;
  workspaceId?: unknown;
  /** Workspace that supplied a model preset for an otherwise independent create. */
  modelWorkspaceId?: unknown;
  plainThreadId?: unknown;
  createWorkspace?: { name?: unknown };
}

/** A resolved fork request: the source session plus how it can be forked. */
export interface ForkContext {
  source: UnifiedSession;
  /** Fork point: resume from this past message (default: the tip). */
  messageId?: string;
  /** Claude can clone the real engine conversation via SDK forkSession… */
  canFork: boolean;
  /** …other backends get a transcript handoff in the opening prompt instead. */
  needsHandoff: boolean;
}

/**
 * Resolve a create's fork request. Returns undefined when no fork was asked
 * for; throws when the source session doesn't exist (callers surface that on
 * their own transport).
 */
export function resolveForkContext(
  forkFrom: { sourceId?: string; messageId?: string } | undefined,
): ForkContext | undefined {
  if (!forkFrom?.sourceId) return undefined;
  const source = findSession(forkFrom.sourceId);
  if (!source) throw new Error("Fork source session not found");
  const canFork =
    providerFor(source.model) === "claude" && !!source.claudeSessionId;
  return {
    source,
    messageId: forkFrom.messageId,
    canFork,
    needsHandoff: !canFork,
  };
}

/** Opening-prompt context block handing a non-clonable fork its source transcript. */
export async function forkHandoffContext(fork: ForkContext): Promise<string> {
  const entries = await mergedSessionTranscriptAsync(fork.source);
  return wrapContext(
    buildForkHandoffNote({
      sourceId: fork.source.id,
      sourceTitle: fork.source.title,
      sourceModel: fork.source.model,
      messageId: fork.messageId,
      entries,
    }),
    "handoff",
  );
}

/**
 * Validate a requested provider-account pin for a create. Soft pin: the
 * runner prefers it and falls back to the pool when it's exhausted.
 * Mismatched, unknown, and foreign personal ids are dropped (undefined)
 * rather than persisted as a pin that can never apply.
 */
export function resolvePinnedAccountId(
  model: string | undefined,
  accountId: unknown,
  user: string | undefined,
): string | undefined {
  const provider = accountProviderForModel(model);
  const requested =
    typeof accountId === "string" && accountId
      ? provider === "codex"
        ? getCodexAccountById(accountId)
        : provider === "claude"
          ? getAccountById(accountId)
          : provider === "xai"
            ? getXaiAccountById(accountId)
            : undefined
      : undefined;
  return requested &&
    (!requested.owner || (!!user && userMatchesAny(user, [requested.owner])))
    ? (accountId as string)
    : undefined;
}

/**
 * A create resolved down to what the shared engine needs: where the session
 * lives, what it persists, and how its opening run is configured. Built by
 * the per-path setup (web palette vs. MCP) — every deliberate difference
 * between those paths lives in how they fill this in.
 */
export interface ResolvedCreate {
  id: string;
  /** Raw first-line title persisted immediately (replaced by the generated summary). */
  title: string;
  /** The raw prompt the background title/summary is generated from. */
  titlePrompt: string;
  /** The person's visible message, before internal context is appended. */
  displayPrompt: string;
  /** The fully assembled opening prompt (uploads note, contexts, handoffs). */
  openingPrompt: string;
  user?: string;
  createdBy: string;
  createdAt: string;
  /** Verified web sign-in identity of the creator (web creates only). */
  createdByLogin?: string;
  mode: "ask" | "code" | "scratch";
  wtPath: string;
  /** Branch recorded on the session file ("" for ask/scratch sessions). */
  persistBranch: string;
  /** Branch the session works on — branch note + HEAD-drift comparisons. */
  branch: string;
  /** Repo recorded on the session file; undefined for repo-less scratch. */
  repoId?: string;
  /** Repos whose memory notes ride the opening prompt. */
  memoryRepoIds: string[];
  /**
   * Repos to work in beside the session's own: an isolated worktree each, on
   * one shared branch, prepared after the announce and BEFORE the opening run
   * so its system note and any sandbox mounts already know about them.
   */
  attachRepos?: { repos: string[]; branch: string };
  /** Durable, non-secret selector for trusted server-owned worktree fetches. */
  gitPrincipal?: string;
  /** Ephemeral capability. Durable create snapshots always strip this field. */
  gitEnv?: Record<string, string>;
  /** Exact ref used to materialize a new branch, retained for crash recovery. */
  worktreeBaseRef?: string;
  stackedOn?: { repo: string; branch: string };
  /** Workspace recorded on the session file. */
  workspaceId?: string;
  /** Workspace id echoed on the announce (the web session_created event). */
  announceWorkspaceId?: string;
  /** Whether this create minted a brand-new workspace (announce hint). */
  createdWorkspaceNow?: boolean;
  /** Workspace to rename once the generated title lands (minted by THIS create). */
  autoNameWorkspace?: Workspace | null;
  parentSessionId?: string;
  /** Number of supervised session-spawn hops from a human-created root. */
  spawnDepth?: number;
  /** Started by a server-side agent action rather than a person's composer. */
  agentStarted?: boolean;
  /** Agent that created this session (SessionData.spawnedBy). */
  spawnedBy?: string;
  reportBack?: boolean;
  /** Immutable automation trust provenance for workflow descendants. */
  automationDescendantPolicy?: NativeSessionFile["automationDescendantPolicy"];
  /** Undefined only for forks of sessions with no recorded model (historic). */
  model?: string;
  effort?: string;
  /** Stable preset instructions captured at creation, even if the workspace changes later. */
  presetNote?: string;
  fastMode?: boolean;
  accountId?: string;
  images?: ImageInput[];
  externalRefs?: NativeSessionFile["externalRefs"];
  plainThreadId?: string;
  /** MCP allowlist persisted on the session file. Empty means no MCP servers. */
  persistMcpServers?: string[];
  /**
   * MCP scope for the opening run. May be undefined at runtime (historic
   * web-palette behavior — read as "all" downstream); the sandbox launcher
   * defaults it to [] (fail-closed) instead.
   */
  runMcpServers?: McpScope;
  sandboxProvider: ResolvedSandboxProvider;
  /** Explicit persistent-machine target. Mutually exclusive with Sandbox. */
  runnerTarget?: {
    id: string;
    name: string;
    workspacePath: string;
    repositoryUrl: string;
  };
  /** Sandbox volume workspace: no host worktree, provider clones in-container. */
  volumeWorkspace: boolean;
  remoteSandbox: boolean;
  /** Stable intake id shared by create retry and queue recovery. */
  openingPromptEntryId: string;
  /** Worktree creation deferred until after the announce (web creates). */
  needsWorktree: boolean;
  /** How a recovered create rebuilds the deferred worktree. */
  worktreeKind?: "new" | "existing";
  worktreeIsolated?: boolean;
  /** Materializes the deferred worktree (present iff needsWorktree). */
  materializeWorktree?: () => Promise<unknown>;
  /** Engine-level fork (Claude SDK forkSession) of the source conversation. */
  fork?: { engineSessionId: string; resumeAt?: string };
  /**
   * How the opening run hands off at the end: "drain" delivers any queued
   * prompts right away (web creates); "auto-continue-guard" runs the shared
   * announce-then-stop guard first (MCP creates, which nothing wraps in
   * runSessionPromptAndDrain).
   */
  finish: "drain" | "auto-continue-guard";
}

/** Per-path transport for a create: who hears the announce/stream/failures. */
export function openingCreateTrustPolicy(
  spec: Pick<
    ResolvedCreate,
    | "automationDescendantPolicy"
    | "branch"
    | "runMcpServers"
    | "user"
    | "createdByLogin"
  >,
): {
  automation: boolean;
  mcpServers: McpScope;
  user: string | undefined;
  mcpGrantUser: string | undefined;
  aws: boolean;
  trustProfile: "interactive" | "automation";
  publicationPolicy?: { repo: string; branch: string; headBranch: string };
} {
  const policy = spec.automationDescendantPolicy;
  return {
    automation: !!policy,
    mcpServers: policy ? [] : (spec.runMcpServers as McpScope),
    user: policy ? undefined : spec.user,
    mcpGrantUser: policy ? undefined : spec.createdByLogin,
    aws: !policy,
    trustProfile: policy ? "automation" : "interactive",
    ...(policy
      ? {
          publicationPolicy: {
            repo: policy.publicationRepo,
            branch: policy.baseBranch,
            headBranch: spec.branch,
          },
        }
      : {}),
  };
}

export interface CreateSessionIO {
  /**
   * The session file exists and the id is resolvable — the web adapter sends
   * session_created, the MCP adapter resolves the tool call.
   */
  announce(info: {
    id: string;
    workspaceId?: string;
    newWorkspace: boolean;
    preparingWorkspace: boolean;
    createdBy: string;
    createdAt: string;
  }): void;
  /** A stream event of the opening run (no sessionId stamp — adapters add it). */
  emit(m: Record<string, unknown>): void;
  /** Failure before the announce — no session exists to surface it on. */
  fail(message: string): void;
}

/**
 * The shared create engine: persist + announce the resolved session, then run
 * its opening turn end-to-end. Failures after the announce close out the
 * stream and are recorded on the session (a setup-failed session must not
 * look inexplicably empty — bks-019f472f, 2026-07-09); failures before it go
 * to io.fail.
 */
/**
 * Cut a worktree for each repo the create asked to work in beside its own, and
 * record it on the session. Best-effort per repo: one that can't be checked
 * out (a branch collision in that repo, a fetch that failed) is reported as a
 * notice and the session goes on without it, rather than taking down a create
 * whose real subject is the other repos. Returns the ones that landed — which
 * is what the opening run is then told about, so the agent is never pointed at
 * a worktree that isn't there.
 */
async function attachCreateRepos(
  sessionId: string,
  plan: { repos: string[]; branch: string },
  io: CreateSessionIO,
  gitEnv?: Record<string, string>,
): Promise<string[]> {
  const attached: string[] = [];
  for (const repoId of plan.repos) {
    try {
      await attachRepo(sessionId, repoId, plan.branch, gitEnv);
      attached.push(repoId);
    } catch (e) {
      io.emit({
        type: "notice",
        message: `Couldn't add ${repoId} to this session: ${
          e instanceof Error ? e.message : String(e)
        }. The other repos are ready; add this one from the repo menu when it is.`,
      });
    }
  }
  return attached;
}

export function runnerOpeningHostId(runId: string, generation: number): string {
  const digest = new Bun.CryptoHasher("sha256")
    .update(`${runId}:${generation}`)
    .digest("hex");
  return [
    "rh",
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

const activeOpeningCreates = new Map<
  string,
  {
    identity: string;
    spec: ResolvedCreate;
    io: CreateSessionIO;
    done: Promise<void>;
  }
>();

// Bounds concurrent opening turns (worktree materialization, deps install,
// repo attach and the opening engine turn). Gateway process: configurable via
// ~/.opensession.env or a systemd drop-in.
const OPENING_TURN_CONCURRENCY = envCapacity(
  "OPENSESSION_OPENING_TURN_CONCURRENCY",
  8,
  1,
  64,
);
type OpeningTurnGate = {
  active: number;
  waiters: Array<(release: () => void) => void>;
};
const creationRuntimeGlobal = globalThis as typeof globalThis & {
  __opensessionOpeningTurnGate?: OpeningTurnGate;
};
const openingTurnGate = (creationRuntimeGlobal.__opensessionOpeningTurnGate ??=
  {
    active: 0,
    waiters: [],
  });

function openingTurnRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = openingTurnGate.waiters.shift();
    if (next) next(openingTurnRelease());
    else openingTurnGate.active = Math.max(0, openingTurnGate.active - 1);
  };
}

function acquireOpeningTurn(): Promise<() => void> {
  if (openingTurnGate.active < OPENING_TURN_CONCURRENCY) {
    openingTurnGate.active += 1;
    return Promise.resolve(openingTurnRelease());
  }
  return new Promise((resolve) => openingTurnGate.waiters.push(resolve));
}

export async function waitForCreatedSessionProjection(
  sessionId: string,
  identity: string,
  timeoutMs = 24 * 60 * 60_000,
): Promise<UnifiedSession> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const state = await sessionKernel(sessionId).creationState();
    if (!state || state.identity !== identity)
      throw new Error(
        "Create request identity crossed durable session ownership",
      );
    const projected = findSession(sessionId);
    if (projected) return projected;
    if (state.state === "failed")
      throw new Error("Session creation failed before it was persisted");
    if (state.state === "cancelled")
      throw new Error("Session creation was cancelled before it was persisted");
    if (Date.now() >= deadline)
      throw new Error("Session creation remains durably pending");
    await Bun.sleep(25);
  }
}

export async function actorCreationSetupPlan(
  sessionId: string,
  identity: string,
): Promise<CreationSetupPlan> {
  const state = await ensureCreationPlanned(sessionId, identity);
  if (state.setupPlan || !["planned", "preparing"].includes(state.state))
    return (state.setupPlan ?? {}) as CreationSetupPlan;
  const legacy = readCreatePlan(sessionId, identity);
  if (!legacy) return {};
  return await patchCreationSetupPlan(sessionId, identity, {
    ...(legacy.branch ? { branch: legacy.branch } : {}),
    ...(legacy.workspaceId ? { workspaceId: legacy.workspaceId } : {}),
    ...(legacy.attachments ? { attachments: legacy.attachments } : {}),
    ...(legacy.resolved
      ? { resolved: snapshotOpeningCreate(legacy.resolved) }
      : {}),
  });
}

function snapshotOpeningPlan(spec: ResolvedCreate): Record<string, unknown> {
  const plan = snapshotOpeningCreate(spec);
  if (
    Buffer.byteLength(JSON.stringify(plan)) >
    SESSION_KERNEL_MAX_OPENING_PLAN_BYTES
  )
    throw new Error(
      `Opening recovery input exceeds ${SESSION_KERNEL_MAX_OPENING_PLAN_BYTES} bytes`,
    );
  return plan;
}

// Creation fields as create-if-absent defaults. The early projection and the
// opening turn write the same object, so the file a person sees while the
// workspace is prepared is the one the opening turn later extends.
function createdSessionFileDefaults(spec: ResolvedCreate): NativeSessionFile {
  return {
    id: spec.id,
    claudeSessionId: "",
    branch: spec.persistBranch,
    worktreeDir: spec.wtPath,
    // Repo-less sessions resolve no repoId, and record the absence as
    // a decision so clients don't have to guess (types.ts, repoLess).
    ...(spec.repoId ? { repo: spec.repoId } : { repoLess: true }),
    ...(spec.workspaceId ? { workspaceId: spec.workspaceId } : {}),
    ...(spec.parentSessionId ? { parentSessionId: spec.parentSessionId } : {}),
    ...(spec.spawnDepth !== undefined ? { spawnDepth: spec.spawnDepth } : {}),
    ...(spec.agentStarted ? { agentStarted: true } : {}),
    ...(spec.spawnedBy ? { spawnedBy: spec.spawnedBy } : {}),
    ...(spec.automationDescendantPolicy
      ? {
          automation: spec.automationDescendantPolicy.automationName,
          automationId: spec.automationDescendantPolicy.automationId,
          automationDescendantPolicy: spec.automationDescendantPolicy,
        }
      : {}),
    // Persisted so the failure beacon (handoff-evidence.ts) can tell
    // a worker that owes its parent a report from a child session
    // that was explicitly told not to report (e.g. the PR session).
    ...(spec.parentSessionId && spec.reportBack ? { reportBack: true } : {}),
    createdBy: spec.createdBy,
    ...(spec.createdByLogin ? { createdByLogin: spec.createdByLogin } : {}),
    createdAt: spec.createdAt,
    title: spec.title,
    mode: spec.mode,
    ...(spec.stackedOn && spec.stackedOn.branch !== spec.persistBranch
      ? { stackedOn: spec.stackedOn }
      : {}),
    ...(spec.effort ? { effort: spec.effort } : {}),
    ...(spec.presetNote ? { presetNote: spec.presetNote } : {}),
    ...(enablesPstackMode(spec.displayPrompt) ? { pstackMode: true } : {}),
    ...(spec.fastMode ? { fastMode: true } : {}),
    ...(spec.accountId ? { accountId: spec.accountId } : {}),
    ...(spec.plainThreadId ? { plainThreadId: spec.plainThreadId } : {}),
    ...(spec.externalRefs?.length ? { externalRefs: spec.externalRefs } : {}),
    ...(spec.persistMcpServers !== undefined
      ? { mcpServers: spec.persistMcpServers }
      : {}),
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.sandboxProvider
      ? {
          sandbox: {
            provider: spec.sandboxProvider,
            lifecycle: "preparing",
            // Volume intent is recorded up front so the prompt
            // paths know the workspace never exists host-side
            // (hasRemoteWorkspace) even before the first ensure.
            // Remote providers are ALWAYS volume — no host mounts.
            ...(spec.volumeWorkspace || spec.remoteSandbox
              ? { workspace: "volume" as const }
              : {}),
          },
        }
      : {}),
    ...(spec.runnerTarget
      ? {
          runner: {
            id: spec.runnerTarget.id,
            name: spec.runnerTarget.name,
            workspacePath: spec.runnerTarget.workspacePath,
            lifecycle: "preparing" as const,
          },
        }
      : {}),
    lastActivity: new Date().toISOString(),
  };
}

// The viewer shows "Setting up workspace" and queues sends while any of this
// environment work is still ahead of the opening turn.
function creationPreparesEnvironment(spec: ResolvedCreate): boolean {
  return (
    spec.needsWorktree ||
    !!spec.attachRepos?.repos.length ||
    !!spec.sandboxProvider ||
    !!spec.runnerTarget
  );
}

// The opening prompt's visible transcript row, keyed by its stable dispatch id
// so the runner's later upsert and a replayed create land on the same row.
async function appendOpeningPromptLine(
  spec: ResolvedCreate,
  openingPromptEntryId: string,
): Promise<void> {
  const displayPrompt = spec.displayPrompt ?? spec.titlePrompt;
  if (!displayPrompt.trim() && !spec.images?.length) return;
  await storeAppendUserLineEarly(
    spec.id,
    transcriptLineUser(
      displayPrompt,
      openingPromptEntryId,
      spec.createdAt,
      spec.images,
    ),
    { required: true },
  );
}

// Persist and announce an accepted create before its slow environment setup.
// The create dispatch and setup plan are durable at this point, so the session
// is real: a person must find it in the list while credential, branch and
// attachment effects run, and a reload must still show the prompt they sent.
// Until the opening turn takes run admission the session is held busy, so a
// prompt sent meanwhile queues instead of starting a turn in a worktree that
// does not exist yet.
async function projectAcceptedCreate(
  spec: ResolvedCreate,
  openingPromptEntryId: string,
  io: CreateSessionIO,
): Promise<void> {
  holdPendingOpening(spec.id);
  try {
    await updateSessionFile(spec.id, (data) => ({
      ...createdSessionFileDefaults(spec),
      ...data,
    }));
    await appendOpeningPromptLine(spec, openingPromptEntryId);
  } catch (error) {
    releasePendingOpening(spec.id);
    throw error;
  }
  const preparingWorkspace = creationPreparesEnvironment(spec);
  if (preparingWorkspace) preparingWorkspaces.add(spec.id);
  io.announce({
    id: spec.id,
    workspaceId: spec.announceWorkspaceId,
    newWorkspace: !!spec.createdWorkspaceNow,
    preparingWorkspace,
    createdBy: spec.createdBy,
    createdAt: spec.createdAt,
  });
}

// Surface a setup failure on an announced session: the client is already in
// it, so the stream closes out there and the row reads "Needs input" instead
// of an inexplicably empty session (bks-019f472f, 2026-07-09).
async function reportSetupFailure(
  sessionId: string,
  io: CreateSessionIO,
  message: string,
): Promise<void> {
  // Persist before terminal delivery or creation settlement. A failed
  // outcome projection leaves recovery evidence intact for retry.
  await recordRunOutcome(sessionId, `Session setup failed: ${message}`);
  io.emit({ type: "error", message });
  io.emit({ type: "stream_done" });
  io.emit({ type: "notice", message: `Session setup failed: ${message}` });
  io.emit({ type: "session_status", isRunning: false });
}

// Environment setup failed after the session was projected.
async function failProjectedCreate(
  spec: ResolvedCreate,
  io: CreateSessionIO,
  creationIdentity: string,
  openingPromptEntryId: string,
  error: unknown,
): Promise<void> {
  preparingWorkspaces.delete(spec.id);
  releasePendingOpening(spec.id);
  io.emit({ type: "workspace_status", ready: true });
  const timedOut = isCreationEffectPendingError(error);
  await reportSetupFailure(
    spec.id,
    io,
    timedOut
      ? `Workspace setup did not finish within ${CREATION_SETUP_TIMEOUT_MS / 60_000} minutes`
      : error instanceof Error
        ? error.message
        : String(error),
  );
  try {
    // A timed-out effect is still the actor's current effect. Failing against
    // its id is the one accepted terminal transition; its late receipt is then
    // ignored as stale.
    await settleCreationFailed(
      spec.id,
      creationIdentity,
      error,
      undefined,
      timedOut ? error.effectId : undefined,
    );
  } catch (settleError) {
    // Keep the create dispatch: boot recovery can still resume this create.
    console.error(
      `[create] Could not settle failed setup for ${spec.id}:`,
      settleError,
    );
    return;
  }
  await acknowledgePromptDispatch(spec.id, openingPromptEntryId);
}

// The projection announces once. openCreatedSession's own announce is then the
// idempotent second pass; restart recovery still re-announces to the session
// room through its fresh io.
function announceOnce(io: CreateSessionIO): CreateSessionIO {
  let announced = false;
  return {
    ...io,
    announce: (info) => {
      if (announced) return;
      announced = true;
      io.announce(info);
    },
  };
}

export function runOpeningCreateOnce(
  spec: ResolvedCreate,
  callerIo: CreateSessionIO,
  creationIdentity: string,
): { owner: boolean; done: Promise<void> } {
  const existing = activeOpeningCreates.get(spec.id);
  if (existing) {
    if (existing.identity !== creationIdentity)
      throw new Error(
        "Create request identity crossed active opening ownership",
      );
    return { owner: false, done: existing.done };
  }
  const io = announceOnce(callerIo);
  // Validate and bound actor recovery input before accepting the prompt dispatch.
  const openingPlan = snapshotOpeningPlan(spec);
  const done = (async () => {
    const openingPromptEntryId = await beginPromptDispatch(
      spec.id,
      [
        {
          content: spec.openingPrompt,
          user: spec.user,
          ...(spec.images?.length
            ? {
                images: spec.images.map(
                  (image) => `data:${image.mediaType};base64,${image.data}`,
                ),
              }
            : {}),
        },
      ],
      spec.openingPromptEntryId,
      true,
      "create",
    );
    if (openingPromptEntryId !== spec.openingPromptEntryId)
      throw new Error("Opening prompt identity changed before actor dispatch");
    // The prompt and setup plan are durable: show the session now. Every
    // later step (credential, branch and attachment effects, the opening-turn
    // queue) can take minutes, and a create that exists only as a client-side
    // shell reads as lost the moment that shell is gone.
    try {
      await projectAcceptedCreate(spec, openingPromptEntryId, io);
    } catch (error) {
      io.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
    // The creation actor owns one physical effect at a time. Materialize the
    // primary worktree before dispatching the long-running opening effect;
    // otherwise openCreatedSession would try to emit a branch effect while the
    // opening already held the creation fence. The later call inside
    // openCreatedSession adopts this completed receipt and remains restart-safe.
    if (spec.needsWorktree && spec.materializeWorktree) {
      try {
        await spec.materializeWorktree();
      } catch (error) {
        await failProjectedCreate(
          spec,
          io,
          creationIdentity,
          openingPromptEntryId,
          error,
        );
        throw error;
      }
    }
    await requestCreationOpening({
      sessionId: spec.id,
      identity: creationIdentity,
      openingPromptEntryId,
      runId: `opening:${spec.id}:${openingPromptEntryId}`,
      runGeneration: 1,
      openingPlan,
    });
  })().finally(() => {
    if (activeOpeningCreates.get(spec.id)?.done === done)
      activeOpeningCreates.delete(spec.id);
  });
  activeOpeningCreates.set(spec.id, {
    identity: creationIdentity,
    spec,
    io,
    done,
  });
  return { owner: true, done };
}

// The session is already projected while its git work runs, so this bound is
// only a backstop against an effect that never settles. The actor keeps the
// credential and branch effects durable either way; a timeout records a setup
// failure on the visible session instead of leaving it preparing forever.
const CREATION_SETUP_TIMEOUT_MS = 10 * 60_000;
const CREATION_SETUP_POLL_MS = 100;

export function actorWorktreeMaterializer(input: {
  sessionId: string;
  identity: string;
  project: string;
  branch: string;
  worktreePath: string;
  baseBranch?: string;
  isolated: boolean;
  existingBranch?: boolean;
  credentialPrincipal?: string;
}): () => Promise<string> {
  const wait = {
    timeoutMs: CREATION_SETUP_TIMEOUT_MS,
    pollMs: CREATION_SETUP_POLL_MS,
  };
  return async () => {
    if (input.credentialPrincipal) {
      await requestCreationCredential(
        {
          sessionId: input.sessionId,
          identity: input.identity,
          principal: input.credentialPrincipal,
          scope: `git:${input.project}`,
        },
        wait,
      );
    }
    await requestCreationBranch(
      {
        sessionId: input.sessionId,
        identity: input.identity,
        project: input.project,
        branch: input.branch,
        worktreePath: input.worktreePath,
        baseBranch: input.baseBranch || getRepo(input.project).defaultBranch,
        isolated: input.isolated,
        existingBranch: input.existingBranch,
        credentialPrincipal: input.credentialPrincipal,
      },
      wait,
    );
    return input.worktreePath;
  };
}

async function restorePlannedOpening(sessionId: string): Promise<{
  spec: ResolvedCreate;
  io: CreateSessionIO;
  identity: string;
} | null> {
  const creation = await sessionKernel(sessionId).creationState();
  const actorPlan =
    creation?.openingPlan ??
    (creation?.setupPlan?.resolved as Record<string, unknown> | undefined);
  const legacyPlan = actorPlan
    ? undefined
    : readCreatePlanForRecovery(sessionId);
  const openingPlan = actorPlan ?? legacyPlan?.resolved;
  const identity = actorPlan ? creation!.identity : legacyPlan?.identity;
  if (!openingPlan || !identity) return null;
  const restored = restoreResolvedCreate<ResolvedCreate>(openingPlan);
  let dispatch = promptDispatches.get(sessionId);
  if (
    !dispatch &&
    actorPlan &&
    creation?.state === "opening_dispatched" &&
    typeof restored.openingPromptEntryId === "string" &&
    restored.openingPromptEntryId &&
    typeof restored.openingPrompt === "string"
  ) {
    // A pre-schema-22 recovery pass could remove the create dispatch before
    // the session file existed. The opening plan is write-once and carries the
    // exact prompt identity, so restore that same actor receipt before launch.
    const promptEntryId = restored.openingPromptEntryId;
    const openingPrompt = restored.openingPrompt;
    const recoveredDispatch = {
      promptEntryId,
      items: [
        {
          content: openingPrompt,
          user: restored.user,
          ...(restored.images?.length
            ? {
                images: restored.images.map(
                  (image) => `data:${image.mediaType};base64,${image.data}`,
                ),
              }
            : {}),
        },
      ],
      kind: "create" as const,
    };
    await promptDispatches.set(sessionId, recoveredDispatch);
    dispatch = recoveredDispatch;
  }
  if (dispatch?.kind !== "create") return null;
  const restoredGitEnv = githubCredentialForPrincipal(
    restored.gitPrincipal,
  )?.env;
  if (
    typeof restored.wtPath !== "string" ||
    typeof restored.branch !== "string" ||
    (restored.needsWorktree && typeof restored.repoId !== "string")
  )
    return null;
  const ready = restored.needsWorktree
    ? await isRegisteredWorktree(
        restored.wtPath,
        restored.repoId!,
        restored.branch,
      )
    : true;
  const materializeWorktree =
    restored.needsWorktree && !ready
      ? actorWorktreeMaterializer({
          sessionId,
          identity,
          project: restored.repoId!,
          branch: restored.branch,
          worktreePath: restored.wtPath,
          baseBranch: restored.worktreeBaseRef || restored.stackedOn?.branch,
          isolated: restored.worktreeIsolated === true,
          existingBranch: restored.worktreeKind === "existing",
          credentialPrincipal: restored.gitPrincipal,
        })
      : undefined;
  const imageUrls = dispatch.items.flatMap((item) => item.images || []);
  return {
    identity,
    spec: {
      ...(restored as ResolvedCreate),
      id: sessionId,
      openingPromptEntryId: dispatch.promptEntryId,
      images: parseImageDataUrls(imageUrls),
      gitEnv: restoredGitEnv,
      materializeWorktree,
      needsWorktree: !!materializeWorktree,
    },
    io: {
      // Recovery has no creator socket, so the announce goes to the session
      // room: any client already watching (or the sessions poll within 5s)
      // learns the session exists even while the opening effect is still
      // queued behind other outbox work. A no-op here left restart-recovered
      // creates invisible until the slow opening turn finished.
      announce: (info) => {
        broadcastToSession(sessionId, {
          type: "session_created",
          sessionId,
          id: info.id,
          ...(info.workspaceId ? { workspaceId: info.workspaceId } : {}),
        });
        broadcastToSession(sessionId, { type: "stream_start", sessionId });
      },
      emit: (message) =>
        broadcastToSession(sessionId, { ...message, sessionId }),
      fail: (message) =>
        broadcastToSession(sessionId, {
          type: "notice",
          sessionId,
          message,
        }),
    },
  };
}

export async function settleStoppedCreationOpening(
  item: CreationOpeningEffectItem,
): Promise<boolean> {
  const kernel = sessionKernel(item.sessionId);
  const turn = await sessionTurnSnapshot(item.sessionId);
  // Exact cancel identity, matching openingTurnWasCancelled(): a retained
  // receipt fences only the exact run it cancelled. The receipt records the
  // admitted physical token derived from the effect payload, so recompute it
  // here. `stopped` alone still fences because creation is single-shot —
  // while it is opening_dispatched the opening turn is the only run Stop
  // could have targeted.
  const cancel = turn.cancel;
  const exactCancel =
    cancel != null &&
    cancel.runId ===
      runnerOpeningHostId(item.payload.runId, item.payload.runGeneration) &&
    cancel.runGeneration === item.payload.runGeneration;
  if (kernel.runStateProjection().state !== "stopped" && !exactCancel)
    return false;
  await settleCreationCancelled(
    item.sessionId,
    item.payload.creationIdentity,
    kernel,
    item.effectKey,
  );
  await acknowledgePromptDispatch(
    item.sessionId,
    item.payload.openingPromptEntryId,
  );
  clearCreatePlan(item.sessionId);
  return true;
}

export async function executeCreationOpeningEffect(
  item: CreationOpeningEffectItem,
): Promise<void> {
  const state = await sessionKernel(item.sessionId).creationState();
  if (!state || state.identity !== item.payload.creationIdentity)
    throw new Error("Opening effect crossed durable creation ownership");
  if (state.generation !== item.payload.creationGeneration)
    throw new Error("Opening effect used a stale creation generation");
  if (
    (state.state === "ready" ||
      state.state === "failed" ||
      state.state === "cancelled") &&
    state.completedEffectIds.includes(item.effectKey)
  ) {
    await acknowledgePromptDispatch(
      item.sessionId,
      item.payload.openingPromptEntryId,
    );
    if (state.state === "ready" || state.state === "cancelled")
      clearCreatePlan(item.sessionId);
    return;
  }
  if (await settleStoppedCreationOpening(item)) return;
  if (
    state.state !== "opening_dispatched" ||
    state.currentEffectId !== item.effectKey
  )
    throw new Error("Opening effect no longer owns the creation lifecycle");
  const openingRunKey = runnerOpeningHostId(
    item.payload.runId,
    item.payload.runGeneration,
  );
  const claimedRecovery = activeAgentRecoveryRecord(openingRunKey);
  const openingJournal =
    activeRunRecords().find(
      (run) =>
        run.osSessionId === item.sessionId &&
        run.promptEntryId === item.payload.openingPromptEntryId,
    ) ??
    (claimedRecovery?.osSessionId === item.sessionId &&
    claimedRecovery.promptEntryId === item.payload.openingPromptEntryId
      ? claimedRecovery
      : undefined);
  if (openingJournal?.terminalFailure) {
    await settleCreationFailed(
      item.sessionId,
      item.payload.creationIdentity,
      new Error(openingJournal.terminalFailure.content),
      sessionKernel(item.sessionId),
      item.effectKey,
    );
    await acknowledgePromptDispatch(
      item.sessionId,
      item.payload.openingPromptEntryId,
    );
    journalClearIfLineage(openingJournal);
    return;
  }
  const localRecovery =
    !!openingJournal && !openingJournal.runnerId && !openingJournal.sandboxId;
  if (localRecovery) {
    // Boot's generic local-run adopter owns the exact journal. It settles the
    // actor from its terminal callback; waiting here keeps the durable effect
    // pending without launching a second engine turn.
    while (true) {
      const recovered = await sessionKernel(item.sessionId).creationState();
      if (
        (recovered?.state === "ready" ||
          recovered?.state === "failed" ||
          recovered?.state === "cancelled") &&
        recovered.completedEffectIds.includes(item.effectKey)
      ) {
        await acknowledgePromptDispatch(
          item.sessionId,
          item.payload.openingPromptEntryId,
        );
        if (recovered.state === "ready" || recovered.state === "cancelled")
          clearCreatePlan(item.sessionId);
        return;
      }
      if (await settleStoppedCreationOpening(item)) return;
      if (
        !recovered ||
        recovered.identity !== item.payload.creationIdentity ||
        recovered.generation !== item.payload.creationGeneration ||
        recovered.currentEffectId !== item.effectKey
      )
        throw new Error("Recovered local opening lost durable ownership");
      const journals = activeRunRecords();
      const expectedLineage =
        openingJournal.firstJournaledAt || openingJournal.startedAt;
      const exactOwner = journals.some(
        (run) =>
          run.runKey === openingJournal.runKey &&
          run.osSessionId === openingJournal.osSessionId &&
          (run.firstJournaledAt || run.startedAt) === expectedLineage,
      );
      const replacementOwner = journals.some(
        (run) =>
          run.osSessionId === item.sessionId &&
          (run.runKey !== openingJournal.runKey ||
            (run.firstJournaledAt || run.startedAt) !== expectedLineage),
      );
      if (!exactOwner && !replacementOwner) {
        // Recovery owns journal retirement. If its terminal callback dies
        // between retiring that owner and settling creation, the opening
        // effect used to wait forever and permanently block every follow-up
        // behind the create dispatch. The actor's exact generation + terminal
        // event is durable proof; a process-local projection is not.
        const run = await sessionRunStateSnapshot(item.sessionId);
        if (
          run.generation === item.payload.runGeneration &&
          !run.currentRunId
        ) {
          if (run.state === "idle" && run.lastEvent === "turn_end") {
            await settleCreationSucceeded(
              item.sessionId,
              item.payload.creationIdentity,
              sessionKernel(item.sessionId),
              item.effectKey,
            );
          } else if (run.state === "failed") {
            await settleCreationFailed(
              item.sessionId,
              item.payload.creationIdentity,
              new Error(
                "Recovered opening run failed before creation settlement",
              ),
              sessionKernel(item.sessionId),
              item.effectKey,
            );
          } else if (run.state === "stopped") {
            await settleCreationCancelled(
              item.sessionId,
              item.payload.creationIdentity,
              sessionKernel(item.sessionId),
              item.effectKey,
            );
          } else {
            await Bun.sleep(100);
            continue;
          }
          await acknowledgePromptDispatch(
            item.sessionId,
            item.payload.openingPromptEntryId,
          );
          if (run.state !== "failed") clearCreatePlan(item.sessionId);
          return;
        }
      }
      await Bun.sleep(100);
    }
  }
  const active = activeOpeningCreates.get(item.sessionId);
  if (active && active.identity !== item.payload.creationIdentity)
    throw new Error("Opening effect crossed active creation ownership");
  const restored = active
    ? { spec: active.spec, io: active.io, identity: active.identity }
    : await restorePlannedOpening(item.sessionId);
  if (!restored)
    throw new Error("Opening effect has no durable actor plan to recover");
  if (restored.identity !== item.payload.creationIdentity)
    throw new Error(
      "Opening effect actor-plan identity changed during recovery",
    );
  if (restored.spec.openingPromptEntryId !== item.payload.openingPromptEntryId)
    throw new Error("Opening effect prompt identity changed during recovery");
  if (await settleStoppedCreationOpening(item)) return;
  await openCreatedSession(
    restored.spec,
    restored.io,
    restored.identity,
    item.effectKey,
    {
      runId: item.payload.runId,
      generation: item.payload.runGeneration,
    },
  );
  const settled = await sessionKernel(item.sessionId).creationState();
  if (settled?.state === "ready" || settled?.state === "cancelled")
    clearCreatePlan(item.sessionId);
  else if (settled?.state !== "failed")
    throw new Error(
      "Opening effect returned without terminal actor settlement",
    );
}

export async function resumePlannedCreate(sessionId: string): Promise<boolean> {
  const state = await sessionKernel(sessionId).creationState();
  if (state?.state === "ready" || state?.state === "cancelled") {
    clearCreatePlan(sessionId);
    return true;
  }
  if (
    state?.state === "failed" ||
    state?.currentEffectId?.startsWith("opening:")
  )
    return true;
  const restored = await restorePlannedOpening(sessionId);
  if (!restored) return false;
  const opening = runOpeningCreateOnce(
    restored.spec,
    restored.io,
    restored.identity,
  );
  if (opening.owner) await opening.done;
  return true;
}

export function assertAutomationDescendantOpeningIsolation(
  spec: Pick<
    ResolvedCreate,
    "automationDescendantPolicy" | "sandboxProvider" | "runnerTarget"
  >,
): void {
  if (
    spec.automationDescendantPolicy &&
    !spec.sandboxProvider &&
    !spec.runnerTarget
  )
    throw new Error(
      "Automation descendant opening turns require an isolated sandbox or Runner",
    );
}

export async function openCreatedSession(
  spec: ResolvedCreate,
  io: CreateSessionIO,
  creationIdentity: string,
  creationEffectId?: string,
  openingRun?: { runId: string; generation: number },
): Promise<void> {
  assertAutomationDescendantOpeningIsolation(spec);
  const bksId = spec.id;
  const pstackMode = enablesPstackMode(spec.displayPrompt);
  const pendingAttach = spec.attachRepos?.repos.length
    ? spec.attachRepos
    : null;
  const preparingEnvironment = creationPreparesEnvironment(spec);
  // Replace the raw first-line title with a short summary in the background;
  // the next sessions poll (≤5s) picks it up. A workspace minted by THIS
  // create is named ONCE from the same generated summary (it provisionally
  // wore the raw first line) and keeps that name for life — later sessions
  // never rename it, and a manual rename in the meantime wins.
  const wsToName = spec.autoNameWorkspace;
  void nameKnownSessionReferencesForTitle(spec.titlePrompt)
    .then((titlePrompt) =>
      ensureGeneratedTitle(bksId, titlePrompt, spec.user, spec.model),
    )
    .then((t) => {
      if (!t) return;
      invalidateSessionsCache();
      if (!wsToName) return;
      const cur = getWorkspace(wsToName.id);
      if (cur && cur.name === wsToName.name)
        updateWorkspace(wsToName.id, { name: t });
    })
    .catch(() => {});

  // Set once the session has been announced — a later failure must then
  // close out the stream instead of leaving the just-opened viewer spinning.
  let announced = false;
  let creationSettled = false;
  let engineSessionId = "";
  let effectiveModel = spec.model;
  let selectedModel = spec.model;
  let effectiveProvider = providerFor(effectiveModel);
  const modelHistory: NonNullable<NativeSessionFile["modelHistory"]> = [];
  let persisted = false;
  let releaseOpeningTurn: (() => void) | undefined;
  let startToken = "";
  let startGeneration = 0;
  const openingTurnWasCancelled = async (): Promise<boolean> => {
    if (!startToken || startGeneration < 1) return false;
    const cancel = (await sessionTurnSnapshot(bksId)).cancel;
    return (
      cancel?.runId === startToken && cancel.runGeneration === startGeneration
    );
  };
  // Cumulative token/cost for this new session's opening run.
  let latestUsage: SessionUsage | undefined;
  // Extra repos that actually got a worktree (see attachCreateRepos) — what
  // the opening run's repos note and memory scopes are built from.
  let attachedRepoIds: string[] = [];
  // A sandbox opening turn can spend minutes provisioning before its run
  // journal exists. Keep that prompt in the durable intake dispatch until the
  // sandbox host journals it, so a service restart requeues rather than loses it.
  let openingPromptEntryId: string | undefined;
  // Terminal failure the opening run died on — recorded after the loop so
  // the fresh session surfaces as "Needs input".
  let runFailure: string | null = null;
  // The runner already wrote its own, friendlier transcript line.
  let failureNoticePersisted = false;
  // The opening turn's reply and tool count, for the announce-then-stop
  // guard (finish: "auto-continue-guard").
  let assistantText = "";
  let toolUseCount = 0;
  // Actual worktree HEAD when it drifted from the recorded branch (the
  // agent switched/renamed branches during the opening turn).
  const headBranchPatch = () => {
    if (spec.runnerTarget) return {};
    const head = spec.persistBranch ? worktreeHeadBranch(spec.wtPath) : null;
    return head && head !== spec.branch ? { branch: head } : {};
  };
  // Field-scoped write: creation fields are create-if-absent defaults
  // (an existing file — the early projection, or one touched with the
  // engine id or a materialized sandboxId while the opening run streams —
  // wins); this run only owns the engine-id/model/HEAD-sync fields it
  // actually changes. Serialized via updateSessionFile.
  const persist = () =>
    updateSessionFile(bksId, (data) => {
      // Widen to Partial: the file may not exist yet.
      const existing: Partial<NativeSessionFile> = data;
      return {
        ...createdSessionFileDefaults(spec),
        ...existing,
        ...(engineSessionId
          ? engineSessionPatch(effectiveProvider, engineSessionId)
          : {}),
        // Record the engine that ran so the first later cross-provider
        // switch bridges context (see runSessionPromptInner handoff).
        ...(engineSessionId ? { lastEngineProvider: effectiveProvider } : {}),
        ...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(modelHistory.length ? { modelHistory } : {}),
        ...headBranchPatch(),
        lastActivity: new Date().toISOString(),
      };
    }).then(() => {
      persisted = true;
    });

  try {
    // Persist + announce BEFORE the slow parts (repo attach, engine boot
    // with its MCP connects) so the client drops into the empty session
    // immediately — the title fills in from the background summary and the
    // opening turn streams in when the engine is up. runOpeningCreateOnce
    // normally projected the session already; this pass is idempotent and
    // covers a restart-recovered opening. The starting mark keeps a prompt
    // typed in that window from double-starting a run (same race as
    // runSessionPrompt); the pending-opening hold covered it until now.
    startToken = await markSessionStarting(
      bksId,
      openingRun
        ? runnerOpeningHostId(openingRun.runId, openingRun.generation)
        : undefined,
    );
    if (currentAgentRunToken(bksId) !== startToken) {
      unmarkSessionStarting(bksId, startToken);
      throw new Error("Opening turn is already owned by another preparation");
    }
    const admittedRun = sessionKernel(bksId).runStateProjection();
    if (admittedRun.currentRunId !== startToken) {
      // Release the process reservation before failing: this throw lands
      // outside the inner try/finally that would otherwise unmark it.
      unmarkSessionStarting(bksId, startToken);
      throw new Error("Opening turn lost actor admission before preparation");
    }
    startGeneration = admittedRun.generation;
    // The run-state admission now holds later prompts behind this turn.
    releasePendingOpening(bksId);
    if (preparingEnvironment) preparingWorkspaces.add(bksId);
    try {
      openingPromptEntryId = await beginPromptDispatch(
        bksId,
        [
          {
            content: spec.openingPrompt,
            user: spec.user,
            ...(spec.images?.length
              ? {
                  images: spec.images.map(
                    (image) => `data:${image.mediaType};base64,${image.data}`,
                  ),
                }
              : {}),
          },
        ],
        spec.openingPromptEntryId,
        true,
        "create",
      );
      await persist();
      // The opening prompt is accepted before slow workspace setup. Persist
      // its visible row at the same boundary so a setup failure cannot leave
      // a titled but empty session. The runner later upserts this stable id.
      await appendOpeningPromptLine(spec, openingPromptEntryId);
      // A session starting in a workspace consumes its draft. The
      // composer prompt it held is now this session's opening prompt.
      // After persist() so this never races the create with a client
      // still editing the draft through the workspace PATCH route.
      if (spec.workspaceId) {
        const ws = getWorkspace(spec.workspaceId);
        if (ws?.draft) updateWorkspace(ws.id, { draft: null });
      }
      io.announce({
        id: bksId,
        workspaceId: spec.announceWorkspaceId,
        newWorkspace: !!spec.createdWorkspaceNow,
        preparingWorkspace: preparingEnvironment,
        createdBy: spec.createdBy,
        createdAt: spec.createdAt,
      });
      announced = true;
      // A teammate tagged in the opening message is tagged like one in
      // any other message: the session exists now, so the badge has a row
      // to land on. Scanned from the raw prompt, never the assembled one,
      // so a repo note or a handoff cannot invent a mention.
      void notifyMentions(
        spec.titlePrompt,
        spec.user || "",
        bksId,
        "prompt",
        spec.title || "a session",
      );
      // Projection is latency-sensitive; the agent turn is capacity-sensitive.
      // Persist and announce every accepted session first, then wait for one of
      // the bounded opening-run slots. Keeping the gate here prevents eight long
      // turns from hiding every later session behind "Setting up workspace".
      releaseOpeningTurn = await acquireOpeningTurn();

      // Every worktree this session works in, its own first. The extra
      // repos are cut inside the same gate: they are git work of the same
      // order, and flipping the viewer to ready before them would tell the
      // reader the workspace was up while it was still being assembled.
      if ((spec.needsWorktree && spec.materializeWorktree) || pendingAttach) {
        try {
          if (spec.needsWorktree && spec.materializeWorktree) {
            await spec.materializeWorktree();
            // Deps install runs in the background (worktree.ts) — say
            // so, since builds/tests may not be ready for a beat.
            io.emit({
              type: "notice",
              message:
                "Workspace ready — installing dependencies in the background.",
            });
          }
          if (pendingAttach)
            attachedRepoIds = await attachCreateRepos(
              bksId,
              pendingAttach,
              io,
              spec.gitEnv,
            );
        } finally {
          // Ready (or failed — the error surfaces separately): flip the
          // viewer out of "Waiting for workspace" and let the queue go.
          preparingWorkspaces.delete(bksId);
          io.emit({ type: "workspace_status", ready: true });
        }
      }

      const retrievedMemory = await retrievedMemoryNoteFor(
        spec.openingPrompt,
        spec.user,
        [...spec.memoryRepoIds, ...attachedRepoIds],
      );
      const openingPromptForRun = retrievedMemory
        ? `${retrievedMemory}\n\n${spec.openingPrompt}`
        : spec.openingPrompt;

      // Sandbox session: route the OPENING turn through the same
      // launcher the prompt path uses (the session file was persisted
      // above, so it resolves) — bind mode included, so the first turn
      // runs in the sandbox like every later one (the worktree was
      // created above, so the bind mounts are ready; ensure() is
      // idempotent + per-session locked, and later prompts are held
      // behind markSessionStarting, so there's no double-ensure race).
      // A failed launch errors the stream for every selected provider.
      // Bind mode has a host checkout, but silently using it would still
      // change the chosen isolation boundary.
      let sandboxOpeningRun: AsyncGenerator<StreamEvent> | null = null;
      let runnerOpeningRun: AsyncGenerator<StreamEvent> | null = null;
      if (spec.sandboxProvider) {
        // The opening effect holds the creation actor's single-effect
        // fence, so a second durable prepare intent cannot run here.
        // Provisioning rides maybeLaunchSandboxedRun's idempotent,
        // per-session-locked provider.ensure instead: a crash replays the
        // opening effect and adopts the same canonical session sandbox.
        const created = findSession(bksId);
        sandboxOpeningRun = created
          ? await maybeLaunchSandboxedRun(created, {
              prompt: openingPromptForRun,
              cwd: spec.wtPath,
              user: spec.user,
              images: spec.images,
              mcpServers: spec.automationDescendantPolicy
                ? []
                : (spec.runMcpServers ?? []),
              isAutomationSession: !!spec.automationDescendantPolicy,
              startToken,
              promptEntryId: openingPromptEntryId,
            })
          : null;
        if (!sandboxOpeningRun) {
          throw new Error(
            "Sandbox unavailable - the opening prompt was not run. Check the selected sandbox connection and retry.",
          );
        }
        preparingWorkspaces.delete(bksId);
        io.emit({ type: "workspace_status", ready: true });
      }
      if (spec.runnerTarget) {
        const cloneToken = spec.repoId
          ? await githubAppRepositoryToken(getRepo(spec.repoId).ghRepo)
          : null;
        await prepareRunnerWorkspace(spec.runnerTarget.id, {
          sessionId: bksId,
          repo: spec.repoId || "",
          branch: spec.branch,
          workspacePath: spec.runnerTarget.workspacePath,
          repositoryUrl: spec.runnerTarget.repositoryUrl,
          ...(cloneToken ? { cloneToken } : {}),
          user: spec.user,
          automationDescendant: !!spec.automationDescendantPolicy,
        });
        await touchNativeSession(bksId, {
          runner: {
            id: spec.runnerTarget.id,
            name: spec.runnerTarget.name,
            workspacePath: spec.runnerTarget.workspacePath,
            lifecycle: "awake",
          },
        });
        invalidateSessionsCache();
        const stored = await findSessionAsync(bksId);
        // The session-list projection may still hold the pre-Runner create row
        // for this same command turn. Launch from the just-committed immutable
        // target rather than treating that projection lag as no Runner.
        const created = stored
          ? {
              ...stored,
              runner: {
                id: spec.runnerTarget.id,
                name: spec.runnerTarget.name,
                workspacePath: spec.runnerTarget.workspacePath,
                lifecycle: "awake" as const,
              },
              ...(spec.automationDescendantPolicy
                ? {
                    automationDescendantPolicy: spec.automationDescendantPolicy,
                  }
                : {}),
            }
          : null;
        runnerOpeningRun = created
          ? await maybeLaunchRunnerRun(created, {
              prompt: openingPromptForRun,
              promptEntryId: openingPromptEntryId,
              hostId: startToken,
              shouldCancel: () => isAgentSessionCancelled(bksId, startToken),
              images: spec.images,
              mcpServers: spec.automationDescendantPolicy
                ? []
                : (spec.runMcpServers ?? []),
              // Authorization still uses the stored automation actor. The
              // Runner launch derives a separate credential-free run identity.
              user: spec.user,
              reposNote: spec.automationDescendantPolicy
                ? undefined
                : [
                    pstackMode ? PSTACK_MODE_NOTE : "",
                    buildBranchNote({
                      mode: spec.mode,
                      branch: spec.branch,
                      worktreeDir: spec.wtPath,
                    }),
                    await memoryNoteFor(spec.user, spec.memoryRepoIds),
                  ]
                    .filter(Boolean)
                    .join("\n\n") || undefined,
            })
          : null;
        if (!runnerOpeningRun)
          throw new Error(
            "Runner unavailable. Check its connection and retry.",
          );
        preparingWorkspaces.delete(bksId);
        io.emit({ type: "workspace_status", ready: true });
      }

      // The session as persisted, once it spans repos: the map the agent
      // gets is read back rather than reassembled, so it can only name
      // worktrees that were actually cut.
      const spanning = attachedRepoIds.length ? findSession(bksId) : null;
      const settlePhysicalCompletion = async (): Promise<void> => {
        if (creationSettled) return;
        if (!persisted) await persist();
        else
          await touchNativeSession(bksId, {
            ...engineSessionPatch(effectiveProvider, engineSessionId),
            ...(engineSessionId
              ? { lastEngineProvider: effectiveProvider }
              : {}),
            ...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
            ...(modelHistory.length ? { modelHistory } : {}),
            ...headBranchPatch(),
          });
        if (latestUsage)
          await touchNativeSession(bksId, { usage: latestUsage });
        await recordRunOutcome(bksId, runFailure, {
          engineSessionId,
          noticePersisted: failureNoticePersisted,
          runId: startToken,
          runGeneration: startGeneration,
          projectionId: `outcome:${startToken}`,
        });
        // This runs in the terminal event's consumer body, before requesting
        // the generator's next item. Backend generator finally blocks may now
        // retire their journal/host only after the actor has the receipt.
        if (await openingTurnWasCancelled())
          await settleCreationCancelled(
            bksId,
            creationIdentity,
            undefined,
            creationEffectId,
          );
        else
          await settleCreationSucceeded(
            bksId,
            creationIdentity,
            undefined,
            creationEffectId,
          );
        creationSettled = true;
        await acknowledgePromptDispatch(bksId, openingPromptEntryId);
      };
      const openingTrust = openingCreateTrustPolicy(spec);
      const automationChild = openingTrust.automation;
      const openingMcp = automationChild
        ? {}
        : interactiveMcpServers(spec.user, bksId);
      const openingDeniedTools = automationChild
        ? (await import("./automations")).automationDeniedTools()
        : undefined;
      const openingReposNote = automationChild
        ? undefined
        : [
            spec.presetNote || "",
            pstackMode ? PSTACK_MODE_NOTE : "",
            // A session that spans repos is handed the persisted map rather
            // than a reconstructed branch note.
            spanning
              ? buildReposNote(spanning)
              : buildBranchNote({
                  mode: spec.mode,
                  branch: spec.branch,
                  worktreeDir: spec.wtPath,
                }),
            await memoryNoteFor(spec.user, [
              ...spec.memoryRepoIds,
              ...attachedRepoIds,
            ]),
          ]
            .filter(Boolean)
            .join("\n\n") || undefined;
      if (automationChild && !sandboxOpeningRun && !runnerOpeningRun)
        throw new Error(
          "Automation descendant opening turns require an isolated sandbox or Runner",
        );
      const localOpeningRun =
        sandboxOpeningRun || runnerOpeningRun
          ? null
          : runAgentHosted({
              osSessionId: bksId,
              prompt: openingPromptForRun,
              // A recovered create is the same logical turn. Reuse the durable
              // intake id so the transcript upserts the original user row.
              promptEntryId: openingPromptEntryId,
              startToken,
              shouldCancel: () => isAgentSessionCancelled(bksId, startToken),
              cwd: spec.wtPath,
              mode: spec.mode,
              mcpGrantUser: openingTrust.mcpGrantUser,
              model: spec.model,
              effort: spec.effort,
              fastMode: spec.fastMode,
              accountId: spec.accountId,
              fallbackModel: interactiveFallbackModel(spec.model),
              mcpServers: openingTrust.mcpServers,
              proxyMcpServers: Object.keys(openingMcp),
              reposNote: openingReposNote,
              images: spec.images,
              ...(spec.fork
                ? {
                    sessionId: spec.fork.engineSessionId,
                    forkSession: true,
                    resumeSessionAt: spec.fork.resumeAt,
                  }
                : {}),
              deniedTools: openingDeniedTools,
              publicationPolicy: openingTrust.publicationPolicy,
              confirmTools: STRIPE_CONFIRM_TOOLS,
              aws: openingTrust.aws,
              author: commitAuthorFor(spec.user, spec.createdBy),
              user: openingTrust.user,
              journalKind: automationChild ? "automation" : "create",
              trustProfile: openingTrust.trustProfile,
              onAskUser: automationChild ? undefined : makeAskHandler(bksId),
              fallbackInProcessMcp: () => openingMcp,
            });
      const openingRun =
        sandboxOpeningRun ?? runnerOpeningRun ?? localOpeningRun;
      if (!openingRun) throw new Error("Opening run isolation unavailable");
      for await (const event of openingRun) {
        // Opening turns use this event ladder instead of run-session's
        // follow-up ladder. Consume Pi's exact boundary acknowledgement here
        // too, including context-only steers that transcript parsing hides.
        if (event.type === "steer_delivered" && event.steerId) {
          await acknowledgeSteerDelivery(bksId, event.steerId);
        }
        if (event.type === "init") {
          engineSessionId = event.sessionId || "";
          if (event.provider) effectiveProvider = event.provider;
          if (event.model) effectiveModel = event.model;
          // Session was persisted/announced before setup — just record
          // the engine id so the run is resumable while it streams.
          await touchNativeSession(bksId, {
            ...engineSessionPatch(effectiveProvider, engineSessionId),
            ...(engineSessionId
              ? { lastEngineProvider: effectiveProvider }
              : {}),
            ...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
          });
          // The transcript file didn't exist when viewers sent their
          // watch (fresh session) — attach them now so this first turn
          // streams live instead of only appearing after a re-watch.
          if (engineSessionId) {
            attachSessionWatchersToEngineTranscript(
              bksId,
              effectiveProvider,
              spec.wtPath,
              engineSessionId,
            );
          }
        }
        if (event.type === "model_switch") {
          const to = event.toModel || "";
          const reason = `auto-switch — ${modelLabel(event.fromModel)} ${event.switchReason || "out of credits"}`;
          if (to) {
            effectiveModel = to;
            effectiveProvider = providerFor(to);
            if (shouldPersistModelSwitch(event)) {
              selectedModel = to;
              modelHistory.push({
                model: to,
                from: event.fromModel,
                at: new Date().toISOString(),
                by: reason,
              });
              await touchNativeSession(bksId, {
                model: selectedModel,
                modelHistory,
              });
              io.emit({
                type: "model_changed",
                model: to,
                from: event.fromModel,
                by: reason,
              });
            } else {
              io.emit({
                type: "notice",
                message: `${modelLabel(event.fromModel)} ${event.switchReason || "fell back"} — using ${modelLabel(to)} for this turn only.`,
              });
            }
          }
        }
        if (event.type === "text_chunk") {
          assistantText += event.text;
          io.emit({ type: "stream_text", text: event.text });
        }
        if (event.type === "tool_use") {
          toolUseCount++;
          const entry = {
            id: event.toolUseId || crypto.randomUUID(),
            type: "tool_use" as const,
            content: `Using ${event.toolName}`,
            timestamp: new Date().toISOString(),
            toolName: event.toolName,
            toolInput: event.toolInput,
            toolUseId: event.toolUseId,
          };
          io.emit({ type: "stream_tool_use", entry });
        }
        if (event.type === "tool_result") {
          const entry = {
            id: event.toolUseId ? `tr-${event.toolUseId}` : crypto.randomUUID(),
            type: "tool_result" as const,
            content: event.content || "",
            timestamp: new Date().toISOString(),
            toolUseId: event.toolUseId,
            ...(event.images && event.images.length > 0
              ? { images: event.images }
              : {}),
            ...(event.videos && event.videos.length > 0
              ? { videos: event.videos }
              : {}),
            ...(event.featuredMedia && event.featuredMedia.length > 0
              ? { featuredMedia: event.featuredMedia }
              : {}),
          };
          io.emit({ type: "stream_tool_result", entry });
        }
        if (event.type === "usage_snapshot" && event.usage) {
          // Live mid-run cost/context. Snapshots are run-cumulative and
          // this is the session's only run, so the fold base is empty —
          // each snapshot recomputes the total from scratch (folding
          // onto latestUsage would double-count).
          latestUsage = foldSessionUsage(
            undefined,
            event.usage,
            effectiveModel,
          );
          io.emit({ type: "usage_update", usage: latestUsage });
        }
        if (event.type === "done") {
          engineSessionId = event.sessionId || engineSessionId;
          if (event.provider) effectiveProvider = event.provider;
          if (event.model) effectiveModel = event.model;
          if (event.usageLimitExhausted)
            runFailure = event.result || "Usage limit reached on every account";
          if (event.usage) {
            latestUsage = foldSessionUsage(
              undefined,
              event.usage,
              event.model || effectiveModel,
            );
            // emit (not a bare broadcast) so it also reaches the
            // creator's socket in the window before they watch.
            io.emit({ type: "usage_update", usage: latestUsage });
          }
          if (event.cacheMissWarning)
            io.emit({ type: "cache_warning", sessionId: bksId });
        }
        if (event.type === "error") {
          runFailure = event.content || "Run failed";
          if (event.noticePersisted) failureNoticePersisted = true;
          io.emit({ type: "error", message: event.content });
        }
        if (event.type === "done" || event.type === "error")
          await settlePhysicalCompletion();
      }
      if (!creationSettled) {
        for (const record of activeRunRecords()) {
          if (
            record.osSessionId === bksId &&
            record.promptEntryId === openingPromptEntryId &&
            !record.terminalFailure
          )
            await journalRecordAbnormalCompletion(record);
        }
        throw new Error("Opening run ended without a terminal event");
      }
    } finally {
      // Terminal-event handling settles the actor before backend generators may
      // retire their physical-owner journal. This finally only releases the
      // in-process admission marker.
      unmarkSessionStarting(bksId, startToken);
      releaseOpeningTurn?.();
      releaseOpeningTurn = undefined;
      // Safety net for throws before the worktree block's own finally
      // (persist/announce failures) — must never leak a session stuck
      // in "Waiting for workspace".
      preparingWorkspaces.delete(bksId);
    }

    io.emit({ type: "stream_done" });
    io.emit({ type: "session_status", isRunning: false });
    if (spec.finish === "auto-continue-guard") {
      // An opening turn announce-then-stops exactly like a later one, and
      // this path bypasses runSessionPromptInner — so run the shared guard
      // here too. Nothing wraps this run in runSessionPromptAndDrain, so a
      // queued nudge needs the drain watcher to deliver it.
      if (
        await maybeQueueAutoContinue({
          sessionId: bksId,
          assistantText,
          toolUseCount,
          endedWithError: !!runFailure,
          runFailure,
        })
      ) {
        watchExternalRunAndDrain(bksId);
      }
      if (!promptQueues.get(bksId)?.length) {
        onHumanAsksSessionIdle(bksId);
      }
    } else {
      if (promptQueues.get(bksId)?.length) await drainQueue(bksId);
      else onHumanAsksSessionIdle(bksId);
    }
  } catch (e: any) {
    releasePendingOpening(bksId);
    if (creationSettled) {
      console.error(`[create] Post-opening follow-up failed for ${bksId}:`, e);
      return;
    }
    if (await openingTurnWasCancelled()) {
      await settleCreationCancelled(
        bksId,
        creationIdentity,
        undefined,
        creationEffectId,
      );
      await acknowledgePromptDispatch(bksId, openingPromptEntryId);
      if (announced) {
        io.emit({ type: "stream_done" });
        io.emit({ type: "session_status", isRunning: false });
      }
      return;
    }
    // Failure after the early announce: the client is already in the
    // session — close out the stream and surface the failure there
    // instead of leaving the viewer spinning. Before the announce there's
    // no session to scope to, so the raw error goes back to the caller.
    if (announced) {
      if (spec.runnerTarget) {
        await touchNativeSession(bksId, {
          runner: {
            id: spec.runnerTarget.id,
            name: spec.runnerTarget.name,
            workspacePath: spec.runnerTarget.workspacePath,
            lifecycle: "needs_attention",
            lastLifecycleError: String(e.message || e).slice(0, 200),
          },
        });
      }
      await reportSetupFailure(bksId, io, e.message || String(e));
    } else {
      io.fail(e.message || String(e));
    }
    await settleCreationFailed(
      bksId,
      creationIdentity,
      e,
      undefined,
      creationEffectId,
    );
    await acknowledgePromptDispatch(bksId, openingPromptEntryId);
    for (const record of activeRunRecords()) {
      if (
        record.osSessionId === bksId &&
        record.promptEntryId === openingPromptEntryId &&
        record.terminalFailure
      )
        journalClearIfLineage(record);
    }
  }
}

type WebCreateSocket = ServerWebSocket<WSClientData>;
interface PendingWebCreate {
  sockets: Set<WebCreateSocket>;
  /** Sockets that joined by replaying an already-admitted create command. */
  replayedSockets?: Set<WebCreateSocket>;
}

const pendingWebCreates: Map<string, PendingWebCreate> = ((
  globalThis as any
).__pendingWebCreates ??= new Map());

function sendCreateFrame(
  attempt: PendingWebCreate,
  frame: Record<string, unknown>,
): void {
  for (const socket of attempt.sockets) {
    try {
      const payload = attempt.replayedSockets?.has(socket)
        ? markReplayedCommandResult(frame)
        : frame;
      socket.send(JSON.stringify(payload));
    } catch {}
  }
}

/**
 * Create a session from a UI WebSocket `create_session` message and drive its
 * opening run, streaming events back to the creating socket / session room.
 * A clientSessionId claims one in-flight operation, so reconnect replay either
 * joins that operation or returns the session it already persisted.
 */
export async function handleCreateSessionMessage(
  ws: ServerWebSocket<WSClientData>,
  msg: CreateSessionMessage,
): Promise<Record<string, unknown> | undefined> {
  const rawClientSessionId = msg.clientSessionId;
  if (
    rawClientSessionId !== undefined &&
    !isClientSessionId(rawClientSessionId)
  ) {
    sendCreateFrame(
      { sockets: new Set([ws]) },
      {
        type: "error",
        ...(typeof rawClientSessionId === "string"
          ? { sessionId: rawClientSessionId }
          : {}),
        message: "Invalid session create id",
      },
    );
    return;
  }
  const clientSessionId = rawClientSessionId as string | undefined;
  if (clientSessionId) {
    const pending = pendingWebCreates.get(clientSessionId);
    if (pending) {
      pending.sockets.add(ws);
      (pending.replayedSockets ??= new Set()).add(ws);
      return;
    }
  }
  const attempt: PendingWebCreate = { sockets: new Set([ws]) };
  if (clientSessionId) pendingWebCreates.set(clientSessionId, attempt);
  const finishCreate = () => {
    if (clientSessionId && pendingWebCreates.get(clientSessionId) === attempt)
      pendingWebCreates.delete(clientSessionId);
  };
  const failCreate = (message: string) => {
    sendCreateFrame(attempt, {
      type: "error",
      ...(clientSessionId ? { sessionId: clientSessionId } : {}),
      message,
    });
    finishCreate();
  };

  const { prompt, user, mode } = msg;
  const titlePrompt =
    typeof msg.titlePrompt === "string"
      ? msg.titlePrompt.slice(0, 2000)
      : prompt;
  const requestId =
    typeof msg.requestId === "string" && msg.requestId
      ? msg.requestId
      : undefined;
  const bksId =
    clientSessionId ||
    (requestId
      ? sessionIdForRequest(
          ws.data?.authLogin || user || "anonymous",
          requestId,
        )
      : newSessionId());
  const createIdentity = requestId || clientSessionId || bksId;
  const durableCreation = await sessionKernel(bksId).creationState();
  if (durableCreation && durableCreation.identity !== createIdentity) {
    failCreate("Create request identity crossed durable session ownership");
    return;
  }
  let recoveringSession = findSession(bksId);
  if (
    durableCreation?.state === "opening_dispatched" ||
    durableCreation?.state === "ready" ||
    durableCreation?.state === "failed" ||
    durableCreation?.state === "cancelled"
  ) {
    try {
      recoveringSession = await waitForCreatedSessionProjection(
        bksId,
        createIdentity,
      );
    } catch (error) {
      failCreate(error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (
      durableCreation.state === "ready" ||
      durableCreation.state === "cancelled"
    )
      clearCreatePlan(bksId);
    const response = replayedSessionCreatedResult(
      bksId,
      recoveringSession.workspaceId,
    );
    sendCreateFrame(attempt, response);
    finishCreate();
    return response;
  }
  if (
    recoveringSession?.claudeSessionId ||
    recoveringSession?.codexThreadId ||
    recoveringSession?.piSessionId
  ) {
    clearCreatePlan(bksId);
    const response = replayedSessionCreatedResult(
      recoveringSession.id,
      recoveringSession.workspaceId,
    );
    sendCreateFrame(attempt, response);
    finishCreate();
    return response;
  }
  let createPlan = await actorCreationSetupPlan(bksId, createIdentity);
  // This WebSocket create is interactive. The raw credential reaches only the
  // server-owned materializer; recovery persists and resolves its principal.
  const githubCredential = ws.data.authLogin
    ? githubCredentialForLogin(ws.data.authLogin)
    : ws.data.authAutomation
      ? null
      : soleGithubAccount();
  const githubGitEnv = githubCredential?.env;
  // Mutable: a brand-new code branch is made collision-free below (a
  // name clashing with an existing `name/...` ref — or vice versa —
  // makes `git worktree add -b` fail, killing the session).
  let branch = recoveringSession?.branch || createPlan.branch || msg.branch;
  const images = parseImageDataUrls(msg.images);
  // Session opened from a PR row (sidebar): `branch` is the PR's
  // EXISTING head branch — check it out instead of creating a new
  // branch off origin/default.
  const fromPr = msg.fromPr === true && typeof branch === "string" && !!branch;

  // Fork: branch a new session off an existing one. Claude can clone the
  // real engine conversation via SDK forkSession; backends without clone
  // support get a transcript handoff in the opening prompt instead.
  const forkFrom = msg.forkFrom as
    | { sourceId?: string; messageId?: string }
    | undefined;
  let fork: ForkContext | undefined;
  try {
    fork = resolveForkContext(forkFrom);
  } catch {
    failCreate("Fork source session not found");
    return;
  }
  const forkSource = fork?.source;
  const canFork = !!fork?.canFork;
  const needsForkHandoff = !!fork?.needsHandoff;

  // Scratch: repo-less sessions for feed-item workspaces (videos —
  // the feeds design). Full write + bash in a per-workspace scratch
  // dir, MCP tools as usual; no repo, branch, or PR flow.
  const isScratch = forkSource
    ? forkSource.mode === "scratch"
    : mode === "scratch";
  const isAsk = forkSource
    ? !isScratch && forkSource.mode !== "code"
    : mode === "ask";
  // Repo-less: no repo to read, no branch, no PR flow. Scratch always is.
  // Ask is when the palette's repo picker is set to "No repo" — a session
  // that is a conversation with the model and its MCP tools. A fork stays
  // whatever its source was; an OMITTED repo still means "inherit, else the
  // default", which is what agent-created subagents depend on.
  const requestedRepo = typeof msg.repo === "string" ? msg.repo : undefined;
  // "auto" was a retired picker sentinel, never a repository id. Fail closed
  // for stale clients instead of silently creating in the instance default.
  if (!forkSource && requestedRepo === "auto") {
    failCreate("Choose a repository before creating the session");
    return;
  }
  const isRepoLess = forkSource
    ? isScratch || (forkSource.mode === "ask" && !forkSource.repo)
    : isScratch || (isAsk && requestedRepo === NO_REPO);
  // Optional model pick from the UI; invalid input falls back to default.
  // A fork inherits the source's model. No pick = stamp the interactive
  // default NOW: leaving it empty would let the init event persist the
  // engine's resolved model — which for a dial default would silently
  // disengage the dial (the preset id must be what the session stores).
  const workspacePreset = forkSource
    ? undefined
    : resolveWorkspaceModelPreset(
        msg.model,
        msg.workspaceId ?? msg.modelWorkspaceId,
      );
  const model = forkSource
    ? forkSource.model
    : workspacePreset?.id ||
      (msg.model ? resolveModel(String(msg.model))?.id : undefined) ||
      configuredInteractiveDefaultModel();
  // Reasoning effort from the New-session palette (forks inherit).
  const createEffort = forkSource
    ? forkSource.effort
    : workspacePreset?.effort ||
      (typeof msg.effort === "string" &&
      SESSION_EFFORTS.has(msg.effort.trim().toLowerCase())
        ? msg.effort.trim().toLowerCase()
        : undefined);
  const createFastMode = forkSource
    ? forkSource.fastMode
    : msg.fastMode === true;
  // Pinned provider account from the palette (forks inherit).
  const createAccountId = forkSource
    ? forkSource.accountId
    : resolvePinnedAccountId(
        workspacePreset?.model || model,
        msg.accountId,
        user,
      );
  const createMcpServers = Array.isArray(msg.mcpServers)
    ? msg.mcpServers.map(String)
    : undefined;
  // Which repo this session works in (the instance default). A repo-less
  // session still resolves one here — sandbox selection and memory scopes
  // are repo-keyed — but never records it (see `repoId` on the spec below).
  const repo = getRepo(
    requestedRepo && requestedRepo !== NO_REPO ? requestedRepo : undefined,
  );
  // Sandbox opt-in (the sandbox rollout plan): boolean true = the
  // config's default provider (legacy toggle behavior); a string
  // names an explicit provider (including "modal" / "lambda-microvm"),
  // validated against the current config. Forks never sandbox —
  // they share/fork the source session's engine state and cwd.
  const sandboxResolved = forkSource
    ? resolveRequestedSandbox(undefined, repo.id, model)
    : resolveInteractiveSandbox(
        msg.sandbox as boolean | string | undefined,
        user,
        repo.id,
        model,
      );
  if (!sandboxResolved.ok) {
    failCreate(sandboxResolved.error);

    return;
  }
  // null = host (no sandbox recorded on the session).
  const createSandboxProvider = sandboxResolved.provider;
  const requestedRunnerId =
    typeof msg.runner === "string" && msg.runner.trim()
      ? msg.runner.trim()
      : undefined;
  if (requestedRunnerId) {
    failCreate(
      "Runner full sessions are not available. Use Runner command delegation from a standard session.",
    );
    return;
  }
  if (requestedRunnerId && createSandboxProvider) {
    failCreate("Choose either Sandbox or a Runner for this session.");

    return;
  }
  const selectedRunner = requestedRunnerId
    ? getRunner(requestedRunnerId)
    : undefined;
  if (requestedRunnerId) {
    if (!selectedRunner || !isRunnerConnected(selectedRunner.id)) {
      failCreate("That Runner is offline.");
      return;
    }
    if (
      !runnerAvailableForSession(selectedRunner, {
        user,
        repo: repo.id,
        sessionId: "new",
      }) ||
      !selectedRunner.workspaceRoots.length
    ) {
      failCreate("That Runner is not available for this repository.");
      return;
    }
    if (forkSource || fromPr || isScratch || isAsk) {
      failCreate("Runner sessions require a new code workspace.");

      return;
    }
  }
  // Remote providers have no host mounts — always volume-style.
  const remoteSandbox = isRemoteSandboxProvider(createSandboxProvider);
  // Workspace linkage. The New modal creates a Workspace + first Session
  // together (createWorkspace); the tab/sidebar + adds a Session to an
  // existing workspace (workspaceId) that either shares the workspace's
  // worktree (default) or stacks a new one branched off it.
  const worktreeMode: "share" | "stack" | "ask" = isAsk
    ? "ask"
    : msg.worktreeMode === "stack"
      ? "stack"
      : "share";
  // A personal choice overrides only the repository's default for a fresh code
  // workspace. PR starts, forks and existing workspace worktrees keep their
  // explicit destination in the branches below.
  const usesSharedCheckout = sharedCheckoutForSessionCreate(
    repo,
    msg.checkoutMode,
  );
  const isolatesConfiguredSharedCheckout =
    !usesSharedCheckout &&
    !!repo.sharedCheckout &&
    msg.checkoutMode === "worktree";
  let workspace = recoveringSession?.workspaceId
    ? getWorkspace(recoveringSession.workspaceId)
    : typeof msg.workspaceId === "string" && msg.workspaceId
      ? getWorkspace(msg.workspaceId)
      : null;
  // A ticket-linked create always lands in the ticket's ONE workspace
  // (adopt-don't-duplicate, workspace-resolve.ts) — even when the
  // client asked for a fresh workspace, a second workspace for the
  // same ticket is never right. A createWorkspace name doubles as
  // the ticket-title hint for a first-time resolve.
  const msgPlainThreadId =
    typeof msg.plainThreadId === "string" && msg.plainThreadId
      ? msg.plainThreadId
      : undefined;
  if (msgPlainThreadId && !workspace) {
    try {
      workspace = resolvePlainWorkspace({
        threadId: msgPlainThreadId,
        title:
          typeof msg.createWorkspace?.name === "string"
            ? msg.createWorkspace.name
            : undefined,
        createdBy: user || "Anonymous",
      }).workspace;
    } catch {}
  }
  // Whether this create made a brand-new workspace (vs. adding a session
  // to an existing one) — echoed on session_created so the client can
  // word its brief pending state accordingly.
  let createdWorkspaceNow = false;
  if (!workspace && msg.createWorkspace) {
    const plannedWorkspaceId =
      createPlan.workspaceId || createPlanWorkspaceId(bksId);
    if (!createPlan.workspaceId)
      createPlan = await patchCreationSetupPlan(bksId, createIdentity, {
        workspaceId: plannedWorkspaceId,
      });
    // A code create landing on a branch whose worktree an existing
    // workspace already owns joins that workspace (the worktree
    // lookup below would silently reuse the worktree anyway —
    // re-submitted prompt slugs and existing branches picked in the
    // unscoped palette both hit this). Only then mint a fresh one.
    if (!isAsk && !forkSource && !fromPr && !usesSharedCheckout && branch) {
      const existingWt = (await listWorktrees(repo.id)).find(
        (w) => w.branch === branch,
      )?.path;
      workspace = workspaceOwningWorktree(existingWt);
    }
    if (!workspace) {
      createdWorkspaceNow = true;
      await requestCreationWorkspace({
        sessionId: bksId,
        identity: createIdentity,
        workspaceId: plannedWorkspaceId,
        dedupeKey: `session-create:${createIdentity}`,
        name:
          (typeof msg.createWorkspace.name === "string" &&
            msg.createWorkspace.name) ||
          titlePrompt.trim().split("\n")[0].slice(0, 80) ||
          "Workspace",
        ...(isRepoLess ? {} : { project: repo.id }),
        createdBy: user || "Anonymous",
      });
      workspace = getWorkspace(plannedWorkspaceId);
      if (!workspace)
        throw new Error(
          `Workspace ${plannedWorkspaceId} projection is missing after actor receipt`,
        );
    }
  }
  // Set once the session has been announced to the client (early
  // session_created) — a later failure must then close out the
  // stream instead of leaving the just-opened viewer spinning.
  let announcedId: string | null = null;
  let createResponse: Record<string, unknown> | undefined;

  // One outlet for this run's stream events (usable only after the
  // announce sets announcedId). Everything is stamped with sessionId
  // so clients can filter, and the creator's direct send is GATED on
  // what their socket currently watches: it only covers the gap
  // between session_created and their watch landing. Once they watch
  // this session, the room broadcast reaches them; once they've
  // navigated to a DIFFERENT session, they get nothing — the old
  // unconditional ws.send kept streaming this run into whatever session
  // that socket had open (until a refresh replaced the socket).
  const emit = (m: Record<string, unknown>) => {
    if (!announcedId) return;
    const scoped = { ...m, sessionId: announcedId };
    const watching = ws.data?.watchingSessionId;
    if (!watching) {
      try {
        ws.send(JSON.stringify(scoped));
      } catch {}
    }
    broadcastToSession(announcedId, scoped, watching ? undefined : ws);
  };
  let spec: ResolvedCreate;
  try {
    let wtPath: string;
    // Deferred worktree setup: the git fetch + worktree add +
    // bun install can take tens of seconds, so the session is
    // announced on the deterministic path first and the worktree
    // is created after session_created goes out (in
    // openCreatedSession).
    let needsWorktree = false;
    // Volume-mode sandbox workspace (Phase 2): no host worktree at
    // all - the sandbox provider clones it in-container on the
    // opening run below.
    let volumeWorkspace = false;
    if (recoveringSession) {
      wtPath = recoveringSession.worktreeDir || repo.repo;
      needsWorktree =
        !createSandboxProvider &&
        !selectedRunner &&
        !isAsk &&
        !isScratch &&
        !existsSync(wtPath);
    } else if (selectedRunner) {
      if (!branch)
        branch =
          sanitizeBranchSlug(prompt.trim().split("\n")[0]) ||
          `session-${Date.now().toString(36)}`;
      wtPath = runnerWorkspacePath(selectedRunner, bksId);
    } else if (forkSource) {
      // Share the source's cwd so the fork sees the same code state.
      wtPath = forkSource.worktreeDir || repo.repo;
    } else if (fromPr) {
      // From a PR row: work on the PR's existing head branch in an
      // isolated worktree (even for shared-checkout repos and ask
      // mode — the PR's code is the subject, and a PR branch must
      // never check out in the live main checkout). Reuses a
      // worktree already on that branch.
      const worktrees = await listWorktrees(repo.id);
      wtPath = worktrees.find((w) => w.branch === branch)?.path || "";
      if (!wtPath) {
        wtPath = worktreePathFor(branch, repo.id, { isolated: true });
        needsWorktree = true;
      }
    } else if (isRepoLess) {
      // Repo-less sessions run in a plain per-workspace scratch dir —
      // never a repo checkout. Scratch writes there (shared by the
      // workspace's sessions so downloads persist across them); a
      // repo-less ask session only needs somewhere for bash to stand,
      // and carries no tool that can write to it.
      wtPath = ensureScratchDir(workspace?.id || createPlanWorkspaceId(bksId));
    } else if (isAsk) {
      // Ask sessions read the repo's pinned ask checkout (default
      // branch, detached) — never the mutable main checkout, whose
      // parked branch is a false context clue. Instant once the
      // checkout exists; only the first-ever create pays a worktree
      // add (ensureAskCheckout).
      wtPath = await ensureAskCheckout(repo.id);
    } else if (usesSharedCheckout && !workspace?.worktreeDir) {
      // This repository's default, or the person's override, points a fresh
      // code workspace at the live main checkout. An existing workspace's
      // owned worktree remains the more specific destination.
      wtPath = repo.repo;
    } else if (workspace?.worktreeDir && worktreeMode === "share") {
      // Share the workspace's owned worktree (parallel sessions, one branch).
      wtPath = workspace.worktreeDir;
    } else {
      // selfDev:"worktree" only: the client may omit a branch for a
      // repo it still believes is shared-checkout — derive one so the
      // worktree path never degenerates to `<wtPrefix>-`. Scoped to
      // sharedCheckout repos so every other repo's path is untouched.
      if (!branch && repo.sharedCheckout)
        branch =
          sanitizeBranchSlug(prompt.trim().split("\n")[0]) ||
          `session-${Date.now().toString(36)}`;
      // New/stacked worktree. Stack branches off the workspace's branch
      // so stacked PRs line up; otherwise branch off origin/default.
      const worktrees = await listWorktrees(repo.id);
      wtPath = worktrees.find((w) => w.branch === branch)?.path || "";
      if (!wtPath) {
        // A genuinely new branch: dodge ref-hierarchy collisions
        // (e.g. requested `test` while `test/foo` already exists)
        // before we bake the name into the path + session file.
        if (branch) branch = await resolveUniqueBranch(branch, repo.id);
        wtPath = worktreePathFor(branch, repo.id, {
          isolated: isolatesConfiguredSharedCheckout,
        });
        // Volume-mode sandbox (docs/self-hosting-sandboxes.md): the
        // workspace is cloned into a per-session volume INSIDE the
        // sandbox — skip host createWorktree entirely. The session
        // keeps the canonical path; the provider's ensure()
        // materializes it on the opening run below. Docker only in
        // volume config; remote providers (daytona/e2b) always.
        if (
          createSandboxProvider &&
          sandboxesEnabled() &&
          (remoteSandbox ||
            (createSandboxProvider === "docker" &&
              sandboxConfig().workspace === "volume"))
        ) {
          volumeWorkspace = true;
        } else {
          needsWorktree = true;
        }
      }
    }
    // The layer this session stacks on, captured BEFORE the adoption
    // block below can rewrite workspace.branch to this session's own
    // branch — reading it afterwards would make a stacked session try
    // to base on itself.
    const stackBase =
      worktreeMode === "stack" && !isAsk && !isScratch
        ? workspace?.branch || undefined
        : undefined;
    // First code session materializes the workspace's owned worktree so
    // later share-mode sessions inherit it. Stacked sessions keep their own —
    // except a "stack" in a workspace with no branch yet, which has no
    // base to stack on and is really the workspace's first worktree.
    // fromPr is exempt from the shared-checkout exclusion: PR-branch
    // worktrees are isolated even for shared-checkout repos, so a PR
    // workspace on e.g. opensession still materializes.
    if (
      workspace &&
      !workspace.worktreeDir &&
      !isAsk &&
      !isScratch &&
      (!usesSharedCheckout || fromPr) &&
      (worktreeMode !== "stack" || !workspace.branch)
    ) {
      updateWorkspace(workspace.id, {
        worktreeDir: wtPath,
        ...(branch ? { branch } : {}),
      });
      workspace = { ...workspace, worktreeDir: wtPath, branch };
    }
    // The branch this session actually works on (also persisted below).
    const sessionBranch = forkSource
      ? forkSource.branch || ""
      : fromPr
        ? branch
        : isAsk || isScratch
          ? ""
          : selectedRunner
            ? branch
            : usesSharedCheckout && wtPath === repo.repo
              ? repo.defaultBranch
              : workspace?.worktreeDir === wtPath
                ? workspace.branch || branch
                : branch;

    // Repos to work in beside this one (the palette's ⌘-click). Each gets an
    // isolated worktree on the session's own branch, so the branches — and
    // the PRs that follow them — line up across repos. A session whose repo
    // is a shared checkout works on that repo's mainline, which is no name
    // to give another repo, so the create's requested branch stands in.
    const attachBranch =
      sessionBranch && sessionBranch !== repo.defaultBranch
        ? sessionBranch
        : (branch || "").trim();
    const unsupportedAttach =
      isAsk || isScratch || isRepoLess
        ? "Only a Code session with a repo can work in more than one repo."
        : forkSource || fromPr
          ? "A session started from a fork or a pull request works in the repo it came from."
          : selectedRunner
            ? "Runner sessions work in one repo."
            : volumeWorkspace || remoteSandbox
              ? "This sandbox keeps the workspace inside the container, which can't hold a second repo yet. Choose This machine, or a sandbox that mounts the worktree."
              : "";
    const askedForRepos =
      Array.isArray(msg.attachRepos) && msg.attachRepos.length;
    if (askedForRepos && unsupportedAttach) throw new Error(unsupportedAttach);
    const attachRepoIds = planCreateAttachRepos(
      askedForRepos ? msg.attachRepos : [],
      repo.id,
      attachBranch,
    );

    const title = (await nameKnownSessionReferencesForTitle(titlePrompt))
      .trim()
      .split("\n")[0]
      .slice(0, 80);
    // Every session lives in a workspace (session-workspace.ts). A create
    // that resolved none — no picker choice, no fork parent, no
    // explicit id — mints its own here rather than surfacing as an
    // orphan the read-side sweep has to adopt a moment later: only a
    // workspace minted on this path can be auto-named from the
    // generated title below.
    let mintedForSession = false;
    if (
      !workspace &&
      !forkSource?.workspaceId &&
      !(typeof msg.workspaceId === "string" && msg.workspaceId)
    ) {
      const plannedWorkspaceId =
        createPlan.workspaceId || createPlanWorkspaceId(bksId);
      if (!createPlan.workspaceId)
        createPlan = await patchCreationSetupPlan(bksId, createIdentity, {
          workspaceId: plannedWorkspaceId,
        });
      await requestCreationWorkspace({
        sessionId: bksId,
        identity: createIdentity,
        workspaceId: plannedWorkspaceId,
        dedupeKey: `session-create:${createIdentity}`,
        name: title || "Workspace",
        ...(isRepoLess ? {} : { project: repo.id }),
        createdBy: user || "Anonymous",
        ...(sessionBranch ? { branch: sessionBranch } : {}),
        // Only an isolated worktree is owned. A shared main or ask
        // checkout is used by every other session there too.
        ...(ownedWorktree(wtPath) ? { worktreeDir: wtPath } : {}),
      });
      workspace = getWorkspace(plannedWorkspaceId);
      if (!workspace)
        throw new Error(
          `Workspace ${plannedWorkspaceId} projection is missing after actor receipt`,
        );
      mintedForSession = true;
    }
    // An auto-created workspace is renamed ONCE from the generated
    // summary (see openCreatedSession) — it provisionally wears the raw
    // first line. Only a workspace minted by THIS create gets auto-named;
    // an adopted pre-existing workspace keeps its own name. Same one-shot
    // deal for a workspace whose first session just consumed a draft that
    // still wears the draft's first-line name (autoName not demoted to
    // false). The generated title upgrades that first line the same way.
    const wsAutoNamed =
      mintedForSession ||
      (createdWorkspaceNow &&
        !!workspace &&
        !!msg.createWorkspace &&
        !msg.createWorkspace.name) ||
      (!mintedForSession &&
        !!workspace?.draft &&
        workspace.draft.autoName !== false);
    // Non-image attachment bodies are reduced to durable source refs at
    // intake; only the actor can materialize their session-owned paths.
    const attachmentSources =
      createPlan.attachments ??
      prepareCreationAttachmentSources(bksId, msg.files);
    if (!createPlan.attachments && attachmentSources.length)
      createPlan = await patchCreationSetupPlan(bksId, createIdentity, {
        attachments: attachmentSources,
      });
    for (const attachment of attachmentSources)
      await requestCreationAttachment({
        sessionId: bksId,
        identity: createIdentity,
        ...attachment,
      });
    // Pasted blocks follow the message; the uploads note follows them, so the
    // parser's end-anchored note regex still finds it.
    let openingPrompt = withUploadsNote(
      withPastedTexts(prompt, pastedTextsFromWire(msg.pastedTexts)),
      attachmentSources.map((attachment) => ({
        name: attachment.name,
        path: creationAttachmentPath(
          bksId,
          attachment.attachmentId,
          attachment.name,
        ),
      })),
    );
    // @session:<id> mentions from the New-session box get the same
    // resolving footer as prompts on existing sessions (see
    // runSessionPromptInner) — this create path bypasses it.
    {
      const mentionsNote = sessionMentionsNote(openingPrompt);
      if (mentionsNote) openingPrompt += `\n\n${mentionsNote}`;
    }
    // Session opened from the Support view: link it to its Plain
    // thread (conversation tab + the sidebar's ticket→session
    // mapping) and hand the agent the ticket conversation so the
    // first message is self-contained. A session created inside a
    // ticket workspace (tab-strip "+") inherits the thread too.
    // A session created inside a feed-item workspace (PostHog dashboard, …)
    // inherits the workspace's externalRefs — that's what keeps the
    // Video tab on its sessions and joins the sidebar feed row to the
    // session — and gets the item named in its opening context.
    const inheritedRefs = workspace?.externalRefs;
    // Least privilege for feed-workspace sessions: unless the creator
    // explicitly picked servers, the session's MCP allowlist is the
    // feed's declared list (e.g. posthog → ["posthog"]) — never the full
    // mcp-config (a feed session must not see Plain/Stripe/WorkOS).
    const feedMcpServers =
      !createMcpServers?.length && inheritedRefs?.length
        ? await (await import("./feeds")).feedMcpServersForRefs(inheritedRefs)
        : undefined;
    if (inheritedRefs?.length) {
      const refsContext = await (
        await import("./feeds")
      ).externalRefsOpeningContext(inheritedRefs, {
        scratch: isScratch,
        // The creator's MCP grant fetches the object context
        // (e.g. a linked video via their account).
        user,
      });
      if (refsContext)
        openingPrompt += `\n\n${wrapContext(refsContext, "external-refs")}`;
    }
    const plainThreadId = msgPlainThreadId || workspace?.plainThreadId;
    if (plainThreadId) {
      try {
        const { getThreadWithMessages, formatThreadContext } =
          await import("../agents/plain/api");
        const thread = await getThreadWithMessages(plainThreadId);
        openingPrompt += `\n\n${wrapContext(
          `This session was opened from a Plain support ticket. Ticket context:\n\n${formatThreadContext(thread, true)}`,
          "ticket",
        )}`;
      } catch (e) {
        console.error(
          `[create_session] Plain thread lookup failed for ${plainThreadId}:`,
          e,
        );
        openingPrompt += `\n\n${wrapContext(
          `This session was opened from Plain support ticket ${plainThreadId} (the context lookup failed — use the plain MCP tools to fetch the thread).`,
          "ticket",
        )}`;
      }
    }
    if (needsForkHandoff && fork) {
      openingPrompt += `\n\n${await forkHandoffContext(fork)}`;
    }

    if (branch && branch !== createPlan.branch)
      createPlan = await patchCreationSetupPlan(bksId, createIdentity, {
        branch,
      });
    const computedSpec: ResolvedCreate = {
      id: bksId,
      title,
      titlePrompt,
      displayPrompt: prompt,
      openingPrompt,
      user,
      createdBy: user || "Anonymous",
      createdAt: new Date().toISOString(),
      createdByLogin: ws.data?.authLogin || undefined,
      mode: isScratch
        ? ("scratch" as const)
        : isAsk
          ? ("ask" as const)
          : ("code" as const),
      wtPath,
      persistBranch: sessionBranch,
      branch: sessionBranch,
      // Repo-less sessions record no repo: wtPath is a plain scratch dir
      // no registered repo owns.
      repoId: isRepoLess
        ? undefined
        : selectedRunner
          ? repo.id
          : repoForPathOrNull(wtPath)?.id,
      memoryRepoIds: [repo.id],
      ...(attachRepoIds.length
        ? { attachRepos: { repos: attachRepoIds, branch: attachBranch } }
        : {}),
      stackedOn: stackBase
        ? { repo: repoForPath(wtPath).id, branch: stackBase }
        : undefined,
      workspaceId: workspace
        ? workspace.id
        : forkSource?.workspaceId
          ? // A fork lands next to its source in the same workspace.
            forkSource.workspaceId
          : typeof msg.workspaceId === "string" && msg.workspaceId
            ? msg.workspaceId
            : undefined,
      announceWorkspaceId: workspace?.id,
      createdWorkspaceNow,
      autoNameWorkspace: wsAutoNamed ? workspace : null,
      model,
      effort: createEffort,
      presetNote: workspacePreset?.note,
      fastMode: createFastMode,
      accountId: createAccountId,
      images,
      externalRefs: inheritedRefs,
      plainThreadId,
      persistMcpServers: createMcpServers?.length
        ? createMcpServers
        : feedMcpServers?.length
          ? feedMcpServers
          : undefined,
      // May be undefined at runtime (historic behavior — reads as "all"
      // downstream); see ResolvedCreate.runMcpServers.
      runMcpServers: (createMcpServers?.length
        ? createMcpServers
        : feedMcpServers) as McpScope | undefined,
      sandboxProvider: createSandboxProvider,
      runnerTarget: selectedRunner
        ? {
            id: selectedRunner.id,
            name: selectedRunner.label || selectedRunner.name,
            workspacePath: wtPath,
            repositoryUrl: `https://github.com/${repo.ghRepo}.git`,
          }
        : undefined,
      volumeWorkspace,
      remoteSandbox,
      openingPromptEntryId: `create-${requestId || bksId}`,
      gitPrincipal: githubCredential?.principal,
      gitEnv: githubGitEnv,
      needsWorktree,
      worktreeKind: fromPr ? "existing" : "new",
      worktreeIsolated: isolatesConfiguredSharedCheckout,
      materializeWorktree: needsWorktree
        ? actorWorktreeMaterializer({
            sessionId: bksId,
            identity: createIdentity,
            project: repo.id,
            branch,
            worktreePath: wtPath,
            baseBranch: stackBase,
            isolated: isolatesConfiguredSharedCheckout,
            existingBranch: fromPr,
            credentialPrincipal: githubCredential?.principal,
          })
        : undefined,
      fork: canFork
        ? {
            engineSessionId: forkSource!.claudeSessionId!,
            resumeAt: forkFrom?.messageId,
          }
        : undefined,
      finish: "drain",
    };
    const restoredSpec = createPlan.resolved
      ? restoreResolvedCreate<ResolvedCreate>(createPlan.resolved)
      : undefined;
    const restoredGitEnv = githubCredentialForPrincipal(
      restoredSpec?.gitPrincipal,
    )?.env;
    const restoredWorktreeReady =
      restoredSpec?.needsWorktree &&
      typeof restoredSpec.wtPath === "string" &&
      typeof restoredSpec.repoId === "string" &&
      typeof restoredSpec.branch === "string"
        ? await isRegisteredWorktree(
            restoredSpec.wtPath,
            restoredSpec.repoId,
            restoredSpec.branch,
          )
        : false;
    const restoredMaterializer =
      restoredSpec?.needsWorktree &&
      !restoredWorktreeReady &&
      typeof restoredSpec.wtPath === "string" &&
      typeof restoredSpec.branch === "string" &&
      typeof restoredSpec.repoId === "string"
        ? actorWorktreeMaterializer({
            sessionId: bksId,
            identity: createIdentity,
            project: restoredSpec.repoId,
            branch: restoredSpec.branch,
            worktreePath: restoredSpec.wtPath,
            baseBranch: restoredSpec.stackedOn?.branch,
            isolated: restoredSpec.worktreeIsolated === true,
            existingBranch: restoredSpec.worktreeKind === "existing",
            credentialPrincipal: restoredSpec.gitPrincipal,
          })
        : undefined;
    spec = restoredSpec
      ? {
          ...computedSpec,
          ...restoredSpec,
          images: computedSpec.images,
          gitEnv: restoredGitEnv,
          materializeWorktree: restoredMaterializer,
          needsWorktree: !!restoredMaterializer,
        }
      : computedSpec;
    if (!createPlan.resolved) {
      createPlan = await patchCreationSetupPlan(bksId, createIdentity, {
        resolved: snapshotOpeningCreate(computedSpec),
      });
    }
  } catch (e: any) {
    if (isCreationEffectPendingError(e)) {
      // The actor owns this effect durably. Free the in-process join entry and
      // let the WebSocket reconnect replay the same deterministic session id;
      // reporting failure here can race the effect's later success.
      finishCreate();
      throw e;
    }
    // Setup failed before anything was persisted or announced. Every socket
    // that replayed this create receives the same terminal response.
    clearCreatePlan(bksId);
    failCreate(e.message || String(e));
    return;
  }

  let releaseAdmission!: () => void;
  const admitted = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  const opening = runOpeningCreateOnce(
    spec,
    {
      announce: (info) => {
        createResponse = {
          type: "session_created",
          id: info.id,
          ...(info.workspaceId ? { workspaceId: info.workspaceId } : {}),
          ...(info.newWorkspace ? { newWorkspace: true } : {}),
          ...(info.preparingWorkspace ? { preparingWorkspace: true } : {}),
        };
        sendCreateFrame(attempt, createResponse);
        finishCreate();
        announcedId = info.id;
        emit({ type: "stream_start" });
        releaseAdmission();
      },
      emit,
      fail: (message) => {
        failCreate(message);
        releaseAdmission();
      },
    },
    createIdentity,
  );
  if (!opening.owner) {
    createResponse = {
      type: "session_created",
      id: bksId,
      ...(recoveringSession?.workspaceId
        ? { workspaceId: recoveringSession.workspaceId }
        : {}),
    };
    sendCreateFrame(attempt, createResponse);
    finishCreate();
    return createResponse;
  }
  void opening.done
    .then(
      () => clearCreatePlan(bksId),
      (error) =>
        console.error(`[create_session] opening run ${bksId} failed:`, error),
    )
    .finally(releaseAdmission);
  // Command ownership ends once the session and opening dispatch are durable.
  // The target session can now accept Stop or another control while its opening
  // run continues under generation fencing.
  await admitted;
  return createResponse;
}
