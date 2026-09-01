import { existsSync } from "fs";
import { resolve } from "path";
import type { GithubCredential } from "../github-auth";
import type { Sandbox, SandboxSessionSpec } from "../sandbox/provider";
import { createWorkspace, getWorkspace, type Workspace } from "../workspaces";
import type { CreationAttachmentSource } from "../uploads";
import type { WorktreeInfo } from "../worktree";
import { registerSessionEffectExecutor } from "./effect-executors";
import { sessionKernel } from "./kernel";
import type { SessionActorEffectFor } from "./lifecycle-protocol";
import type { CreationEventDecisionResult, DurableOutboxItem } from "./store";

type WorkspaceEffect = SessionActorEffectFor<"creation_workspace_prepare">;
type BranchEffect = SessionActorEffectFor<"creation_branch_prepare">;
type CredentialEffect = SessionActorEffectFor<"creation_credential_resolve">;
type SandboxEffect = SessionActorEffectFor<"creation_sandbox_prepare">;
type AttachmentEffect = SessionActorEffectFor<"creation_attachment_stage">;
type OpeningEffect = SessionActorEffectFor<"creation_opening_turn">;
export type CreationWorkspaceEffectItem = Omit<
  DurableOutboxItem,
  "kind" | "payload"
> &
  WorkspaceEffect;
export type CreationBranchEffectItem = Omit<
  DurableOutboxItem,
  "kind" | "payload"
> &
  BranchEffect;
export type CreationCredentialEffectItem = Omit<
  DurableOutboxItem,
  "kind" | "payload"
> &
  CredentialEffect;
export type CreationSandboxEffectItem = Omit<
  DurableOutboxItem,
  "kind" | "payload"
> &
  SandboxEffect;
export type CreationAttachmentEffectItem = Omit<
  DurableOutboxItem,
  "kind" | "payload"
> &
  AttachmentEffect;
export type CreationOpeningEffectItem = Omit<
  DurableOutboxItem,
  "kind" | "payload"
> &
  OpeningEffect;

export class CreationEffectIndeterminateError extends Error {
  readonly indeterminate = true;
}

type WorkspaceExecutorDependencies = {
  getWorkspace: typeof getWorkspace;
  createWorkspace: typeof createWorkspace;
  result: (
    item: CreationWorkspaceEffectItem,
  ) => CreationEventDecisionResult | Promise<CreationEventDecisionResult>;
  afterDestinationAccepted?: (workspace: Workspace) => void;
};

function defaultResult(
  item: CreationWorkspaceEffectItem,
): Promise<CreationEventDecisionResult> {
  return sessionKernel(item.sessionId).applyCreationEvent({
    identity: item.payload.creationIdentity,
    event: "preparation_started",
    effectId: item.effectKey,
    detail: { workspaceId: item.payload.workspaceId },
  });
}

const defaultDependencies: WorkspaceExecutorDependencies = {
  getWorkspace,
  createWorkspace,
  result: defaultResult,
};

function assertAdoptableWorkspace(
  workspace: Workspace,
  item: CreationWorkspaceEffectItem,
): void {
  const payload = item.payload;
  if (workspace.key !== payload.dedupeKey)
    throw new CreationEffectIndeterminateError(
      `Workspace ${payload.workspaceId} exists with another durable identity`,
    );
  if (payload.project !== undefined && workspace.repo !== payload.project)
    throw new CreationEffectIndeterminateError(
      `Workspace ${payload.workspaceId} exists for another project`,
    );
  if (payload.branch !== undefined && workspace.branch !== payload.branch)
    throw new CreationEffectIndeterminateError(
      `Workspace ${payload.workspaceId} exists for another branch`,
    );
  if (
    payload.worktreeDir !== undefined &&
    workspace.worktreeDir !== payload.worktreeDir
  )
    throw new CreationEffectIndeterminateError(
      `Workspace ${payload.workspaceId} exists for another worktree`,
    );
}

/**
 * Create or adopt a fixed workspace destination, then return its fenced result.
 * A retry after destination acceptance adopts the same workspace. A retry after
 * result acceptance receives a stale-result no-op and can safely acknowledge.
 */
