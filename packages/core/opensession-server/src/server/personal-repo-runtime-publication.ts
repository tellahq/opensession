import type { RunHostSpec } from "../runner-host/protocol";
import {
  bindSessionPublication,
  bindSessionPublicationSuccessor,
  sessionAudiencesReady,
  sessionPublicationAllowed,
} from "./session-audience";
import { bindSessionExecutionAccess } from "./application-access";
import { samePersonalRepoBinding } from "./personal-repo-runtime";
import { assertPersonalHostLineage } from "./personal-repo-runtime-host";
import {
  bindPersonalRunRecovery,
  type PersonalRunConsumer,
} from "./personal-run-consumers";

export type HostPublicationSource = Pick<
  RunHostSpec,
  "osSessionId" | "cwd" | "personalRepo" | "hostId" | "logicalRunId"
>;
type Scope = (work: () => void) => void;
export type HostPublication = Scope & {
  readonly source: Readonly<HostPublicationSource>;
  readonly signal: AbortSignal;
  readonly abort: () => void;
};
const sharedExecution = globalThis as typeof globalThis & {
  __hostPublicationExecutionV1?: WeakMap<HostPublication, Scope>;
};
const execution = (sharedExecution.__hostPublicationExecutionV1 ??= new WeakMap<
  HostPublication,
  Scope
>());
function snapshot(
  spec: HostPublicationSource,
): Readonly<HostPublicationSource> {
  return Object.freeze({
    osSessionId: spec.osSessionId,
    cwd: spec.cwd,
    hostId: spec.hostId,
    logicalRunId: spec.logicalRunId,
    personalRepo:
      spec.personalRepo &&
      Object.freeze({
        ...spec.personalRepo,
        descriptor: Object.freeze({ ...spec.personalRepo.descriptor }),
      }),
  });
}
function consumer(source: HostPublicationSource): PersonalRunConsumer {
  assertPersonalHostLineage(source);
  if (!source.personalRepo)
    throw new Error("Personal publication binding missing");
  return {
    runKey: source.logicalRunId!,
    hostId: source.hostId,
    sessionId: source.osSessionId,
    binding: source.personalRepo,
  };
}
function combine(
  source: Readonly<HostPublicationSource>,
  scope: Scope,
  access: Scope,
  controller: AbortController,
): HostPublication {
  const publish = Object.assign(
    (work: () => void) => access(() => scope(work)),
    { source, signal: controller.signal, abort: () => controller.abort() },
  );
  execution.set(publish, access);
  return Object.freeze(publish);
}
/** One immutable audience + physical execution context, captured only after
 * original descriptor/workspace validation. Reconnect reuses this context. */
export async function bindHostPublication(
  spec: HostPublicationSource,
): Promise<HostPublication> {
  const source = snapshot(spec),
    binding = source.personalRepo;
  const owner = binding?.descriptor.ownerGithubAccountId ?? 0;
  if (binding) {
    assertPersonalHostLineage(source);
    if (!sessionAudiencesReady())
      throw new Error("Run host publication unavailable");
    const { personalRepoRuntime } =
      await import("./personal-repo-runtime-default");
    const runtime = await personalRepoRuntime();
    await runtime.resolve(owner, binding.registryId, binding);
    await runtime.assertWorkspace(
      owner,
      binding,
      source.osSessionId,
      source.cwd,
    );
  }
  const access: Scope = binding
    ? bindSessionExecutionAccess(
        {
          id: source.osSessionId,
          accessScope: { kind: "personal", ownerGithubAccountId: owner },
          personalRepo: binding,
        },
        (work: () => void) => work(),
      )
    : (work) => work();
  const controller = new AbortController();
  const capture = () =>
    bindSessionPublication(
      source.osSessionId,
      owner,
      (work: () => void) => work(),
      binding
        ? { binding, consumer: consumer(source), signal: controller.signal }
        : {},
    );
  // Validate durable enrollment stamps first, then capture its inherited raw
  // scope. This is not an alias-based authority renewal; the raw scope permits
  // only the explicit successor API to operate after A's physical abort.
  const scope = binding
    ? await (
        await bindPersonalRunRecovery(
          consumer(source),
          capture,
          controller.signal,
        )
      )()
    : await capture();
  return combine(source, scope, access, controller);
}
/** B is a new physical producer, never a mutation/relabeling of A. This uses
 * A's original audience/access stamps, not a fresh session/owner lookup. */
export async function bindHostPublicationSuccessor(
  previous: HostPublication,
  spec: HostPublicationSource,
): Promise<HostPublication> {
  const source = snapshot(spec),
    old = previous.source,
    access = execution.get(previous);
  if (
    !access ||
    !old.personalRepo ||
    !source.personalRepo ||
    old.hostId === source.hostId ||
    old.logicalRunId !== source.logicalRunId ||
    old.osSessionId !== source.osSessionId ||
    old.cwd !== source.cwd ||
    !samePersonalRepoBinding(old.personalRepo, source.personalRepo)
  )
    throw new Error("Invalid personal publication handoff");
  const controller = new AbortController();
  let pending!: Promise<Scope>;
  previous(() => {
    pending = bindSessionPublicationSuccessor(
      consumer(source),
      (work: () => void) => work(),
      controller.signal,
    );
  });
  return combine(source, await pending, access, controller);
}

export function hostPublicationContext(
  publication: HostPublication,
): import("./host-event-publication").HostedEventPublication {
  return Object.freeze({
    personal: !!publication.source.personalRepo,
    ...(publication.source.personalRepo
      ? { consumer: Object.freeze(consumer(publication.source)) }
      : {}),
    alive() {
      if (publication.signal.aborted) return false;
      let allowed = false;
      publication(() => {
        allowed = sessionPublicationAllowed(publication.source.osSessionId);
      });
      return allowed;
    },
    run<T>(work: () => T): T {
      let result!: T;
      publication(() => {
        result = work();
      });
      return result;
    },
  });
}
