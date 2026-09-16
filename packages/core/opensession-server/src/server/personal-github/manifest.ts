/**
 * Personal App manifest transactions.
 *
 * A transaction is the server-side half of GitHub's "create App from
 * manifest" redirect. It is bound to the verified owner, the browser origin,
 * the web session that started it, and one operation; it expires; and it is
 * consumed exactly once, atomically, before any code is exchanged. A record
 * presented by anyone, for any reason, is consumed at presentation so a
 * concurrent or replayed callback finds nothing. No credential is ever kept
 * here; a lost transaction only costs the person a restart.
 */
import type { ConnectionAcknowledgement } from "./disclosure";
import { randomBytes } from "node:crypto";
import { isGithubAccountId } from "../../shared/access-scope";
import { PERSONAL_APP_PERMISSIONS } from "./permissions";
import { deny, type PersonalGithubResult } from "./errors";

export const PERSONAL_MANIFEST_OPERATION = "create_personal_github_app";
export const PERSONAL_MANIFEST_CALLBACK_PATH =
  "/api/personal/github/manifest/callback";
export const DEFAULT_MANIFEST_TTL_MS = 15 * 60_000;
export const MAX_PENDING_MANIFESTS = 64;
export const MAX_PENDING_MANIFESTS_PER_OWNER = 3;
const STATE_BYTES = 32;
const MAX_ORIGIN_LENGTH = 512;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_PREFIX_LENGTH = 128;

export interface ManifestBinding {
  ownerGithubAccountId: number;
  /** `https://host[:port]` of the browser that started the flow. */
  origin: string;
  /** Opaque web-session identifier from the server-owned cookie or bearer,
   * never a client-claimed field. The callback must arrive on the same one. */
  browserSessionId: string;
  operation: typeof PERSONAL_MANIFEST_OPERATION;
}

export interface ManifestTransaction extends ManifestBinding {
  acknowledgement?: ConnectionAcknowledgement;
  state: string;
  publicPrefix: string;
  createdAt: number;
  expiresAt: number;
}

export interface ManifestTransactionsOptions {
  now?: () => number;
  ttlMs?: number;
  randomState?: () => string;
  maxPending?: number;
  maxPendingPerOwner?: number;
}

function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_ORIGIN_LENGTH)
    return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.origin !== value) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function normalizePrefix(value: unknown): string | null {
  if (value === "" || value === undefined) return "";
  if (
    typeof value !== "string" ||
    value.length > MAX_PREFIX_LENGTH ||
    !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(value)
  )
    return null;
  return value;
}

function normalizeSessionId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SESSION_ID_LENGTH &&
    !/\s/.test(value)
    ? value
    : null;
}

/** A GitHub App manifest for one person's private App: never public, no
 * webhook, no event subscriptions, and a redirect back to the personal
 * callback rather than the instance setup callback. */
export function buildPersonalAppManifest(input: {
  origin: string;
  publicPrefix: string;
  nameSuffix: string;
}): Record<string, unknown> {
  const suffix = input.nameSuffix.replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return {
    name: `Open Session personal ${suffix}`.trim(),
    url: input.origin,
    redirect_url: `${input.origin}${input.publicPrefix}${PERSONAL_MANIFEST_CALLBACK_PATH}`,
    public: false,
    default_permissions: PERSONAL_APP_PERMISSIONS,
    default_events: [],
    hook_attributes: { active: false },
  };
}