export async function executeCreationWorkspacePrepare(
  item: CreationWorkspaceEffectItem,
  dependencies: WorkspaceExecutorDependencies = defaultDependencies,
): Promise<void> {
  const payload = item.payload;
  let workspace = dependencies.getWorkspace(payload.workspaceId);
  if (workspace) assertAdoptableWorkspace(workspace, item);
  else {
    workspace = dependencies.createWorkspace({
      id: payload.workspaceId,
      key: payload.dedupeKey,
      name: payload.name,
      createdBy: payload.createdBy,
      repo: payload.project,
      branch: payload.branch,
      worktreeDir: payload.worktreeDir,
    });
  }
  dependencies.afterDestinationAccepted?.(workspace);
  const result = await dependencies.result(item);
  if (result.accepted || result.reason === "stale_effect") return;
  throw new CreationEffectIndeterminateError(
    `Workspace effect ${item.effectId} result was rejected: ${result.reason || "unknown"}`,
  );
}

type BranchExecutorDependencies = {
  listWorktrees: (project: string) => Promise<WorktreeInfo[]>;
  createWorktree: (
    branch: string,
    project: string,
    options: {
      base?: string;
      isolated?: boolean;
      gitEnv?: Record<string, string>;
    },
  ) => Promise<string>;
  createWorktreeForExistingBranch?: (
    branch: string,
    project: string,
    gitEnv?: Record<string, string>,
  ) => Promise<string>;
  resolveCredential?: (principal: string) => Promise<GithubCredential | null>;
  destinationExists?: (path: string) => boolean;
  isSharedCheckoutDestination?: (
    project: string,
    path: string,
  ) => Promise<boolean>;
  result: (
    item: CreationBranchEffectItem,
  ) => CreationEventDecisionResult | Promise<CreationEventDecisionResult>;
  afterDestinationAccepted?: (worktreePath: string) => void;
};

function defaultBranchResult(
  item: CreationBranchEffectItem,
): Promise<CreationEventDecisionResult> {
  return sessionKernel(item.sessionId).applyCreationEvent({
    identity: item.payload.creationIdentity,
    event: "preparation_started",
    effectId: item.effectKey,
    detail: {
      project: item.payload.project,
      branch: item.payload.branch,
      worktreePath: item.payload.worktreePath,
    },
  });
}

async function resolveCurrentCredential(
  principal: string,
): Promise<GithubCredential | null> {
  return (await import("../github-auth")).githubCredentialForPrincipal(
    principal,
  );
}

async function createExistingWorktree(
  branch: string,
  project: string,
  gitEnv?: Record<string, string>,
): Promise<string> {
  return (await import("../worktree")).createWorktreeForExistingBranch(
    branch,
    project,
    gitEnv,
  );
}

async function isSharedCheckoutDestination(
  project: string,
  path: string,
): Promise<boolean> {
  const { getRepo, sharedCheckoutForNewSessions } = await import("../worktree");
  const repo = getRepo(project);
  return (
    sharedCheckoutForNewSessions(repo) && resolve(repo.repo) === resolve(path)
  );
}

const defaultBranchDependencies: BranchExecutorDependencies = {
  listWorktrees: async (project) =>
    (await import("../worktree")).listWorktrees(project),
  createWorktree: async (branch, project, options) =>
    (await import("../worktree")).createWorktree(branch, project, options),
  createWorktreeForExistingBranch: createExistingWorktree,
  resolveCredential: resolveCurrentCredential,
  destinationExists: existsSync,
  isSharedCheckoutDestination,
  result: defaultBranchResult,
};

