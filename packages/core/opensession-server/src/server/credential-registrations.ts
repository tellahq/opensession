/**
 * Credential registration requests: the agent asks the person driving a
 * session to add a credential to the keychain, and waits while they paste it.
 *
 * The agent supplies only metadata (service slug, host, limits, description).
 * The session shows a card to its driver, who types the secret into a
 * password field that posts straight to /api/keychain/registrations
 * (routes/keychain.ts). The secret then goes through the same addCredential
 * path as Settings → Account. It is never broadcast, never stored here, never
 * logged, and never part of what the waiting tool call returns, so it cannot
 * reach the model or the transcript.
 *
 * Only the driver can answer: the request records the GitHub login of the
 * person who prompted the session, and the route requires that same verified
 * sign-in. The credential is theirs, not the bot's.
 *
 * Same shape as local-file-requests.ts: one pending request per session, held
 * in memory, broadcast to every viewer. A restart drops the request and the
 * waiting tool call with it.
 *
 * The card belongs to the person, not to the tool call: a call that is
 * cancelled or times out stops waiting, but the card stays open until it is
 * answered or expires. Asking again for the same service and host waits on
 * that same card, and a secret saved meanwhile is in list_credentials.
 *
 * The same card also replaces an existing credential's secret or metadata
 * (update_credential) and removes one (delete_credential). Both act on a
 * credential the driver already owns, and the driver confirms each on the
 * card: the agent can never rotate, re-point or delete a credential by
 * itself, and it never sees the new secret either.
 */
import { broadcastToSession } from "./ws-hub";
import { audit } from "./audit";
import {
  addCredentialAsync,
  changedCredentialFields,
  credentialSpecHost,
  credentialSpecOf,
  deleteCredentialAsync,
  findCredential,
  isCredentialOwner,
  normalizeCredentialSpec,
  updateCredentialAsync,
  type CredentialSpec,
  type KeychainCredentialMeta,
  type NormalizedCredentialSpec,
  type UpdatableCredentialField,
  type UpdateCredentialResult,
} from "./keychain";

export type CredentialRequestAction = "register" | "update" | "delete";

export interface CredentialRegistrationRequest extends NormalizedCredentialSpec {
  id: string;
  /** Roster name of the driver, who will own (or already owns) the
   *  credential. */
  owner: string;
  requestedAt: number;
  expiresAt: number;
  /** Absent: add a new credential. "update" and "delete" act on
   *  `credentialId`, and the spec is what it will be (update) or is
   *  (delete). */
  action?: "update" | "delete";
  credentialId?: string;
  /** For an update: the fields that change, and their current values. */
  changed?: UpdatableCredentialField[];
  previous?: Partial<NormalizedCredentialSpec>;
  /** For an update: a new secret must be pasted. When false, the card
   *  offers to replace it but saves the metadata without one. */
  requireSecret?: boolean;
}

export type CredentialRegistrationResult =
  | { status: "registered"; credential: KeychainCredentialMeta }
  | { status: "updated"; update: UpdateCredentialResult }
  | { status: "deleted"; credential: KeychainCredentialMeta }
  | { status: "declined" }
  | { status: "expired" }
  /** The waiting call was cancelled; the card is still open. */
  | { status: "pending"; request: CredentialRegistrationRequest };

type Pending = {
  request: CredentialRegistrationRequest;
  /** Lower-cased GitHub login of the only person who may answer. */
  login: string;
  /** What the card is for: asking again with the same key waits on it. */
  key: string;
  /** Tool calls waiting on this card. */
  waiters: Set<(result: CredentialRegistrationResult) => void>;
  timer: ReturnType<typeof setTimeout>;
  /** Set while a submitted secret is being saved, so a second answer from
   *  another tab cannot race it. */
  answering: boolean;
};

/** Long enough to find a key in a provider dashboard. */
export const CREDENTIAL_REGISTRATION_TTL_MS = 15 * 60 * 1000;
/** Keychain secrets are API keys, tokens and passwords, not documents. */
export const MAX_SECRET_LENGTH = 8 * 1024;