export function createManifestTransactions(
  options: ManifestTransactionsOptions = {},
) {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_MANIFEST_TTL_MS;
  const randomState =
    options.randomState ??
    (() => randomBytes(STATE_BYTES).toString("base64url"));
  const maxPending = options.maxPending ?? MAX_PENDING_MANIFESTS;
  const maxPerOwner =
    options.maxPendingPerOwner ?? MAX_PENDING_MANIFESTS_PER_OWNER;
  const pending = new Map<string, ManifestTransaction>();

  function prune(): void {
    const at = now();
    for (const [state, transaction] of pending) {
      if (transaction.expiresAt <= at) pending.delete(state);
    }
  }

  return {
    /** Start a transaction. Never evicts another owner's pending state to
     * make room: an instance-wide cap denies instead. */
    begin(input: {
      acknowledgement?: ConnectionAcknowledgement;
      ownerGithubAccountId: number;
      origin: string;
      publicPrefix: string;
      browserSessionId: string;
    }): PersonalGithubResult<{
      state: string;
      action: string;
      manifest: string;
      expiresAt: number;
    }> {
      if (!isGithubAccountId(input.ownerGithubAccountId))
        return deny(
          "invalid_principal",
          "A verified GitHub sign-in is required.",
        );
      const origin = normalizeOrigin(input.origin);
      const publicPrefix = normalizePrefix(input.publicPrefix);
      const browserSessionId = normalizeSessionId(input.browserSessionId);
      if (!origin || publicPrefix === null || !browserSessionId)
        return deny(
          "request_invalid",
          "Open Session needs a valid HTTP origin.",
        );
      prune();
      let ownerPending = 0;
      for (const transaction of pending.values()) {
        if (transaction.ownerGithubAccountId === input.ownerGithubAccountId)
          ownerPending++;
      }
      if (ownerPending >= maxPerOwner || pending.size >= maxPending)
        return deny(
          "manifest_limit",
          "Too many App registrations are pending. Try again in a few minutes.",
        );
      const state = randomState();
      if (pending.has(state))
        return deny("manifest_limit", "Could not start an App registration.");
      const createdAt = now();
      const transaction: ManifestTransaction = {
        state,
        acknowledgement: input.acknowledgement,
        ownerGithubAccountId: input.ownerGithubAccountId,
        origin,
        publicPrefix,
        browserSessionId,
        operation: PERSONAL_MANIFEST_OPERATION,
        createdAt,
        expiresAt: createdAt + ttlMs,
      };
      pending.set(state, transaction);
      const action = new URL("https://github.com/settings/apps/new");
      action.searchParams.set("state", state);
      return {
        ok: true,
        state,
        action: action.toString(),
        manifest: JSON.stringify(
          buildPersonalAppManifest({
            origin,
            publicPrefix,
            nameSuffix: state.slice(0, 6),
          }),
        ),
        expiresAt: transaction.expiresAt,
      };
    },

    /** Consume a transaction. The record is removed before any check, so a
     * second presentation, concurrent or later, is denied as replayed. All
     * bindings must match the consumer; a mismatch also destroys the record. */
    consume(input: {
      state: unknown;
      ownerGithubAccountId: number;
      origin: string;
      browserSessionId: string;
      operation: string;
    }): PersonalGithubResult<{ transaction: ManifestTransaction }> {
      const state =
        typeof input.state === "string" && input.state.length <= 128
          ? input.state
          : "";
      const transaction = state ? pending.get(state) : undefined;
      if (!transaction)
        return deny(
          "manifest_replayed",
          "This App registration is missing, expired, or already used.",
        );
      pending.delete(state);
      if (transaction.expiresAt <= now())
        return deny("manifest_expired", "This App registration expired.");
      if (
        !isGithubAccountId(input.ownerGithubAccountId) ||
        transaction.ownerGithubAccountId !== input.ownerGithubAccountId
      )
        return deny(
          "manifest_owner_mismatch",
          "This App registration was started by a different account.",
        );
      if (transaction.origin !== normalizeOrigin(input.origin))
        return deny(
          "manifest_origin_mismatch",
          "This App registration was started from a different address.",
        );
      if (
        transaction.browserSessionId !==
        normalizeSessionId(input.browserSessionId)
      )
        return deny(
          "manifest_session_mismatch",
          "This App registration was started from a different sign-in.",
        );
      if (transaction.operation !== input.operation)
        return deny(
          "manifest_operation_mismatch",
          "This App registration is for a different operation.",
        );
      return { ok: true, transaction };
    },

    cancelOwner(owner: number): void {
      for (const [state, transaction] of pending)
        if (transaction.ownerGithubAccountId === owner) pending.delete(state);
    },

    pendingCount(): number {
      prune();
      return pending.size;
    },
  };
}

export type ManifestTransactions = ReturnType<
  typeof createManifestTransactions
>;