/** Create or adopt one exact branch/worktree destination before returning its fence. */
export async function executeCreationBranchPrepare(
  item: CreationBranchEffectItem,
  dependencies: BranchExecutorDependencies = defaultBranchDependencies,
): Promise<void> {
  const payload = item.payload;
  const worktrees = await dependencies.listWorktrees(payload.project);
  const byBranch = worktrees.find(
    (worktree) => worktree.branch === payload.branch,
  );
  const byPath = worktrees.find(
    (worktree) => worktree.path === payload.worktreePath,
  );
  if (byBranch && byBranch.path !== payload.worktreePath)
    throw new CreationEffectIndeterminateError(
      `Branch ${payload.branch} is checked out at another destination`,
    );
  if (byPath && byPath.branch !== payload.branch)
    throw new CreationEffectIndeterminateError(
      `Worktree ${payload.worktreePath} belongs to another branch`,
    );
  const sharedCheckout =
    !byBranch &&
    (await (
      dependencies.isSharedCheckoutDestination ?? isSharedCheckoutDestination
    )(payload.project, payload.worktreePath));
  if (
    !byPath &&
    !sharedCheckout &&
    (dependencies.destinationExists ?? existsSync)(payload.worktreePath)
  )
    throw new CreationEffectIndeterminateError(
      `Worktree destination ${payload.worktreePath} exists without a registered branch`,
    );
  let credential: GithubCredential | null = null;
  if (!byBranch && !sharedCheckout && payload.credentialPrincipal) {
    credential = await (
      dependencies.resolveCredential ?? resolveCurrentCredential
    )(payload.credentialPrincipal);
    if (!credential)
      throw new Error(
        `Credential ${payload.credentialPrincipal} is not currently available`,
      );
    if (credential.principal !== payload.credentialPrincipal)
      throw new CreationEffectIndeterminateError(
        `Credential selector ${payload.credentialPrincipal} resolved to another principal`,
      );
  }
  const acceptedPath =
    byBranch?.path ??
    (sharedCheckout
      ? payload.worktreePath
      : payload.existingBranch
        ? await (
            dependencies.createWorktreeForExistingBranch ??
            createExistingWorktree
          )(payload.branch, payload.project, credential?.env)
        : await dependencies.createWorktree(payload.branch, payload.project, {
            ...(payload.baseBranch ? { base: payload.baseBranch } : {}),
            ...(payload.isolated ? { isolated: true } : {}),
            ...(credential ? { gitEnv: credential.env } : {}),
          }));
  if (acceptedPath !== payload.worktreePath)
    throw new CreationEffectIndeterminateError(
      `Branch ${payload.branch} materialized at an unexpected destination`,
    );
  dependencies.afterDestinationAccepted?.(acceptedPath);
  const result = await dependencies.result(item);
  if (result.accepted || result.reason === "stale_effect") return;
  throw new CreationEffectIndeterminateError(
    `Branch effect ${item.effectId} result was rejected: ${result.reason || "unknown"}`,
  );
}

type SandboxExecutorDependencies = {
  ensure: (
    provider: string,
    spec: SandboxSessionSpec,
  ) => Promise<Pick<Sandbox, "id" | "provider">>;
  result: (
    item: CreationSandboxEffectItem,
    sandboxId: string,
  ) => CreationEventDecisionResult | Promise<CreationEventDecisionResult>;
  afterDestinationAccepted?: (
    sandbox: Pick<Sandbox, "id" | "provider">,
  ) => void;
};

function defaultSandboxResult(
  item: CreationSandboxEffectItem,
  sandboxId: string,
): Promise<CreationEventDecisionResult> {
  return sessionKernel(item.sessionId).applyCreationEvent({
    identity: item.payload.creationIdentity,
    event: "preparation_started",
    effectId: item.effectKey,
    detail: {
      provider: item.payload.provider,
      sandboxKey: item.payload.sandboxKey,
      sandboxId,
    },
  });
}

const defaultSandboxDependencies: SandboxExecutorDependencies = {
  ensure: async (providerId, spec) => {
    const [{ getSandboxProvider }, { ensureSandboxWithTransientRetry }] =
      await Promise.all([
        import("../sandbox"),
        import("../sandbox/reliability"),
      ]);
    return ensureSandboxWithTransientRetry(
      getSandboxProvider(providerId),
      spec,
    );
  },
  result: defaultSandboxResult,
};

