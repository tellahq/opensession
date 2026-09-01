import { sessionKernel } from "./kernel";
import type {
  CreationEventDecisionResult,
  DurableCreationState,
} from "./store";

export type CreationWorkspaceIntent = {
  sessionId: string;
  identity: string;
  workspaceId: string;
  dedupeKey: string;
  name: string;
  createdBy: string;
  project?: string;
  branch?: string;
  worktreeDir?: string;
};

export type CreationBranchIntent = {
  sessionId: string;
  identity: string;
  project: string;
  branch: string;
  worktreePath: string;
  baseBranch?: string;
  isolated: boolean;
  existingBranch?: boolean;
  credentialPrincipal?: string;
};

export type CreationCredentialIntent = {
  sessionId: string;
  identity: string;
  principal: string;
  scope: string;
};

export type CreationSandboxIntent = {
  sessionId: string;
  identity: string;
  provider: string;
  repo?: string;
  branch?: string;
  sessionMode?: "ask" | "code" | "scratch";
  cwd?: string;
  base?: string;
  attachedDirs?: string[];
  trustProfile?: "interactive" | "automation";
  egressAllowlist?: string[];
};

export type CreationAttachmentIntent = {
  sessionId: string;
  identity: string;
  attachmentId: string;
  name: string;
  sourceRef: string;
  digest: string;
};

export type CreationSetupPlan = {
  branch?: string;
  workspaceId?: string;
  attachments?: Array<{
    attachmentId: string;
    name: string;
    sourceRef: string;
    digest: string;
  }>;
  resolved?: Record<string, unknown>;
};

export type CreationOpeningIntent = {
  sessionId: string;
  identity: string;
  openingPromptEntryId: string;
  runId: string;
  runGeneration: number;
  /** Serializable recovery input atomically owned with the opening effect. */
  openingPlan: Record<string, unknown>;
};

type CreationIntentKernel = {
  creationState: () =>
    | DurableCreationState
    | undefined
    | Promise<DurableCreationState | undefined>;
  applyCreationEvent: (
    input: Parameters<
      ReturnType<typeof sessionKernel>["applyCreationEvent"]
    >[0],
  ) => CreationEventDecisionResult | Promise<CreationEventDecisionResult>;
};

type CreationIntentOptions = {
  kernel?: CreationIntentKernel;
  timeoutMs?: number;
  pollMs?: number;
};

/** The intent is durable and may still complete. Callers must reconnect/replay
 * rather than reporting a terminal create failure and discarding its shell. */
export class CreationEffectPendingError extends Error {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "CreationEffectPendingError";
  }
}

export function isCreationEffectPendingError(
  error: unknown,
): error is CreationEffectPendingError {
  return error instanceof CreationEffectPendingError;
}

function assertIdentity(state: DurableCreationState, identity: string): void {
  if (state.identity !== identity)
    throw new Error(
      "Create request identity crossed durable session ownership",
    );
  if (state.state === "failed")
    throw new Error("Session creation has already failed");
  if (state.state === "cancelled")
    throw new Error("Session creation has already been cancelled");
}

export async function patchCreationSetupPlan(
  sessionId: string,
  identity: string,
  patch: Partial<CreationSetupPlan>,
  kernel: CreationIntentKernel = sessionKernel(sessionId),
): Promise<CreationSetupPlan> {
  const state = await ensureCreationPlanned(sessionId, identity, kernel);
  const decided = await kernel.applyCreationEvent({
    identity,
    event: "plan",
    planPatch: patch,
  });
  if (!decided.accepted || !decided.state)
    throw new Error(
      `Creation setup plan was rejected: ${decided.reason || "unknown"}`,
    );
  return (decided.state.setupPlan ??
    state.setupPlan ??
    {}) as CreationSetupPlan;
}

export async function ensureCreationPlanned(
  sessionId: string,
  identity: string,
  kernel: CreationIntentKernel = sessionKernel(sessionId),
): Promise<DurableCreationState> {
  const existing = await kernel.creationState();
  if (existing) {
    assertIdentity(existing, identity);
    return existing;
  }
  const planned = await kernel.applyCreationEvent({ identity, event: "plan" });
  if (!planned.accepted || !planned.state)
    throw new Error(
      `Creation plan was rejected: ${planned.reason || "unknown"}`,
    );
  return planned.state;
}

