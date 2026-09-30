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
 */
import { broadcastToSession } from "./ws-hub";
import { audit } from "./audit";
import {
  addCredentialAsync,
  normalizeCredentialHost,
  normalizeCredentialSpec,
  type CredentialSpec,
  type KeychainCredentialMeta,
  type NormalizedCredentialSpec,
} from "./keychain";

export interface CredentialRegistrationRequest extends NormalizedCredentialSpec {
  id: string;
  /** Roster name of the driver, who will own the credential. */
  owner: string;
  requestedAt: number;
  expiresAt: number;
}

export type CredentialRegistrationResult =
  | { status: "registered"; credential: KeychainCredentialMeta }
  | { status: "declined" }
  | { status: "expired" }
  /** The waiting call was cancelled; the card is still open. */
  | { status: "pending"; request: CredentialRegistrationRequest };

type Pending = {
  request: CredentialRegistrationRequest;
  /** Lower-cased GitHub login of the only person who may answer. */
  login: string;
  /** Tool calls waiting on this card. */
  waiters: Set<(result: CredentialRegistrationResult) => void>;
  timer: ReturnType<typeof setTimeout>;
  /** Set while a submitted secret is being saved, so a second answer from
   *  another tab cannot race it. */
  answering: boolean;
};

/** Long enough to find a key in a provider dashboard. */
export const CREDENTIAL_REGISTRATION_TTL_MS = 15 * 60 * 1000;
/** Keychain secrets are API keys and tokens, not documents. */
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
    ...(result.status === "registered"
      ? { credential_id: result.credential.id }
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
  if (!sessionId || !input.login || !input.owner)
    throw new Error("a verified teammate must be driving this session");
  const open = pending.get(sessionId);
  if (open) {
    const same =
      open.login === input.login.toLowerCase() &&
      open.request.service === input.spec.service.trim().toLowerCase() &&
      open.request.host === normalizeCredentialHost(input.spec.host);
    if (!same)
      throw new Error(
        `this session already has an open credential request for "${open.request.service}"`,
      );
    announce(sessionId, open.request);
    return wait(open, signal);
  }
  // The description is model-authored and shown to a person: no control or
  // bidi-override characters that could make the card say something else.
  const description = input.spec.description
    ?.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, 240);
  const spec = normalizeCredentialSpec({
    ...input.spec,
    ...(description !== undefined ? { description } : {}),
  });
  const now = Date.now();
  const request: CredentialRegistrationRequest = {
    id: crypto.randomUUID(),
    ...spec,
    owner: input.owner,
    requestedAt: now,
    expiresAt: now + ttlMs,
  };
  const entry: Pending = {
    request,
    answering: false,
    login: input.login.toLowerCase(),
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
  });
  announce(sessionId, request);
  return wait(entry, signal);
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
 * blocking it) with them as owner, and hands the waiting tool call metadata
 * only. On a validation or write error (empty secret, a slug taken
 * meanwhile) the request stays open for another try or a decline.
 */
export async function submitCredentialRegistration(
  sessionId: string,
  requestId: string,
  login: string,
  secret: unknown,
): Promise<KeychainCredentialMeta> {
  const entry = answerable(sessionId, requestId, login);
  if (typeof secret !== "string" || !secret.trim())
    throw new CredentialRegistrationError("Paste the secret first");
  if (secret.length > MAX_SECRET_LENGTH)
    throw new CredentialRegistrationError("That secret is too long");
  const {
    id: _id,
    owner,
    requestedAt: _r,
    expiresAt: _e,
    ...spec
  } = entry.request;
  let credential: KeychainCredentialMeta;
  entry.answering = true;
  try {
    credential = await addCredentialAsync({ ...spec, owner, secret });
  } catch (error) {
    entry.answering = false;
    // addCredentialAsync's messages describe the spec or the store, never
    // the secret.
    throw new CredentialRegistrationError(
      error instanceof Error ? error.message : "Couldn't save the credential",
      409,
    );
  }
  entry.answering = false;
  settle(sessionId, entry, { status: "registered", credential });
  return credential;
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