/** Create or adopt the provider resource keyed by this canonical session. */
export async function executeCreationSandboxPrepare(
  item: CreationSandboxEffectItem,
  dependencies: SandboxExecutorDependencies = defaultSandboxDependencies,
): Promise<void> {
  const payload = item.payload;
  if (payload.sandboxKey !== item.sessionId)
    throw new CreationEffectIndeterminateError(
      `Sandbox key ${payload.sandboxKey} crossed session ownership`,
    );
  const sandbox = await dependencies.ensure(payload.provider, {
    sessionId: payload.sandboxKey,
    repo: payload.repo,
    branch: payload.branch,
    mode: payload.sessionMode,
    cwd: payload.cwd,
    base: payload.base,
    attachedDirs: payload.attachedDirs,
    trustProfile: payload.trustProfile,
    egressAllowlist: payload.egressAllowlist,
  });
  if (sandbox.provider !== payload.provider)
    throw new CreationEffectIndeterminateError(
      `Sandbox ${sandbox.id} was returned by another provider`,
    );
  dependencies.afterDestinationAccepted?.(sandbox);
  const result = await dependencies.result(item, sandbox.id);
  if (result.accepted || result.reason === "stale_effect") return;
  throw new CreationEffectIndeterminateError(
    `Sandbox effect ${item.effectId} result was rejected: ${result.reason || "unknown"}`,
  );
}

type CredentialExecutorDependencies = {
  resolveCredential: (principal: string) => Promise<GithubCredential | null>;
  result: (
    item: CreationCredentialEffectItem,
  ) => CreationEventDecisionResult | Promise<CreationEventDecisionResult>;
  afterResolved?: (credential: GithubCredential) => void;
};

function defaultCredentialResult(
  item: CreationCredentialEffectItem,
): Promise<CreationEventDecisionResult> {
  return sessionKernel(item.sessionId).applyCreationEvent({
    identity: item.payload.creationIdentity,
    event: "preparation_started",
    effectId: item.effectKey,
    detail: {
      principal: item.payload.principal,
      scope: item.payload.scope,
    },
  });
}

const defaultCredentialDependencies: CredentialExecutorDependencies = {
  resolveCredential: resolveCurrentCredential,
  result: defaultCredentialResult,
};

/** Validate a durable principal selector without returning or persisting its secret. */
export async function executeCreationCredentialResolve(
  item: CreationCredentialEffectItem,
  dependencies: CredentialExecutorDependencies = defaultCredentialDependencies,
): Promise<void> {
  const credential = await dependencies.resolveCredential(
    item.payload.principal,
  );
  if (!credential)
    throw new Error(
      `Credential ${item.payload.principal} is not currently available`,
    );
  if (credential.principal !== item.payload.principal)
    throw new CreationEffectIndeterminateError(
      `Credential selector ${item.payload.principal} resolved to another principal`,
    );
  dependencies.afterResolved?.(credential);
  const result = await dependencies.result(item);
  if (result.accepted || result.reason === "stale_effect") return;
  throw new CreationEffectIndeterminateError(
    `Credential effect ${item.effectId} result was rejected: ${result.reason || "unknown"}`,
  );
}

type AttachmentExecutorDependencies = {
  stage: (
    sessionId: string,
    source: CreationAttachmentSource,
  ) => { name: string; path: string } | Promise<{ name: string; path: string }>;
  result: (
    item: CreationAttachmentEffectItem,
  ) => CreationEventDecisionResult | Promise<CreationEventDecisionResult>;
  afterDestinationAccepted?: (path: string) => void;
};

const defaultAttachmentDependencies: AttachmentExecutorDependencies = {
  stage: async (sessionId, source) =>
    (await import("../uploads")).stageCreationAttachment(sessionId, source),
  result: (item) =>
    sessionKernel(item.sessionId).applyCreationEvent({
      identity: item.payload.creationIdentity,
      event: "preparation_started",
      effectId: item.effectKey,
      detail: { attachmentId: item.payload.attachmentId },
    }),
};