export async function settleCreationSucceeded(
  sessionId: string,
  identity: string,
  kernel: CreationIntentKernel = sessionKernel(sessionId),
  effectId?: string,
): Promise<DurableCreationState> {
  const state = await ensureCreationPlanned(sessionId, identity, kernel);
  if (state.state === "ready") return state;
  assertIdentity(state, identity);
  const settled = await kernel.applyCreationEvent({
    identity,
    event: "succeeded",
    effectId,
  });
  if (!settled.accepted || !settled.state)
    throw new Error(
      `Creation success was rejected: ${settled.reason || "unknown"}`,
    );
  return settled.state;
}

export async function settleCreationCancelled(
  sessionId: string,
  identity: string,
  kernel: CreationIntentKernel = sessionKernel(sessionId),
  effectId?: string,
): Promise<DurableCreationState> {
  const existing = await kernel.creationState();
  if (existing?.identity !== undefined && existing.identity !== identity)
    throw new Error(
      "Create request identity crossed durable session ownership",
    );
  // Terminal states are idempotent, mirroring settleCreationSucceeded/
  // settleCreationFailed: a Stop racing an opening result must not throw —
  // the terminal receipt already owns the lifecycle.
  if (
    existing?.state === "cancelled" ||
    existing?.state === "ready" ||
    existing?.state === "failed"
  )
    return existing;
  await ensureCreationPlanned(sessionId, identity, kernel);
  const settled = await kernel.applyCreationEvent({
    identity,
    event: "cancelled",
    effectId,
    detail: { source: "turn_stop" },
  });
  if (!settled.accepted || !settled.state)
    throw new Error(
      `Creation cancellation was rejected: ${settled.reason || "unknown"}`,
    );
  return settled.state;
}

export async function settleCreationFailed(
  sessionId: string,
  identity: string,
  error: unknown,
  kernel: CreationIntentKernel = sessionKernel(sessionId),
  effectId?: string,
): Promise<DurableCreationState> {
  const existing = await kernel.creationState();
  if (existing?.identity !== undefined && existing.identity !== identity)
    throw new Error(
      "Create request identity crossed durable session ownership",
    );
  if (existing?.state === "failed" || existing?.state === "cancelled")
    return existing;
  await ensureCreationPlanned(sessionId, identity, kernel);
  const settled = await kernel.applyCreationEvent({
    identity,
    event: "failed",
    effectId,
    detail: { error: error instanceof Error ? error.message : String(error) },
  });
  if (!settled.accepted || !settled.state)
    throw new Error(
      `Creation failure was rejected: ${settled.reason || "unknown"}`,
    );
  return settled.state;
}

/** Stage one source-ref attachment through the actor and wait for its receipt. */
export async function requestCreationAttachment(
  input: CreationAttachmentIntent,
  options: CreationIntentOptions = {},
): Promise<DurableCreationState> {
  const kernel = options.kernel ?? sessionKernel(input.sessionId);
  let state = await ensureCreationPlanned(
    input.sessionId,
    input.identity,
    kernel,
  );
  const effectId = `attachment:${input.attachmentId}`;
  if (state.completedEffectIds.includes(effectId)) return state;
  if (state.currentEffectId && state.currentEffectId !== effectId)
    throw new Error(
      `Creation effect ${state.currentEffectId} must settle before ${effectId}`,
    );
  if (!state.currentEffectId) {
    const emitted = await kernel.applyCreationEvent({
      identity: input.identity,
      event: "preparation_started",
      nextEffectId: effectId,
      effect: {
        kind: "creation_attachment_stage",
        effectKey: effectId,
        payload: {
          creationIdentity: input.identity,
          creationGeneration: state.generation,
          attachmentId: input.attachmentId,
          name: input.name,
          sourceRef: input.sourceRef,
          digest: input.digest,
          mode: "reconcile_or_stage",
        },
      },
    });
    if (!emitted.accepted || !emitted.state)
      throw new Error(
        `Creation attachment intent was rejected: ${emitted.reason || "unknown"}`,
      );
    state = emitted.state;
  }
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (!state.completedEffectIds.includes(effectId)) {
    if (Date.now() >= deadline)
      throw new CreationEffectPendingError(
        `Creation attachment effect ${effectId} remains durably pending`,
      );
    await Bun.sleep(options.pollMs ?? 25);
    const current = await kernel.creationState();
    if (!current)
      throw new Error(
        "Creation state disappeared while attachment was pending",
      );
    assertIdentity(current, input.identity);
    state = current;
  }
  return state;
}