const g = globalThis as {
  __pendingCredentialRegistrations?: Map<string, Pending>;
};
const pending: Map<string, Pending> = (g.__pendingCredentialRegistrations ??=
  new Map());

export class CredentialRegistrationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function announce(
  sessionId: string,
  request: CredentialRegistrationRequest | null,
) {
  broadcastToSession(sessionId, {
    type: "credential_registration_request",
    sessionId,
    credentialRequest: request,
  });
}

function settle(
  sessionId: string,
  entry: Pending,
  result: CredentialRegistrationResult,
): void {
  if (pending.get(sessionId) !== entry) return;
  pending.delete(sessionId);
  clearTimeout(entry.timer);
  for (const resolve of entry.waiters) resolve(result);
  entry.waiters.clear();
  audit({
    kind: `keychain_registration_${result.status}`,
    request_id: entry.request.id,
    session_id: sessionId,
    service: entry.request.service,
    owner: entry.request.owner,
    ...(entry.request.action ? { action: entry.request.action } : {}),
    ...(entry.request.credentialId
      ? { credential_id: entry.request.credentialId }
      : {}),
    ...(result.status === "registered"
      ? { credential_id: result.credential.id }
      : {}),
    ...(result.status === "updated"
      ? {
          fields: result.update.changed,
          secret_rotated: result.update.secretRotated,
          grants_kept: result.update.grantsKept,
          grants_revoked: result.update.grantsRevoked,
        }
      : {}),
  });
  broadcastToSession(sessionId, {
    type: "credential_registration_resolved",
    sessionId,
    requestId: entry.request.id,
    status: result.status,
  });
}