/** Stage or adopt one digest-fenced session attachment, then settle its receipt. */
export async function executeCreationAttachmentStage(
  item: CreationAttachmentEffectItem,
  dependencies: AttachmentExecutorDependencies = defaultAttachmentDependencies,
): Promise<void> {
  const staged = await dependencies.stage(item.sessionId, {
    attachmentId: item.payload.attachmentId,
    name: item.payload.name,
    sourceRef: item.payload.sourceRef,
    digest: item.payload.digest,
  });
  dependencies.afterDestinationAccepted?.(staged.path);
  const result = await dependencies.result(item);
  if (result.accepted || result.reason === "stale_effect") return;
  throw new CreationEffectIndeterminateError(
    `Attachment effect ${item.effectId} result was rejected: ${result.reason || "unknown"}`,
  );
}

type OpeningExecutorDependencies = {
  cancel?: (item: CreationOpeningEffectItem) => boolean | Promise<boolean>;
  launch: (item: CreationOpeningEffectItem) => Promise<void>;
};

const defaultOpeningDependencies: OpeningExecutorDependencies = {
  cancel: async (item) =>
    (await import("../session-create")).settleStoppedCreationOpening(item),
  launch: async (item) =>
    (await import("../session-create")).executeCreationOpeningEffect(item),
};

/** Launch or recover the one opening turn named by its durable actor fence. */
export async function executeCreationOpeningTurn(
  item: CreationOpeningEffectItem,
  dependencies: OpeningExecutorDependencies = defaultOpeningDependencies,
): Promise<void> {
  const expectedRunId = `opening:${item.sessionId}:${item.payload.openingPromptEntryId}`;
  if (item.payload.runId !== expectedRunId)
    throw new CreationEffectIndeterminateError(
      `Opening run ${item.payload.runId} crossed session ownership`,
    );
  if (dependencies.cancel && (await dependencies.cancel(item))) return;
  await dependencies.launch(item);
}

const registrationGlobal = globalThis as typeof globalThis & {
  __opensessionCreationWorkspaceExecutorRegistered?: boolean;
  __opensessionCreationBranchExecutorRegistered?: boolean;
  __opensessionCreationCredentialExecutorRegistered?: boolean;
  __opensessionCreationSandboxExecutorRegistered?: boolean;
  __opensessionCreationAttachmentExecutorRegistered?: boolean;
  __opensessionCreationOpeningExecutorRegistered?: boolean;
};

export function ensureCreationEffectExecutors(): void {
  if (!registrationGlobal.__opensessionCreationWorkspaceExecutorRegistered) {
    registerSessionEffectExecutor(
      "creation_workspace_prepare",
      executeCreationWorkspacePrepare,
    );
    registrationGlobal.__opensessionCreationWorkspaceExecutorRegistered = true;
  }
  if (!registrationGlobal.__opensessionCreationBranchExecutorRegistered) {
    registerSessionEffectExecutor(
      "creation_branch_prepare",
      executeCreationBranchPrepare,
    );
    registrationGlobal.__opensessionCreationBranchExecutorRegistered = true;
  }
  if (!registrationGlobal.__opensessionCreationSandboxExecutorRegistered) {
    registerSessionEffectExecutor(
      "creation_sandbox_prepare",
      executeCreationSandboxPrepare,
    );
    registrationGlobal.__opensessionCreationSandboxExecutorRegistered = true;
  }
  if (!registrationGlobal.__opensessionCreationCredentialExecutorRegistered) {
    registerSessionEffectExecutor(
      "creation_credential_resolve",
      executeCreationCredentialResolve,
    );
    registrationGlobal.__opensessionCreationCredentialExecutorRegistered = true;
  }
  if (!registrationGlobal.__opensessionCreationAttachmentExecutorRegistered) {
    registerSessionEffectExecutor(
      "creation_attachment_stage",
      executeCreationAttachmentStage,
    );
    registrationGlobal.__opensessionCreationAttachmentExecutorRegistered = true;
  }
  if (!registrationGlobal.__opensessionCreationOpeningExecutorRegistered) {
    registerSessionEffectExecutor(
      "creation_opening_turn",
      executeCreationOpeningTurn,
    );
    registrationGlobal.__opensessionCreationOpeningExecutorRegistered = true;
  }
}