/** Emit one stable opening launch and wait for the executor's actor settlement. */
export async function requestCreationOpening(
  input: CreationOpeningIntent,
  options: CreationIntentOptions = {},
): Promise<DurableCreationState> {
  const kernel = options.kernel ?? sessionKernel(input.sessionId);
  let state = await ensureCreationPlanned(
    input.sessionId,
    input.identity,
    kernel,
  );
  const effectId = `opening:${input.openingPromptEntryId}`;
  const deadline = Date.now() + (options.timeoutMs ?? 24 * 60 * 60_000);
  if (state.state === "ready") return state;
  while (state.currentEffectId && state.currentEffectId !== effectId) {
    if (state.state === "failed")
      throw new Error("Session creation failed before opening dispatch");
    if (state.state === "cancelled")
      throw new Error("Session creation was cancelled before opening dispatch");
    if (Date.now() >= deadline)
      throw new Error(
        `Creation effect ${state.currentEffectId} must settle before ${effectId}`,
      );
    await Bun.sleep(options.pollMs ?? 25);
    const current = await kernel.creationState();
    if (!current)
      throw new Error("Creation state disappeared before opening dispatch");
    if (current.identity !== input.identity)
      throw new Error(
        "Create request identity crossed durable session ownership",
      );
    state = current;
  }
  if (state.state === "failed")
    throw new Error("Session creation failed before opening dispatch");
  if (state.state === "cancelled")
    throw new Error("Session creation was cancelled before opening dispatch");
  if (state.state === "planned") {
    const preparing = await kernel.applyCreationEvent({
      identity: input.identity,
      event: "preparation_started",
    });
    if (!preparing.accepted || !preparing.state)
      throw new Error(
        `Creation preparation was rejected: ${preparing.reason || "unknown"}`,
      );
    state = preparing.state;
  }
  if (state.state === "preparing" && !state.currentEffectId) {
    const emitted = await kernel.applyCreationEvent({
      identity: input.identity,
      event: "opening_dispatched",
      openingPlan: input.openingPlan,
      nextEffectId: effectId,
      effect: {
        kind: "creation_opening_turn",
        effectKey: effectId,
        payload: {
          creationIdentity: input.identity,
          creationGeneration: state.generation,
          openingPromptEntryId: input.openingPromptEntryId,
          runId: input.runId,
          runGeneration: input.runGeneration,
          mode: "adopt_or_launch",
        },
      },
    });
    if (!emitted.accepted || !emitted.state)
      throw new Error(
        `Creation opening intent was rejected: ${emitted.reason || "unknown"}`,
      );
    state = emitted.state;
  }
  if (
    state.state !== "opening_dispatched" ||
    state.currentEffectId !== effectId
  )
    throw new Error(
      `Creation opening ${effectId} has an invalid durable state`,
    );
  while (state.state !== "ready") {
    if (state.state === "failed")
      throw new Error("Session creation failed while opening was pending");
    if (state.state === "cancelled")
      throw new Error(
        "Session creation was cancelled while opening was pending",
      );
    if (Date.now() >= deadline)
      throw new CreationEffectPendingError(
        `Creation opening effect ${effectId} remains durably pending`,
      );
    await Bun.sleep(options.pollMs ?? 25);
    const current = await kernel.creationState();
    if (!current)
      throw new Error("Creation state disappeared while opening was pending");
    if (current.identity !== input.identity)
      throw new Error(
        "Create request identity crossed durable session ownership",
      );
    state = current;
  }
  return state;
}

