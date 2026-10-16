import { snapshotPersonalRepoBinding } from "./personal-repository-identity";
import type { PersonalRepoBinding } from "./personal-repo-runtime";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  PERSONAL_PRIVACY_PROTOCOL,
  canAccessScope,
  isGithubAccountId,
  parseAccessScope,
  sameAccessScope,
  type AccessPrincipal,
  type AccessScope,
} from "../shared/access-scope";
import type { WebIdentity } from "./web-auth";

/** Explicit operation context, not ambient authority inherited by background
 * callbacks. A shared session must not ingest its initiator's private data. */
export interface ApplicationAccess {
  readonly principal: Readonly<AccessPrincipal> | undefined;
  readonly origin: Readonly<AccessScope> | undefined;
  readonly sessionId: string | undefined;
  readonly binding?: PersonalRepoBinding;
  /** Include in list/cache/ETag keys. Attribution and display filters are not
   * audience partitions. This key is instance-local, not a credential. */
  readonly audience: string;
}

function access(
  principal: AccessPrincipal | undefined,
  origin: AccessScope | undefined,
  sessionId?: string,
  binding?: PersonalRepoBinding,
): ApplicationAccess {
  return Object.freeze({
    sessionId,
    binding: binding ? snapshotPersonalRepoBinding(binding) : undefined,
    principal: principal ? Object.freeze({ ...principal }) : undefined,
    origin: origin ? Object.freeze({ ...origin }) : undefined,
    audience: principal ? `github:${principal.githubAccountId}` : "shared",
  });
}

/** Only pass RouteContext.authUser / the verified WebSocket identity here.
 * Request JSON, login/display-name lookups and admin roles are not identities. */
export function accessForVerifiedWebIdentity(
  identity: WebIdentity | null | undefined,
): ApplicationAccess {
  const id = identity?.githubAccountId;
  return access(
    identity && !identity.automation && isGithubAccountId(id)
      ? { githubAccountId: id }
      : undefined,
    undefined,
  );
}

/** The caller must first authenticate the run's bound session id and obtain its
 * authoritative catalog scope. This constructor does not authenticate a run.
 * Never pass a tool's claimed session, user or scope. No initiator identity is
 * accepted: even a private owner's shared run has shared-only read authority. */
export function accessForAuthenticatedSession(
  authoritativeSession:
    | {
        id: string;
        accessScope?: AccessScope;
        personalRepo?: PersonalRepoBinding;
      }
    | undefined,
): ApplicationAccess {
  // A missing authority result is not a legacy shared record.
  if (typeof authoritativeSession?.id !== "string" || !authoritativeSession.id)
    throw new Error("Session access unavailable");
  const scope = parseAccessScope(authoritativeSession.accessScope);
  if (!scope) throw new Error("Session access unavailable");
  return access(
    scope.kind === "personal"
      ? { githubAccountId: scope.ownerGithubAccountId }
      : undefined,
    scope,
    authoritativeSession.id,
    authoritativeSession.personalRepo,
  );
}

export function canReadApplicationResource(
  context: ApplicationAccess,
  scope: unknown,
): boolean {
  return canAccessScope(scope, context.principal);
}

/** Reading shared input into a private session is allowed. Writing from a
 * private session into shared/another-owner context is not. Host-risk consent
 * is not an export grant; no caller-controlled export boolean is accepted. */
export function canWriteApplicationResource(
  context: ApplicationAccess,
  destination: unknown,
): boolean {
  return (
    canReadApplicationResource(context, destination) &&
    (context.origin?.kind !== "personal" ||
      sameAccessScope(context.origin, destination))
  );
}

/** Use for server-side copy/attach/send operations with known source data.
 * Explicit export will require a separate verified authorization path. */
export function canTransferApplicationResource(
  context: ApplicationAccess,
  source: unknown,
  destination: unknown,
): boolean {
  const parsed = parseAccessScope(source);
  return (
    !!parsed &&
    canReadApplicationResource(context, parsed) &&
    canWriteApplicationResource(context, destination) &&
    (parsed.kind === "shared" || sameAccessScope(parsed, destination))
  );
}

export interface CanonicalSessionHandle {
  readonly id: string;
  readonly accessScope: Readonly<AccessScope>;
}

type SessionLookup = (
  id: string,
  principal?: AccessPrincipal,
) => Promise<{ id: string; accessScope?: AccessScope } | undefined>;

/** Resolve once at admission and pass the canonical id downstream, rather than
 * authorizing an alias then letting a handler resolve that alias differently.
 * This is an operation handle, not a cached lease or a revocation fence. */
