import type { DurableOutboxItem } from "./store";
import type {
  SessionActorEffectFor,
  SessionActorEffectKind,
} from "./lifecycle-protocol";

type EffectItem<K extends SessionActorEffectKind> = Omit<
  DurableOutboxItem,
  "kind" | "payload"
> &
  SessionActorEffectFor<K>;

type EffectExecutor<K extends SessionActorEffectKind> = (
  item: EffectItem<K>,
) => void | Promise<void>;

type EffectExecutors = {
  [K in SessionActorEffectKind]?: EffectExecutor<K>;
};

/** Causal predecessor is still pending. Retry without consuming poison budget. */
export class SessionEffectDeferredError extends Error {}

function recordPayload(
  kind: string,
  payload: unknown,
): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error(`Invalid ${kind} effect payload`);
  return payload as Record<string, unknown>;
}

function requiredString(kind: string, value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Invalid ${kind} effect payload: ${field}`);
  return value;
}

function optionalStringList(
  kind: string,
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  )
    throw new Error(`Invalid ${kind} effect payload: ${field}`);
  return [...value];
}

function creationBase(kind: string, value: Record<string, unknown>) {
  if (
    typeof value.creationIdentity !== "string" ||
    value.creationIdentity.length === 0 ||
    !Number.isSafeInteger(value.creationGeneration) ||
    Number(value.creationGeneration) < 1
  )
    throw new Error(`Invalid ${kind} effect payload: creation fence`);
  return {
    creationIdentity: value.creationIdentity,
    creationGeneration: Number(value.creationGeneration),
  };
}

function creationPayload<
  K extends Exclude<
    SessionActorEffectKind,
    | "human_ask_deliver"
    | "delivery_interrupt_cancel"
    | "turn_cancel"
    | "turn_outcome_project"
  >,
>(kind: K, payload: unknown): SessionActorEffectFor<K>["payload"] {
  const value = recordPayload(kind, payload);
  const base = creationBase(kind, value);
  switch (kind) {
    case "creation_workspace_prepare":
      if (value.mode !== "adopt_or_create")
        throw new Error(`Invalid ${kind} effect payload: mode`);
      return {
        ...base,
        workspaceId: requiredString(kind, value.workspaceId, "workspaceId"),
        dedupeKey: requiredString(kind, value.dedupeKey, "dedupeKey"),
        name: requiredString(kind, value.name, "name"),
        createdBy: requiredString(kind, value.createdBy, "createdBy"),
        project:
          value.project === undefined
            ? undefined
            : requiredString(kind, value.project, "project"),
        branch:
          value.branch === undefined
            ? undefined
            : requiredString(kind, value.branch, "branch"),
        worktreeDir:
          value.worktreeDir === undefined
            ? undefined
            : requiredString(kind, value.worktreeDir, "worktreeDir"),
        mode: value.mode,
      } as SessionActorEffectFor<K>["payload"];
    case "creation_branch_prepare":
      if (
        value.mode !== "adopt_or_create" ||
        typeof value.isolated !== "boolean" ||
        (value.existingBranch !== undefined &&
          typeof value.existingBranch !== "boolean")
      )
        throw new Error(`Invalid ${kind} effect payload: mode`);
      return {
        ...base,
        project: requiredString(kind, value.project, "project"),
        branch: requiredString(kind, value.branch, "branch"),
        worktreePath: requiredString(kind, value.worktreePath, "worktreePath"),
        // The pre-cutover creator encoded "no stack base" as an empty
        // string. Normalize those already-durable effects while new producers
        // omit the field entirely.
        baseBranch:
          value.baseBranch === undefined || value.baseBranch === ""
            ? undefined
            : requiredString(kind, value.baseBranch, "baseBranch"),
        isolated: value.isolated === true,
        existingBranch:
          value.existingBranch === undefined
            ? undefined
            : value.existingBranch === true,
        credentialPrincipal:
          value.credentialPrincipal === undefined
            ? undefined
            : requiredString(
                kind,
                value.credentialPrincipal,
                "credentialPrincipal",
              ),
        mode: value.mode,
      } as SessionActorEffectFor<K>["payload"];
    case "creation_sandbox_prepare":
      if (
        value.mode !== "adopt_or_create" ||
        (value.sessionMode !== undefined &&
          value.sessionMode !== "ask" &&
          value.sessionMode !== "code" &&
          value.sessionMode !== "scratch") ||
        (value.trustProfile !== undefined &&
          value.trustProfile !== "interactive" &&
          value.trustProfile !== "automation")
      )
        throw new Error(`Invalid ${kind} effect payload: mode`);
      return {
        ...base,
        provider: requiredString(kind, value.provider, "provider"),
        sandboxKey: requiredString(kind, value.sandboxKey, "sandboxKey"),
        repo:
          value.repo === undefined
            ? undefined
            : requiredString(kind, value.repo, "repo"),
        branch:
          value.branch === undefined
            ? undefined
            : requiredString(kind, value.branch, "branch"),
        sessionMode: value.sessionMode,
        cwd:
          value.cwd === undefined
            ? undefined
            : requiredString(kind, value.cwd, "cwd"),
        base:
          value.base === undefined
            ? undefined
            : requiredString(kind, value.base, "base"),
        attachedDirs: optionalStringList(
          kind,
          value.attachedDirs,
          "attachedDirs",
        ),
        trustProfile: value.trustProfile,
        egressAllowlist: optionalStringList(
          kind,
          value.egressAllowlist,
          "egressAllowlist",
        ),
        mode: value.mode,
      } as SessionActorEffectFor<K>["payload"];
    case "creation_credential_resolve":
      if (value.mode !== "resolve_current")
        throw new Error(`Invalid ${kind} effect payload: mode`);
      return {
        ...base,
        principal: requiredString(kind, value.principal, "principal"),
        scope: requiredString(kind, value.scope, "scope"),
        mode: value.mode,
      } as SessionActorEffectFor<K>["payload"];
    case "creation_attachment_stage":
      if (value.mode !== "reconcile_or_stage")
        throw new Error(`Invalid ${kind} effect payload: mode`);
      return {
        ...base,
        attachmentId: requiredString(kind, value.attachmentId, "attachmentId"),
        name: requiredString(kind, value.name, "name"),
        sourceRef: requiredString(kind, value.sourceRef, "sourceRef"),
        digest: requiredString(kind, value.digest, "digest"),
        mode: value.mode,
      } as SessionActorEffectFor<K>["payload"];
    case "creation_opening_turn":
      if (
        value.mode !== "adopt_or_launch" ||
        !Number.isSafeInteger(value.runGeneration) ||
        Number(value.runGeneration) < 1
      )
        throw new Error(`Invalid ${kind} effect payload: opening fence`);
      return {
        ...base,
        openingPromptEntryId: requiredString(
          kind,
          value.openingPromptEntryId,
          "openingPromptEntryId",
        ),
        runId: requiredString(kind, value.runId, "runId"),
        runGeneration: Number(value.runGeneration),
        mode: value.mode,
      } as SessionActorEffectFor<K>["payload"];
  }
}

function deliveryInterruptCancelPayload(
  payload: unknown,
): SessionActorEffectFor<"delivery_interrupt_cancel">["payload"] {
  const kind = "delivery_interrupt_cancel";
  const value = recordPayload(kind, payload);
  const runIds = optionalStringList(kind, value.runIds, "runIds");
  const dispatchId =
    value.dispatchId === undefined
      ? undefined
      : requiredString(kind, value.dispatchId, "dispatchId");
  if (
    (!dispatchId && !runIds?.length) ||
    (runIds?.length ?? 0) > 8 ||
    !Number.isSafeInteger(value.runGeneration) ||
    Number(value.runGeneration) < 0
  )
    throw new Error(`Invalid ${kind} effect payload: run fence`);
  return {
    interruptId: requiredString(kind, value.interruptId, "interruptId"),
    ...(dispatchId ? { dispatchId } : {}),
    ...(runIds?.length ? { runIds } : {}),
    runGeneration: Number(value.runGeneration),
  };
}

function turnCancelPayload(
  payload: unknown,
): SessionActorEffectFor<"turn_cancel">["payload"] {
  const kind = "turn_cancel";
  const value = recordPayload(kind, payload);
  if (
    !Number.isSafeInteger(value.runGeneration) ||
    Number(value.runGeneration) < 0
  )
    throw new Error(`Invalid ${kind} effect payload: run fence`);
  return {
    cancelId: requiredString(kind, value.cancelId, "cancelId"),
    dispatchId: requiredString(kind, value.dispatchId, "dispatchId"),
    runGeneration: Number(value.runGeneration),
  };
}

function turnOutcomeProjectPayload(
  payload: unknown,
): SessionActorEffectFor<"turn_outcome_project">["payload"] {
  const kind = "turn_outcome_project";
  const value = recordPayload(kind, payload);
  if (
    !Number.isSafeInteger(value.runGeneration) ||
    Number(value.runGeneration) < 1 ||
    (value.errorMessage !== null && typeof value.errorMessage !== "string") ||
    typeof value.noticePersisted !== "boolean" ||
    typeof value.projectedAt !== "string" ||
    !Number.isFinite(Date.parse(value.projectedAt))
  )
    throw new Error(`Invalid ${kind} effect payload: outcome fence`);
  return {
    projectionId: requiredString(kind, value.projectionId, "projectionId"),
    runId: requiredString(kind, value.runId, "runId"),
    runGeneration: Number(value.runGeneration),
    errorMessage: value.errorMessage as string | null,
    ...(value.engineSessionId === undefined
      ? {}
      : {
          engineSessionId: requiredString(
            kind,
            value.engineSessionId,
            "engineSessionId",
          ),
        }),
    noticePersisted: value.noticePersisted,
    ...(value.noticeLabel === undefined
      ? {}
      : {
          noticeLabel: requiredString(kind, value.noticeLabel, "noticeLabel"),
        }),
    projectedAt: value.projectedAt,
  };
}

function humanAskDeliverPayload(
  payload: unknown,
): SessionActorEffectFor<"human_ask_deliver">["payload"] {
  const value = payload as { askId?: unknown; skipUi?: unknown } | undefined;
  if (typeof value?.askId !== "string" || typeof value.skipUi !== "boolean")
    throw new Error("Invalid human_ask_deliver effect payload");
  return { askId: value.askId, skipUi: value.skipUi };
}

const payloadDecoders: {
  [K in SessionActorEffectKind]: (
    payload: unknown,
  ) => SessionActorEffectFor<K>["payload"];
} = {
  human_ask_deliver: humanAskDeliverPayload,
  delivery_interrupt_cancel: deliveryInterruptCancelPayload,
  turn_cancel: turnCancelPayload,
  turn_outcome_project: turnOutcomeProjectPayload,
  creation_workspace_prepare: (payload) =>
    creationPayload("creation_workspace_prepare", payload),
  creation_branch_prepare: (payload) =>
    creationPayload("creation_branch_prepare", payload),
  creation_sandbox_prepare: (payload) =>
    creationPayload("creation_sandbox_prepare", payload),
  creation_credential_resolve: (payload) =>
    creationPayload("creation_credential_resolve", payload),
  creation_attachment_stage: (payload) =>
    creationPayload("creation_attachment_stage", payload),
  creation_opening_turn: (payload) =>
    creationPayload("creation_opening_turn", payload),
};

export class SessionEffectExecutorRegistry {
  private readonly executors: EffectExecutors = {};

  register<K extends SessionActorEffectKind>(
    kind: K,
    executor: EffectExecutor<K>,
  ): () => void {
    if (this.executors[kind])
      throw new Error(`Session effect executor ${kind} is already registered`);
    this.executors[kind] = executor as EffectExecutors[K];
    return () => {
      if (this.executors[kind] === executor) delete this.executors[kind];
    };
  }

  kinds(): SessionActorEffectKind[] {
    return Object.keys(this.executors) as SessionActorEffectKind[];
  }

  replaceForTest<K extends SessionActorEffectKind>(
    kind: K,
    executor: EffectExecutor<K>,
  ): () => void {
    if (process.env.NODE_ENV !== "test")
      throw new Error("Session effect executors can only be replaced in tests");
    const previous = this.executors[kind];
    this.executors[kind] = executor as EffectExecutors[K];
    return () => {
      if (this.executors[kind] !== executor) return;
      if (previous) this.executors[kind] = previous;
      else delete this.executors[kind];
    };
  }

  async execute(item: DurableOutboxItem): Promise<boolean> {
    const kind = item.kind as SessionActorEffectKind;
    const executor = this.executors[kind] as
      | EffectExecutor<typeof kind>
      | undefined;
    const decode = payloadDecoders[kind];
    if (!executor || !decode) return false;
    const effectItem = {
      ...item,
      kind,
      payload: decode(item.payload),
    } as EffectItem<typeof kind>;
    await executor(effectItem);
    return true;
  }
}

const globalRegistry = globalThis as typeof globalThis & {
  __opensessionSessionEffectExecutors?: SessionEffectExecutorRegistry;
};
const registry = (globalRegistry.__opensessionSessionEffectExecutors ??=
  new SessionEffectExecutorRegistry());

export function registerSessionEffectExecutor<K extends SessionActorEffectKind>(
  kind: K,
  executor: EffectExecutor<K>,
): () => void {
  return registry.register(kind, executor);
}

export function registeredSessionEffectKinds(): SessionActorEffectKind[] {
  return registry.kinds();
}

export function replaceSessionEffectExecutorForTest<
  K extends SessionActorEffectKind,
>(kind: K, executor: EffectExecutor<K>): () => void {
  return registry.replaceForTest(kind, executor);
}

export function executeSessionEffect(
  item: DurableOutboxItem,
): Promise<boolean> {
  return registry.execute(item);
}