/** Emit one stable workspace intent and wait for its actor receipt, never its file. */
export async function requestCreationWorkspace(
  input: CreationWorkspaceIntent,
  options: CreationIntentOptions = {},
): Promise<DurableCreationState> {
  const kernel = options.kernel ?? sessionKernel(input.sessionId);
  let state = await ensureCreationPlanned(
    input.sessionId,
    input.identity,
    kernel,
  );
  const effectId = `workspace:${input.workspaceId}`;
  if (state.completedEffectIds.includes(effectId)) return state;
  if (state.currentEffectId && state.currentEffectId !== effectId)
    throw new Error(
      `Creation effect ${state.currentEffectId} must settle before ${effectId}`,
    );
  if (!state.currentEffectId) {
    const emitted = await kernel.applyCreationEvent({
      identity: input.identity,
      event: "preparation_started",
      nextEffectId: effectId,
      effect: {
        kind: "creation_workspace_prepare",
        effectKey: effectId,
        payload: {
          creationIdentity: input.identity,
          creationGeneration: state.generation,
          workspaceId: input.workspaceId,
          dedupeKey: input.dedupeKey,
          name: input.name,
          createdBy: input.createdBy,
          project: input.project,
          branch: input.branch,
          worktreeDir: input.worktreeDir,
          mode: "adopt_or_create",
        },
      },
    });
    if (!emitted.accepted || !emitted.state)
      throw new Error(
        `Creation workspace intent was rejected: ${emitted.reason || "unknown"}`,
      );
    state = emitted.state;
  }
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (!state.completedEffectIds.includes(effectId)) {
    if (Date.now() >= deadline)
      throw new CreationEffectPendingError(
        `Creation workspace effect ${effectId} remains durably pending`,
      );
    await Bun.sleep(options.pollMs ?? 25);
    const current = await kernel.creationState();
    if (!current)
      throw new Error(
        "Creation state disappeared while workspace work was pending",
      );
    assertIdentity(current, input.identity);
    state = current;
  }
  return state;
}

/** Emit one stable branch intent and wait for its actor receipt. */
export async function requestCreationBranch(
  input: CreationBranchIntent,
  options: CreationIntentOptions = {},
): Promise<DurableCreationState> {
  const kernel = options.kernel ?? sessionKernel(input.sessionId);
  let state = await ensureCreationPlanned(
    input.sessionId,
    input.identity,
    kernel,
  );
  const effectId = `branch:${input.project}:${input.branch}`;
  if (state.completedEffectIds.includes(effectId)) return state;
  if (state.currentEffectId && state.currentEffectId !== effectId)
    throw new Error(
      `Creation effect ${state.currentEffectId} must settle before ${effectId}`,
    );
  if (!state.currentEffectId) {
    const emitted = await kernel.applyCreationEvent({
      identity: input.identity,
      event: "preparation_started",
      nextEffectId: effectId,
      effect: {
        kind: "creation_branch_prepare",
        effectKey: effectId,
        payload: {
          creationIdentity: input.identity,
          creationGeneration: state.generation,
          project: input.project,
          branch: input.branch,
          worktreePath: input.worktreePath,
          baseBranch: input.baseBranch,
          isolated: input.isolated,
          existingBranch: input.existingBranch,
          credentialPrincipal: input.credentialPrincipal,
          mode: "adopt_or_create",
        },
      },
    });
    if (!emitted.accepted || !emitted.state)
      throw new Error(
        `Creation branch intent was rejected: ${emitted.reason || "unknown"}`,
      );
    state = emitted.state;
  }
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (!state.completedEffectIds.includes(effectId)) {
    if (Date.now() >= deadline)
      throw new CreationEffectPendingError(
        `Creation branch effect ${effectId} remains durably pending`,
      );
    await Bun.sleep(options.pollMs ?? 25);
    const current = await kernel.creationState();
    if (!current)
      throw new Error(
        "Creation state disappeared while branch work was pending",
      );
    assertIdentity(current, input.identity);
    state = current;
  }
  return state;
}