export async function resolveApplicationSession(
  requestedId: string,
  context: ApplicationAccess,
  lookup?: SessionLookup,
): Promise<CanonicalSessionHandle | undefined> {
  if (!requestedId) return undefined;
  const find = lookup ?? (await import("./session-cache")).findSessionAsync;
  const session = await find(requestedId, context.principal);
  if (typeof session?.id !== "string" || !session.id) return undefined;
  const scope = parseAccessScope(session.accessScope);
  if (!scope || !canReadApplicationResource(context, scope)) return undefined;
  return Object.freeze({ id: session.id, accessScope: Object.freeze(scope) });
}

export class PrivacyPrincipalChanged extends Error {
  readonly code = "principal_changed";
  readonly status = 409;
  constructor() {
    super("Principal changed; refresh authentication");
  }
}

/** The captured id is a consistency precondition, NEVER an authority source.
 * A modern request cannot silently downgrade into a shared mutation when a
 * different tab changed its cookie. Legacy/unknown clients stay shared-only. */
export function validatePrivacyPrincipal(
  protocol: string | null | undefined,
  expectedDecimal: string | null | undefined,
  identity: WebIdentity | null | undefined,
): ApplicationAccess {
  if (protocol !== PERSONAL_PRIVACY_PROTOCOL)
    return accessForVerifiedWebIdentity(undefined);
  const expected =
    typeof expectedDecimal === "string" && /^[1-9][0-9]*$/.test(expectedDecimal)
      ? Number(expectedDecimal)
      : NaN;
  const actual = accessForVerifiedWebIdentity(identity);
  if (
    !isGithubAccountId(expected) ||
    String(expected) !== expectedDecimal ||
    actual.principal?.githubAccountId !== expected
  )
    throw new PrivacyPrincipalChanged();
  return actual;
}

/** Server-stamped upgrade fields only; protocol fields in message JSON are ignored. */
export function webSocketApplicationAccess(data: {
  privacyProtocol?: string;
  expectedGithubAccountId?: number;
  authGithubAccountId?: number;
  authLogin?: string | null;
  authUser?: string | null;
  authAutomation?: boolean;
}): ApplicationAccess {
  return validatePrivacyPrincipal(
    data.privacyProtocol,
    data.expectedGithubAccountId === undefined
      ? undefined
      : String(data.expectedGithubAccountId),
    data.authLogin
      ? {
          login: data.authLogin,
          name: data.authUser || data.authLogin,
          githubAccountId: data.authGithubAccountId,
          automation: data.authAutomation,
        }
      : null,
  );
}

/** Execution provenance is explicit at admission and follows only that run's
 * async work. HTTP callers still pass their verified read principal explicitly. */

const accessGlobal = globalThis as typeof globalThis & {
  __applicationExecutionAccess?: AsyncLocalStorage<ApplicationAccess>;
};
const executionAccess = (accessGlobal.__applicationExecutionAccess ??=
  new AsyncLocalStorage<ApplicationAccess>());
export function currentExecutionAccess(): ApplicationAccess | undefined {
  return executionAccess.getStore();
}
export function withSessionExecutionAccess<T>(
  session: {
    id: string;
    accessScope?: AccessScope;
    personalRepo?: PersonalRepoBinding;
  },
  work: () => Promise<T>,
): Promise<T> {
  const next = accessForAuthenticatedSession(session);
  const previous = executionAccess.getStore();
  if (previous && !sameAccessScope(previous.origin, next.origin))
    throw new Error("Session execution scope cannot change");
  return executionAccess.run(next, work);
}
export function executionReadPrincipal(
  explicit?: AccessPrincipal,
): AccessPrincipal | undefined {
  const current = executionAccess.getStore();
  if (!current) return explicit;
  if (
    explicit &&
    explicit.githubAccountId !== current.principal?.githubAccountId
  )
    throw new Error("Execution principal cannot change");
  return current.principal;
}

/** Bind only an authenticated source session; publication context independently
 * retains and validates its original audience/physical source lease. */
export function bindSessionExecutionAccess<A extends unknown[], R>(
  session: {
    id: string;
    accessScope?: AccessScope;
    personalRepo?: PersonalRepoBinding;
  },
  callback: (...args: A) => R,
): (...args: A) => R {
  const context = accessForAuthenticatedSession(session);
  return (...args: A) => {
    const previous = executionAccess.getStore();
    if (previous && !sameAccessScope(previous.origin, context.origin))
      throw new Error("Session execution scope cannot change");
    return executionAccess.run(context, () => callback(...args));
  };
}
