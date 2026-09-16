/** Internal App/grant storage and revocation contract. These methods carry
 * credentials and must never be exposed as HTTP/MCP methods. The connection
 * worker owns them; the host's root-capable operators/agents remain trusted.
 * AdmissionGate binds engine to broker, not proof of isolation or repo access.
 * The versioned connection disclosure is independently required before App
 * conversion/storage. Future repository admission needs a real revocation sink. */
import type {
  PersonalAppRecord,
  PersonalAppSecrets,
  PersonalUserGrant,
  DiscoveredRepository,
  PersonalInstallation,
} from "./types";

export type PersonalBrokerRuntimeKind = "shared_trusted_host" | "synthetic";

/** Internal broker identity. Descriptive fields never prove isolation. */
export interface PersonalBrokerAuthority {
  readonly kind: PersonalBrokerRuntimeKind;
  /** Human-readable trust description, safe to log. No secrets. */
  readonly description: string;
}

export interface PersonalAdmissionGate {
  /** True only for an authority this gate itself can vouch for. */
  admit(
    authority: PersonalBrokerAuthority,
    broker: PersonalGithubBroker,
  ): boolean;
}

/** An unwired engine cannot act. Production binds the broker it constructs. */
export const deniedPersonalAdmission: PersonalAdmissionGate = Object.freeze({
  admit(): false {
    return false;
  },
});

/** Addresses one App record for one owner. Every broker operation must verify
 * that `recordId` belongs to `ownerGithubAccountId` and treat a mismatch as
 * missing. A record id alone is never a capability. */
export interface PersonalAppRef {
  ownerGithubAccountId: number;
  recordId: string;
}

/** What leaves the broker about a user grant: the access token (needed to
 * project the person's credential into their own run) and metadata. The
 * refresh token never leaves. */
export type PersonalUserGrantView = Omit<PersonalUserGrant, "refreshToken"> & {
  hasRefreshToken: boolean;
};

export type BrokerAppRecord = {
  app: PersonalAppRecord;
  rev: number;
  lifecycle: "active" | "revoking";
  installation: PersonalInstallation | null;
};
export type BrokerUserGrant = { grant: PersonalUserGrantView; rev: number };

export type BrokerCreateAppResult =
  | { status: "created"; rev: number }
  | { status: "exists" }
  | { status: "failed"; error: string };

export type BrokerDeleteResult = "deleted" | "conflict" | "missing";

export type BrokerPutGrantResult =
  | { status: "committed"; rev: number }
  | { status: "conflict"; current: BrokerUserGrant | null }
  | { status: "missing_app" };

export type BrokerRefreshGrantResult =
  | { status: "refreshed"; grant: PersonalUserGrantView; rev: number }
  | { status: "current"; grant: PersonalUserGrantView; rev: number }
  | { status: "dead"; error: string }
  | { status: "missing" }
  | { status: "failed"; error: string };

export type BrokerRevokeGrantResult =
  | { status: "revoked" }
  | { status: "missing" }
  | { status: "failed"; error: string };

export interface PersonalGithubBroker {
  readonly authority: PersonalBrokerAuthority;

  /** Broker-process mutation lane shared by every service instance. Bound queue
   * depth, reject overflow; never run two callbacks for the same owner at once.
   * Callbacks are local broker code, NOT an RPC accepting executable input. */
  withOwnerLock<T>(
    ownerGithubAccountId: number,
    work: () => Promise<T>,
  ): Promise<T>;

  /** Durable deny barrier FIRST, then cancel/drain active consumers and revoke
   * leases across descendants/catalog/runtime. Idempotent; throws until all
   * required revocations are acknowledged. Remains revoking on failure. */
  revokeAccess(ref: PersonalAppRef): Promise<void>;

  /** Atomically replace the complete discovery snapshot and invalidate prior
   * access revisions/consumers. Only complete bounded snapshots are accepted.
   * Throws on incomplete invalidation; denies affected access before awaiting
   * cleanup. Returns a monotonic, non-reusable access revision. */
  reconcileRepositories(
    ref: PersonalAppRef,
    installation: PersonalInstallation,
    repositories: readonly DiscoveredRepository[],
  ): Promise<number>;

  /** The owner's App record, or null. Exactly one App per owner. */
  getApp(ownerGithubAccountId: number): Promise<BrokerAppRecord | null>;

  /** Atomically create the owner's App with its secrets. `exists` when the
   * owner already has one; nothing may be overwritten or merged. `failed`
   * must leave no partial record or secret behind. */
  createApp(
    app: PersonalAppRecord,
    secrets: PersonalAppSecrets,
  ): Promise<BrokerCreateAppResult>;

  /** Delete the App, its secrets, and every grant under it, atomically, only
   * when the stored revision still matches. */
  deleteApp(
    ref: PersonalAppRef,
    expectedRev: number,
  ): Promise<BrokerDeleteResult>;

  /** Sign an App JWT with the stored private key. The key never leaves the
   * broker. Null when the ref does not resolve. */
  signAppJwt(ref: PersonalAppRef, nowSeconds: number): Promise<string | null>;

  /** Revoke a just-issued but uncommitted token using THIS App's client
   * credentials. Must not revoke the owner's existing grant for a wrong-user
   * token. Keep a private cleanup obligation on transient GitHub failure. */
  discardUserToken(ref: PersonalAppRef, accessToken: string): Promise<void>;

  retainInstallationCleanup(ref: PersonalAppRef, token: string): Promise<void>;
  getAccessRevision(ref: PersonalAppRef): Promise<number | null>;
  trackInstallationToken(
    ref: PersonalAppRef,
    token: string,
    expiresAt: number,
    expectedAccessRevision: number,
  ): Promise<void>;

  getUserGrant(ref: PersonalAppRef): Promise<BrokerUserGrant | null>;

  /** Store a grant obtained through the App's public device flow. Compare-
   * and-set: `expectedRev` null means "no grant stored yet". Initial grants
   * never silently replace an existing grant; rotation uses refreshUserGrant.
   * The stored `grantedGithubAccountId` must equal `ref.ownerGithubAccountId`. */
  putUserGrant(
    ref: PersonalAppRef,
    grant: PersonalUserGrant,
    expectedRev: number | null,
  ): Promise<BrokerPutGrantResult>;

  /** Broker-owned confidential refresh: the broker uses its stored client
   * secret and refresh token, rotates them atomically, and returns only the
   * view. `current` when the stored token did not need refreshing. */
  refreshUserGrant(ref: PersonalAppRef): Promise<BrokerRefreshGrantResult>;

  /** Broker-owned confidential revoke at GitHub followed by deletion of the
   * stored grant. `revoked` also covers a grant GitHub no longer knows. */
  revokeUserGrant(ref: PersonalAppRef): Promise<BrokerRevokeGrantResult>;
}
