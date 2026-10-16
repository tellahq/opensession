/** Worker-side broker algorithms over an atomic store and explicit transport.
 * Host trust is disclosed separately; this module makes no isolation claim. */
import { isGithubAccountId } from "../../shared/access-scope";
import type {
  PersonalGithubBroker,
  PersonalBrokerAuthority,
  PersonalAppRef,
  PersonalUserGrantView,
  BrokerRefreshGrantResult,
} from "./broker";
import type { PersonalGithubApi } from "./github-api";
import { buildGithubAppJwt } from "./jwt";
import type {
  PersonalAppRecord,
  PersonalAppSecrets,
  PersonalUserGrant,
  DiscoveredRepository,
  PersonalInstallation,
} from "./types";

export interface StoredPersonalApp {
  app: PersonalAppRecord;
  secrets: PersonalAppSecrets;
  rev: number;
  lifecycle: "active" | "revoking";
  grant: { value: PersonalUserGrant; rev: number } | null;
  installation: PersonalInstallation | null;
  repositories: readonly DiscoveredRepository[];
  accessRevision: number;
  /** Failed uncommitted token cleanup; never exposed to gateway. Bounded. */
  cleanupTokens: string[];
  projectedTokens?: { token: string; expiresAt: number }[];
}

export interface PersonalBrokerStore {
  /** Values are detached copies. Never leak mutable internal storage. */
  read(owner: number): Promise<StoredPersonalApp | null>;
  /** Unique-create when expectedRevision=null. Owner/App id uniqueness and
   * revision checked atomically. New App record ids are never reused. */
  compareAndSet(
    owner: number,
    expectedRevision: number | null,
    next: StoredPersonalApp | null,
  ): Promise<boolean>;
  /** Locks must be shared by all broker clients/instances, bounded, and removed
   * once idle. These are local broker callbacks, never executable RPC input.
   * owner and grant lanes are distinct: owner may acquire grant, not vice versa. */
  withLock<T>(key: string, work: () => Promise<T>): Promise<T>;
}

export interface PersonalRevocationSink {
  /** Persist deny before this callback. Must revoke active/descendant leases
   * and private catalog access, await acknowledgements, and be retry-safe. */
  revoke(ref: PersonalAppRef): Promise<void>;
  /** Reconcile catalog/runtime against numeric repo ids. Called while App is
   * durably revoking; failure leaves it denied. Never authorizes a shared run. */
  reconcile(
    ref: PersonalAppRef,
    installationId: number,
    repositoryIds: readonly number[],
    accessRevision: number,
  ): Promise<void>;
}

function view(value: PersonalUserGrant): PersonalUserGrantView {
  const { refreshToken, ...rest } = value;
  return { ...rest, hasRefreshToken: !!refreshToken };
}