/** Wait on the card until it settles, or until `signal` gives up on it. */
function wait(
  entry: Pending,
  signal?: AbortSignal,
): Promise<CredentialRegistrationResult> {
  return new Promise((resolve) => {
    const waiter = (result: CredentialRegistrationResult) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      entry.waiters.delete(waiter);
      resolve({ status: "pending", request: entry.request });
    };
    if (signal?.aborted) return onAbort();
    entry.waiters.add(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Model-authored text shown to a person: no control or bidi-override
 *  characters that could make the card say something else. */
function displaySafe(text: string | undefined): string | undefined {
  return text
    ?.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, 240);
}

function requireDriver(
  sessionId: string,
  input: { owner: string; login: string },
) {
  if (!sessionId || !input.login || !input.owner)
    throw new Error("a verified teammate must be driving this session");
}

/**
 * Wait on this session's open card if it is for the same thing, or open a
 * new one built by `build` (which validates and may throw before any card
 * appears). A different open request in the session is refused.
 */
function openOrJoin(
  sessionId: string,
  login: string,
  key: string,
  build: () => Omit<
    CredentialRegistrationRequest,
    "id" | "requestedAt" | "expiresAt"
  >,
  signal: AbortSignal | undefined,
  ttlMs: number,
): Promise<CredentialRegistrationResult> {
  const open = pending.get(sessionId);
  if (open) {
    if (open.login !== login.toLowerCase() || open.key !== key)
      throw new Error(
        `this session already has an open credential request for "${open.request.service}"`,
      );
    announce(sessionId, open.request);
    return wait(open, signal);
  }
  const now = Date.now();
  const request: CredentialRegistrationRequest = {
    id: crypto.randomUUID(),
    ...build(),
    requestedAt: now,
    expiresAt: now + ttlMs,
  };
  const entry: Pending = {
    request,
    answering: false,
    login: login.toLowerCase(),
    key,
    waiters: new Set(),
    timer: setTimeout(function expire() {
      // A save in flight wins over expiry; look again once it lands.
      if (entry.answering) entry.timer = setTimeout(expire, 1_000);
      else settle(sessionId, entry, { status: "expired" });
    }, ttlMs),
  };
  pending.set(sessionId, entry);
  audit({
    kind: "keychain_registration_requested",
    request_id: request.id,
    session_id: sessionId,
    service: request.service,
    host: request.host,
    owner: request.owner,
    ...(request.action ? { action: request.action } : {}),
    ...(request.credentialId ? { credential_id: request.credentialId } : {}),
  });
  announce(sessionId, request);
  return wait(entry, signal);
}

/**
 * Open a request and wait for the driver to answer it. Asking again for the
 * service and host of this session's open card waits on that card. Throws
 * (before any card appears) on an invalid spec, a service slug already in
 * the keychain, or a different open request in the same session.
 */
export function requestCredentialRegistration(
  sessionId: string,
  input: { owner: string; login: string; spec: CredentialSpec },
  signal?: AbortSignal,
  ttlMs = CREDENTIAL_REGISTRATION_TTL_MS,
): Promise<CredentialRegistrationResult> {
  requireDriver(sessionId, input);
  const key = [
    "register",
    input.spec.service.trim().toLowerCase(),
    input.spec.kind ?? "api",
    credentialSpecHost(input.spec),
  ].join(" ");
  return openOrJoin(
    sessionId,
    input.login,
    key,
    () => {
      const description = displaySafe(input.spec.description);
      const spec = normalizeCredentialSpec({
        ...input.spec,
        ...(description !== undefined ? { description } : {}),
      });
      return { ...spec, owner: input.owner };
    },
    signal,
    ttlMs,
  );
}

/** What update_credential may change. Omitted fields keep their value; an
 *  empty description or list clears it. */
export type CredentialPatch = Partial<Omit<CredentialSpec, "service" | "kind">>;

/** A credential the driver owns, by id or service slug, or an error safe to
 *  show the agent. */
function ownedBy(ref: string, owner: string): KeychainCredentialMeta {
  const credential = findCredential(ref);
  if (!credential) throw new Error(`no credential matches "${ref}"`);
  if (!isCredentialOwner(credential.id, owner))
    throw new Error(
      `"${credential.service}" belongs to ${credential.owner}; only they can change it, from a session they drive or in Settings → Account`,
    );
  return credential;
}

/**
 * Ask the driver to replace a credential's secret and/or metadata, and wait
 * for them to confirm it on the card. The driver must own the credential.
 * With no metadata change, the card requires a new secret; with one, a new
 * secret is optional unless `rotateSecret`. Throws before any card appears
 * on an unknown or someone else's credential, or metadata that would not
 * validate.
 */
export function requestCredentialUpdate(
  sessionId: string,
  input: {
    owner: string;
    login: string;
    credential: string;
    patch: CredentialPatch;
    rotateSecret?: boolean;
  },
  signal?: AbortSignal,
  ttlMs = CREDENTIAL_REGISTRATION_TTL_MS,
): Promise<CredentialRegistrationResult> {
  requireDriver(sessionId, input);
  const current = ownedBy(input.credential, input.owner);
  return openOrJoin(
    sessionId,
    input.login,
    `update ${current.id}`,
    () => {
      const before = credentialSpecOf(current);
      const { patch } = input;
      const description =
        patch.description !== undefined
          ? displaySafe(patch.description)
          : undefined;
      const merged: CredentialSpec = {
        ...before,
        // A login's host follows its sign-in page.
        ...(current.kind === "login" && patch.loginUrl !== undefined
          ? { host: undefined }
          : {}),
        ...Object.fromEntries(
          Object.entries(patch).filter(([, value]) => value !== undefined),
        ),
        ...(description !== undefined ? { description } : {}),
        ...(patch.injection
          ? { injection: { ...before.injection, ...patch.injection } }
          : {}),
      };
      const after = normalizeCredentialSpec(merged, current.id);
      const changed = changedCredentialFields(before, after);
      const requireSecret = input.rotateSecret === true || !changed.length;
      return {
        ...after,
        owner: input.owner,
        action: "update" as const,
        credentialId: current.id,
        ...(changed.length
          ? {
              changed,
              previous: Object.fromEntries(
                changed.map((field) => [field, before[field]]),
              ),
            }
          : {}),
        requireSecret,
      };
    },
    signal,
    ttlMs,
  );
}

/**
 * Ask the driver to confirm removing a credential they own, and wait. Its
 * active grants are revoked when they confirm.
 */
export function requestCredentialDeletion(
  sessionId: string,
  input: { owner: string; login: string; credential: string },
  signal?: AbortSignal,
  ttlMs = CREDENTIAL_REGISTRATION_TTL_MS,
): Promise<CredentialRegistrationResult> {
  requireDriver(sessionId, input);
  const current = ownedBy(input.credential, input.owner);
  return openOrJoin(
    sessionId,
    input.login,
    `delete ${current.id}`,
    () => ({
      ...credentialSpecOf(current),
      owner: input.owner,
      action: "delete" as const,
      credentialId: current.id,
    }),
    signal,
    ttlMs,
  );
}

export function pendingCredentialRegistration(
  sessionId: string,
): { request: CredentialRegistrationRequest; login: string } | null {
  const entry = pending.get(sessionId);
  return entry ? { request: entry.request, login: entry.login } : null;
}

function answerable(
  sessionId: string,
  requestId: string,
  login: string,
): Pending {
  const entry = pending.get(sessionId);
  if (!entry || entry.request.id !== requestId || entry.answering)
    throw new CredentialRegistrationError(
      "This request is no longer open",
      409,
    );
  if (!login || login.toLowerCase() !== entry.login)
    throw new CredentialRegistrationError(
      `Only ${entry.request.owner} can answer this request`,
      403,
    );
  return entry;
}

/**
 * The driver's answer. Registers through addCredentialAsync (the request
 * handler runs on the gateway thread, so the store is written without
 * blocking it) with them as owner, or applies the update or deletion they
 * confirmed, and hands the waiting tool call metadata only. On a validation
 * or write error (empty secret, a slug taken meanwhile, a credential deleted
 * meanwhile) the request stays open for another try or a decline.
 */
export async function submitCredentialRegistration(
  sessionId: string,
  requestId: string,
  login: string,
  secret: unknown,
): Promise<KeychainCredentialMeta> {
  const entry = answerable(sessionId, requestId, login);
  const {
    id: _id,
    owner,
    requestedAt: _r,
    expiresAt: _e,
    action,
    credentialId,
    changed: _c,
    previous: _p,
    requireSecret,
    ...spec
  } = entry.request;
  const pasted = typeof secret === "string" && secret.trim() ? secret : null;
  if (action !== "delete") {
    if (!pasted && (action !== "update" || requireSecret))
      throw new CredentialRegistrationError("Paste the secret first");
    if (pasted && pasted.length > MAX_SECRET_LENGTH)
      throw new CredentialRegistrationError("That secret is too long");
  }
  let result: CredentialRegistrationResult;
  entry.answering = true;
  try {
    if (action === "delete") {
      const credential = await deleteCredentialAsync(credentialId!, owner);
      if (!credential) throw new Error("that credential no longer exists");
      result = { status: "deleted", credential };
    } else if (action === "update") {
      result = {
        status: "updated",
        update: await updateCredentialAsync(credentialId!, owner, {
          spec,
          ...(pasted ? { secret: pasted } : {}),
        }),
      };
    } else {
      result = {
        status: "registered",
        credential: await addCredentialAsync({
          ...spec,
          owner,
          secret: pasted!,
        }),
      };
    }
  } catch (error) {
    entry.answering = false;
    // The keychain's messages describe the spec or the store, never the
    // secret.
    throw new CredentialRegistrationError(
      error instanceof Error ? error.message : "Couldn't save the credential",
      409,
    );
  }
  entry.answering = false;
  settle(sessionId, entry, result);
  return result.status === "registered"
    ? result.credential
    : result.status === "updated"
      ? result.update.credential
      : result.credential;
}

export function declineCredentialRegistration(
  sessionId: string,
  requestId: string,
  login: string,
): void {
  settle(sessionId, answerable(sessionId, requestId, login), {
    status: "declined",
  });
}