/** Resolve a durable principal selector without admitting secret material. */
export async function requestCreationCredential(
  input: CreationCredentialIntent,
  options: CreationIntentOptions = {},
): Promise<DurableCreationState> {
  const kernel = options.kernel ?? sessionKernel(input.sessionId);
  let state = await ensureCreationPlanned(
    input.sessionId,
    input.identity,
    kernel,
  );
  const effectId = `credential:${input.principal}:${input.scope}`;
  if (state.completedEffectIds.includes(effectId)) return state;
  if (state.currentEffectId && state.currentEffectId !== effectId)
    throw new Error(
      `Creation effect ${state.currentEffectId} must settle before ${effectId}`,
    );
  if (!state.currentEffectId) {
    const emitted = await kernel.applyCreationEvent({
      identity: input.identity,
      event: "preparation_started",
      nextEffectId: effectId,
      effect: {
        kind: "creation_credential_resolve",
        effectKey: effectId,
        payload: {
          creationIdentity: input.identity,
          creationGeneration: state.generation,
          principal: input.principal,
          scope: input.scope,
          mode: "resolve_current",
        },
      },
    });
    if (!emitted.accepted || !emitted.state)
      throw new Error(
        `Creation credential intent was rejected: ${emitted.reason || "unknown"}`,
      );
    state = emitted.state;
  }
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (!state.completedEffectIds.includes(effectId)) {
    if (Date.now() >= deadline)
      throw new CreationEffectPendingError(
        `Creation credential effect ${effectId} remains durably pending`,
      );
    await Bun.sleep(options.pollMs ?? 25);
    const current = await kernel.creationState();
    if (!current)
      throw new Error(
        "Creation state disappeared while credential work was pending",
      );
    assertIdentity(current, input.identity);
    state = current;
  }
  return state;
}

/** Ensure a session-keyed sandbox and wait only for its actor receipt. */
export async function requestCreationSandbox(
  input: CreationSandboxIntent,
  options: CreationIntentOptions = {},
): Promise<DurableCreationState> {
  const kernel = options.kernel ?? sessionKernel(input.sessionId);
  let state = await ensureCreationPlanned(
    input.sessionId,
    input.identity,
    kernel,
  );
  const effectId = `sandbox:${input.provider}:${input.sessionId}`;
  if (state.completedEffectIds.includes(effectId)) return state;
  if (state.currentEffectId && state.currentEffectId !== effectId)
    throw new Error(
      `Creation effect ${state.currentEffectId} must settle before ${effectId}`,
    );
  if (!state.currentEffectId) {
    const emitted = await kernel.applyCreationEvent({
      identity: input.identity,
      event: "preparation_started",
      nextEffectId: effectId,
      effect: {
        kind: "creation_sandbox_prepare",
        effectKey: effectId,
        payload: {
          creationIdentity: input.identity,
          creationGeneration: state.generation,
          provider: input.provider,
          sandboxKey: input.sessionId,
          repo: input.repo,
          branch: input.branch,
          sessionMode: input.sessionMode,
          cwd: input.cwd,
          base: input.base,
          attachedDirs: input.attachedDirs,
          trustProfile: input.trustProfile,
          egressAllowlist: input.egressAllowlist,
          mode: "adopt_or_create",
        },
      },
    });
    if (!emitted.accepted || !emitted.state)
      throw new Error(
        `Creation sandbox intent was rejected: ${emitted.reason || "unknown"}`,
      );
    state = emitted.state;
  }
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (!state.completedEffectIds.includes(effectId)) {
    if (Date.now() >= deadline)
      throw new CreationEffectPendingError(
        `Creation sandbox effect ${effectId} remains durably pending`,
      );
    await Bun.sleep(options.pollMs ?? 25);
    const current = await kernel.creationState();
    if (!current)
      throw new Error(
        "Creation state disappeared while sandbox work was pending",
      );
    assertIdentity(current, input.identity);
    state = current;
  }
  return state;
}