export function createPersonalGithubBrokerCore(input: {
  store: PersonalBrokerStore;
  api: PersonalGithubApi;
  revocations: PersonalRevocationSink;
  authority: PersonalBrokerAuthority;
  now?: () => number;
}): PersonalGithubBroker {
  const { store, api, revocations, authority } = input;
  const now = input.now ?? Date.now;
  const readRef = async (ref: PersonalAppRef) => {
    if (!isGithubAccountId(ref.ownerGithubAccountId)) return null;
    const record = await store.read(ref.ownerGithubAccountId);
    return record?.app.recordId === ref.recordId &&
      record.app.ownerGithubAccountId === ref.ownerGithubAccountId
      ? record
      : null;
  };
  const write = async (old: StoredPersonalApp, next: StoredPersonalApp) => {
    next.rev = old.rev + 1;
    if (
      !(await store.compareAndSet(old.app.ownerGithubAccountId, old.rev, next))
    )
      throw new Error("Personal storage conflict");
  };
  const grantLock = <T>(ref: PersonalAppRef, work: () => Promise<T>) =>
    store.withLock(`grant:${ref.ownerGithubAccountId}:${ref.recordId}`, work);

  const broker: PersonalGithubBroker = {
    authority,
    withOwnerLock(owner, work) {
      if (!isGithubAccountId(owner)) throw new Error("Invalid owner");
      return store.withLock(`owner:${owner}`, work);
    },
    async getApp(owner) {
      if (!isGithubAccountId(owner)) return null;
      const stored = await store.read(owner);
      return stored?.app.ownerGithubAccountId === owner
        ? {
            app: stored.app,
            rev: stored.rev,
            lifecycle: stored.lifecycle,
            installation: stored.installation,
          }
        : null;
    },
    async createApp(app, secrets) {
      if (
        !isGithubAccountId(app.ownerGithubAccountId) ||
        !isGithubAccountId(app.githubAppId) ||
        app.public !== false ||
        app.webhooks !== "disabled"
      )
        return { status: "failed", error: "Invalid App" };
      try {
        const saved = await store.compareAndSet(
          app.ownerGithubAccountId,
          null,
          {
            app,
            secrets,
            rev: 1,
            lifecycle: "active",
            grant: null,
            installation: null,
            repositories: [],
            accessRevision: 1,
            cleanupTokens: [],
          },
        );
        return saved ? { status: "created", rev: 1 } : { status: "exists" };
      } catch {
        return { status: "failed", error: "Private storage unavailable" };
      }
    },
    async deleteApp(ref, expectedRev) {
      const record = await readRef(ref);
      if (!record) return "missing";
      if (
        record.rev !== expectedRev ||
        record.lifecycle !== "revoking" ||
        record.grant ||
        record.cleanupTokens.length ||
        record.projectedTokens?.length
      )
        return "conflict";
      return (await store.compareAndSet(
        ref.ownerGithubAccountId,
        expectedRev,
        null,
      ))
        ? "deleted"
        : "conflict";
    },
    async signAppJwt(ref, nowSeconds) {
      const record = await readRef(ref);
      return record?.lifecycle === "active"
        ? buildGithubAppJwt({
            issuer: record.app.clientId,
            privateKeyPem: record.secrets.privateKeyPem,
            nowSeconds,
          })
        : null;
    },
    async retainInstallationCleanup(ref, token) {
      const record = await readRef(ref);
      if (!record || (record.projectedTokens?.length ?? 0) >= 128)
        throw new Error("Installation cleanup unavailable");
      await write(record, {
        ...record,
        lifecycle: "revoking",
        accessRevision: record.accessRevision + 1,
        projectedTokens: [
          ...(record.projectedTokens ?? []),
          { token, expiresAt: Number.MAX_SAFE_INTEGER },
        ],
      });
    },
    async getAccessRevision(ref) {
      const record = await readRef(ref);
      return record?.lifecycle === "active" ? record.accessRevision : null;
    },
    async trackInstallationToken(
      ref,
      token,
      expiresAt,
      expectedAccessRevision,
    ) {
      const record = await readRef(ref);
      if (
        !record ||
        record.lifecycle !== "active" ||
        record.accessRevision !== expectedAccessRevision ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now()
      )
        throw new Error("Credential projection revoked");
      const tokens = (record.projectedTokens ?? []).filter(
        (item) => item.expiresAt > now(),
      );
      if (tokens.length >= 64)
        throw new Error("Too many active installation credentials");
      await write(record, {
        ...record,
        projectedTokens: [...tokens, { token, expiresAt }],
      });
    },
    async getUserGrant(ref) {
      const record = await readRef(ref);
      const grant = record?.grant;
      return record?.lifecycle === "active" &&
        grant?.value.grantedGithubAccountId === ref.ownerGithubAccountId
        ? { grant: view(grant.value), rev: grant.rev }
        : null;
    },
    putUserGrant(ref, grant, expectedRev) {
      return grantLock(ref, async () => {
        const record = await readRef(ref);
        if (!record || record.lifecycle !== "active")
          return { status: "missing_app" as const };
        if (
          grant.grantedGithubAccountId !== ref.ownerGithubAccountId ||
          record.grant !== null ||
          expectedRev !== null
        )
          return {
            status: "conflict" as const,
            current: await broker.getUserGrant(ref),
          };
        const rev = 1;
        await write(record, { ...record, grant: { value: grant, rev } });
        return { status: "committed" as const, rev };
      });
    },
    refreshUserGrant(ref): Promise<BrokerRefreshGrantResult> {
      return grantLock(ref, async () => {
        const record = await readRef(ref);
        if (!record || record.lifecycle !== "active" || !record.grant)
          return { status: "missing" };
        const grant = record.grant.value;
        if (grant.grantedGithubAccountId !== ref.ownerGithubAccountId)
          return { status: "dead", error: "Grant owner mismatch" };
        if (
          grant.refreshFailedAt === null &&
          (grant.expiresAt === null || grant.expiresAt > now() + 60_000)
        )
          return {
            status: "current",
            grant: view(grant),
            rev: record.grant.rev,
          };
        if (
          !grant.refreshToken ||
          grant.refreshFailedAt !== null ||
          (grant.refreshTokenExpiresAt !== null &&
            grant.refreshTokenExpiresAt <= now())
        )
          return { status: "dead", error: "Reconnect required" };
        const refreshed = await api.refreshUserToken({
          clientId: record.app.clientId,
          clientSecret: record.secrets.clientSecret,
          refreshToken: grant.refreshToken,
        });
        if (!refreshed.ok)
          return { status: "failed", error: "GitHub refresh unavailable" };
        if (refreshed.value.status === "dead") {
          await write(record, {
            ...record,
            grant: {
              rev: record.grant.rev + 1,
              value: { ...grant, refreshFailedAt: now() },
            },
          });
          return { status: "dead", error: "Reconnect required" };
        }
        const token = refreshed.value.grant;
        const user = await api.getAuthenticatedUser(token.accessToken);
        if (
          !user.ok ||
          user.value.id !== ref.ownerGithubAccountId ||
          user.value.type !== "User"
        ) {
          await broker.discardUserToken(ref, token.accessToken);
          return { status: "dead", error: "Refreshed identity mismatch" };
        }
        const value: PersonalUserGrant = {
          ...grant,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt:
            token.expiresInSeconds === null
              ? null
              : now() + token.expiresInSeconds * 1000,
          refreshTokenExpiresAt:
            token.refreshTokenExpiresInSeconds === null
              ? null
              : now() + token.refreshTokenExpiresInSeconds * 1000,
          grantedLogin: user.value.login,
          refreshFailedAt: null,
        };
        // CAS cannot resurrect an App that was disconnected by another client.
        // On conflict revoke the rotated token; never cache it before commit.
        try {
          await write(record, {
            ...record,
            grant: { value, rev: record.grant.rev + 1 },
          });
        } catch {
          await broker.discardUserToken(ref, token.accessToken);
          return { status: "dead", error: "Personal authorization changed" };
        }
        return {
          status: "refreshed",
          grant: view(value),
          rev: record.grant.rev + 1,
        };
      });
    },
    async discardUserToken(ref, accessToken) {
      const record = await readRef(ref);
      if (!record) throw new Error("Token cleanup requires issuing App");
      const revoked = await api.revokeUserToken({
        clientId: record.app.clientId,
        clientSecret: record.secrets.clientSecret,
        accessToken,
      });
      if (revoked.ok) return;
      if (record.cleanupTokens.length >= 64)
        throw new Error("Token cleanup queue full");
      await write(record, {
        ...record,
        lifecycle: "revoking",
        cleanupTokens: [...record.cleanupTokens, accessToken],
      });
      await revocations.revoke(ref);
    },
    revokeUserGrant(ref) {
      return grantLock(ref, async () => {
        const record = await readRef(ref);
        if (!record) return { status: "missing" as const };
        if (record.lifecycle !== "revoking")
          return { status: "failed" as const, error: "Revoke access first" };
        for (const accessToken of record.cleanupTokens) {
          const revoked = await api.revokeUserToken({
            clientId: record.app.clientId,
            clientSecret: record.secrets.clientSecret,
            accessToken,
          });
          if (!revoked.ok)
            return {
              status: "failed" as const,
              error: "Token cleanup needs retry",
            };
        }
        if (record.grant) {
          const revoked = await api.revokeUserGrant({
            clientId: record.app.clientId,
            clientSecret: record.secrets.clientSecret,
            accessToken: record.grant.value.accessToken,
          });
          if (!revoked.ok)
            return {
              status: "failed" as const,
              error: "Grant revoke needs retry",
            };
        }
        await write(record, { ...record, grant: null, cleanupTokens: [] });
        return { status: "revoked" as const };
      });
    },
    async revokeAccess(ref) {
      const record = await readRef(ref);
      if (!record) return;
      if (record.lifecycle !== "revoking")
        await write(record, {
          ...record,
          lifecycle: "revoking",
          accessRevision: record.accessRevision + 1,
        });
      await revocations.revoke(ref);
      const blocked = await readRef(ref);
      if (!blocked) throw new Error("App disappeared during revocation");
      for (const item of blocked.projectedTokens ?? []) {
        if (item.expiresAt <= now()) continue;
        const revoked = await api.revokeInstallationToken(item.token);
        if (!revoked.ok && revoked.status !== 401 && revoked.status !== 404)
          throw new Error("Installation credential revocation needs retry");
      }
      if (blocked.projectedTokens?.length)
        await write(blocked, { ...blocked, projectedTokens: [] });
    },
    async reconcileRepositories(ref, installation, repositories) {
      const installationId = installation.installationId;
      const record = await readRef(ref);
      if (
        !record ||
        record.lifecycle !== "active" ||
        !isGithubAccountId(installationId) ||
        installation.accountGithubAccountId !== ref.ownerGithubAccountId ||
        installation.accountType !== "User" ||
        installation.suspended ||
        installation.repositorySelection !== "selected" ||
        repositories.length > 500 ||
        repositories.some(
          (item) => item.ownerGithubAccountId !== ref.ownerGithubAccountId,
        )
      )
        throw new Error("Invalid reconciliation");
      const before = record.repositories
        .map((item) => item.repositoryId)
        .sort((a, b) => a - b);
      const after = repositories
        .map((item) => item.repositoryId)
        .sort((a, b) => a - b);
      if (new Set(after).size !== after.length)
        throw new Error("Duplicate repository id");
      if (
        record.installation?.installationId === installationId &&
        JSON.stringify(before) === JSON.stringify(after)
      ) {
        await write(record, { ...record, installation, repositories });
        return record.accessRevision;
      }
      await broker.revokeAccess(ref);
      const blocked = await readRef(ref);
      if (!blocked) throw new Error("App missing");
      await revocations.reconcile(
        ref,
        installationId,
        after,
        blocked.accessRevision,
      );
      await write(blocked, {
        ...blocked,
        installation,
        repositories,
        lifecycle: "active",
      });
      return blocked.accessRevision;
    },
  };
  return broker;
}
