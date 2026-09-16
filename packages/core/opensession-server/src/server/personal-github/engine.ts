import { isPersonalCredentialKind } from "./repository-coordinator";
import type {
  PersonalRepositoryCoordinator,
  PersonalCredentialKind,
  PersonalRepositoryCredential,
} from "./repository-coordinator";
import { PERSONAL_APP_PERMISSIONS } from "./permissions";
/** Worker-side connection orchestration. Owner identity and versioned informed
 * consent are independent of host trust. No repository/session admission is
 * granted by the connection facade. No ambient transport or storage. */
import {
  createConnectionDisclosure,
  acknowledgementMatches,
  PERSONAL_CONNECTION_DISCLOSURE,
} from "./disclosure";
import { randomUUID } from "node:crypto";
import { isGithubAccountId } from "../../shared/access-scope";
import {
  deniedPersonalAdmission,
  type PersonalAdmissionGate,
  type PersonalGithubBroker,
  type BrokerAppRecord,
  type PersonalAppRef,
} from "./broker";
import { deny, type PersonalGithubResult } from "./errors";
import type { PersonalGithubApi } from "./github-api";
import {
  createManifestTransactions,
  buildPersonalAppManifest,
  PERSONAL_MANIFEST_OPERATION,
  type ManifestBinding,
} from "./manifest";
import type {
  DiscoveredRepository,
  PersonalAppStatusDto,
  PersonalRepositoryDescriptor,
} from "./types";

export interface PersonalGithubServiceDependencies {
  repositoryCoordinator?: PersonalRepositoryCoordinator;
  broker: PersonalGithubBroker;
  api: PersonalGithubApi;
  /** Internal broker identity binding. This is not isolation attestation or
   * permission to admit repositories. The production facade owns this binding. */
  admission?: PersonalAdmissionGate;
  now?: () => number;
}

type Context = Omit<ManifestBinding, "operation">;
type Discovery = {
  repositories: readonly DiscoveredRepository[];
  installationId: number;
  accessRevision: number;
};

type DeviceTransaction = Context & {
  recordId: string;
  deviceCode: string;
  expiresAt: number;
  nextPollAt: number;
  interval: number;
};

const refOf = (record: BrokerAppRecord): PersonalAppRef => ({
  ownerGithubAccountId: record.app.ownerGithubAccountId,
  recordId: record.app.recordId,
});

export function createBrokerPersonalGithubEngine(
  deps: PersonalGithubServiceDependencies,
) {
  const { broker, api } = deps;
  const admission = deps.admission ?? deniedPersonalAdmission;
  const now = deps.now ?? Date.now;
  // These maps contain transaction secrets: instantiate only in broker memory.
  // Restart deliberately invalidates all pending handshakes.
  const manifests = createManifestTransactions({ now });
  const disclosure = createConnectionDisclosure(now);
  const devices = new Map<string, DeviceTransaction>();

  async function guarded<T>(
    owner: number,
    work: () => Promise<PersonalGithubResult<T>>,
  ): Promise<PersonalGithubResult<T>> {
    if (!isGithubAccountId(owner))
      return deny("invalid_principal", "Verified sign-in required.");
    try {
      if (!admission.admit(broker.authority, broker))
        return deny(
          "runtime_unavailable",
          "Personal connection service unavailable.",
        );
      return await broker.withOwnerLock(owner, async () => {
        if (!admission.admit(broker.authority, broker))
          return deny(
            "runtime_unavailable",
            "Personal connection service unavailable.",
          );
        const result = await work();
        if (!admission.admit(broker.authority, broker))
          return deny(
            "runtime_unavailable",
            "Personal connection service unavailable.",
          );
        return result;
      });
    } catch {
      // Never serialize exceptions from transport, credentials or storage.
      return deny(
        "storage_failed",
        "Private operation failed. Retry or disconnect.",
      );
    }
  }

  async function active(owner: number): Promise<BrokerAppRecord | null> {
    const record = await broker.getApp(owner);
    return record &&
      record.app.ownerGithubAccountId === owner &&
      record.lifecycle === "active"
      ? record
      : null;
  }

  async function discover(
    record: BrokerAppRecord,
  ): Promise<PersonalGithubResult<Discovery>> {
    const ref = refOf(record);
    const jwt = await broker.signAppJwt(ref, Math.floor(now() / 1000));
    if (!jwt) {
      await broker.revokeAccess(ref);
      return deny("credential_denied", "Personal App credential unavailable.");
    }
    const installations = await api.listAppInstallations(jwt);
    if (!installations.ok) {
      await broker.revokeAccess(ref);
      return deny("github_unavailable", "Cannot verify personal installation.");
    }
    if (
      installations.value.some(
        (item) => item.account.id !== ref.ownerGithubAccountId,
      )
    ) {
      await broker.revokeAccess(ref);
      return deny(
        "installation_wrong_owner",
        "Personal App has an unexpected installation owner.",
      );
    }
    const matches = installations.value.filter(
      (item) => item.account.id === ref.ownerGithubAccountId,
    );
    if (matches.length !== 1) {
      // Before any verified installation exists there is no repository grant
      // to invalidate. Let a newly created App be installed and checked again.
      if (matches.length > 1 || record.installation)
        await broker.revokeAccess(ref);
      return deny(
        matches.length > 1 ? "installation_ambiguous" : "installation_missing",
        "Install this App on your personal account.",
      );
    }
    const installation = matches[0]!;
    if (
      installation.account.type !== "User" ||
      installation.targetType !== "User" ||
      installation.repositorySelection !== "selected" ||
      installation.suspended
    ) {
      await broker.revokeAccess(ref);
      return deny(
        installation.suspended
          ? "installation_suspended"
          : "installation_wrong_owner",
        "Select repositories on your personal User account.",
      );
    }
    const minted = await api.mintInstallationToken({
      appJwt: jwt,
      installationId: installation.installationId,
      permissions: { metadata: "read" },
    });
    if (!minted.ok) {
      await broker.revokeAccess(ref);
      return deny(
        "credential_denied",
        "Cannot access this personal installation.",
      );
    }
    // No token cache. Discovery tokens never enter DTOs, and are revoked even
    // on parse/validation failures. Broker network policy is the only egress.
    let listed: Awaited<
      ReturnType<PersonalGithubApi["listInstallationRepositories"]>
    >;
    try {
      listed = await api.listInstallationRepositories(minted.value.token);
    } finally {
      const revoked = await api.revokeInstallationToken(minted.value.token);
      if (!revoked.ok) await broker.revokeAccess(ref);
    }
    if ((await active(ref.ownerGithubAccountId))?.app.recordId !== ref.recordId)
      return deny("revoked_during_operation", "Personal access revoked.");
    if (!listed.ok || listed.value.truncated) {
      await broker.revokeAccess(ref);
      return deny(
        "github_unavailable",
        "Cannot obtain a complete bounded repository list.",
      );
    }
    const ids = new Set<number>();
    const repositories: DiscoveredRepository[] = [];
    for (const item of listed.value.repositories) {
      if (
        item.owner.id !== ref.ownerGithubAccountId ||
        ids.has(item.repositoryId)
      ) {
        await broker.revokeAccess(ref);
        return deny(
          "repository_owner_mismatch",
          "Repository ownership could not be verified.",
        );
      }
      ids.add(item.repositoryId);
      repositories.push({
        repositoryId: item.repositoryId,
        name: item.name,
        fullName: item.fullName,
        ownerGithubAccountId: item.owner.id,
        private: item.private,
        defaultBranch: item.defaultBranch,
      });
    }
    const accessRevision = await broker.reconcileRepositories(
      ref,
      {
        installationId: installation.installationId,
        accountGithubAccountId: installation.account.id,
        accountLogin: installation.account.login,
        accountType: "User",
        repositorySelection: "selected",
        suspended: false,
      },
      repositories,
    );
    return {
      ok: true,
      repositories,
      installationId: installation.installationId,
      accessRevision,
    };
  }

  return {
    acknowledgeDisclosure(
      context: Context,
      input: { version: unknown; accepted: unknown },
    ) {
      return guarded(context.ownerGithubAccountId, async () =>
        disclosure.acknowledge(context, input),
      );
    },
    beginManifest(context: Context, receipt?: string) {
      return guarded(context.ownerGithubAccountId, async () => {
        if (await broker.getApp(context.ownerGithubAccountId))
          return deny(
            "app_exists",
            "Disconnect the existing personal App first.",
          );
        const acknowledgement = disclosure.consume(context, receipt);
        if (!acknowledgement)
          return deny(
            "disclosure_required",
            "Read and accept the shared-server disclosure before connecting.",
          );
        return manifests.begin({
          ...context,
          publicPrefix: "",
          acknowledgement,
        });
      });
    },

    completeManifest(
      context: Context,
      input: { state: string; code: string; operation: string },
    ) {
      return guarded(context.ownerGithubAccountId, async () => {
        // Atomic synchronous consume precedes even the App existence check.
        const consumed = manifests.consume({
          ...context,
          state: input.state,
          operation: input.operation,
        });
        if (!consumed.ok) return consumed;
        if (
          !acknowledgementMatches(
            consumed.transaction.acknowledgement,
            context,
            now(),
          )
        )
          return deny(
            "disclosure_required",
            "The connection disclosure acknowledgement expired. Start again.",
          );
        if (await broker.getApp(context.ownerGithubAccountId))
          return deny("app_exists", "A personal App already exists.");
        const converted = await api.convertManifest(input.code);
        if (!converted.ok)
          return deny(
            "exchange_denied",
            "GitHub App conversion failed. Start again.",
          );
        const app = converted.value;
        const expected = buildPersonalAppManifest({
          origin: context.origin,
          publicPrefix: "",
          nameSuffix: consumed.transaction.state.slice(0, 6),
        });
        if (app.name !== expected.name)
          return deny(
            "conversion_invalid",
            "App conversion does not match this manifest. Remove the new App on GitHub.",
          );
        if (app.owner.id !== context.ownerGithubAccountId)
          return deny(
            "conversion_owner_mismatch",
            "The created App belongs to a different account. Remove it on GitHub.",
          );
        if (app.owner.type !== "User")
          return deny(
            "conversion_not_user_account",
            "Create the App under your personal User account, not an organization.",
          );
        if (
          !acknowledgementMatches(
            consumed.transaction.acknowledgement,
            context,
            now(),
          )
        )
          return deny(
            "disclosure_required",
            "The disclosure acknowledgement expired during conversion. Remove the new App on GitHub and start again.",
          );
        const created = await broker.createApp(
          {
            connectionAcknowledgement: consumed.transaction.acknowledgement,
            recordId: randomUUID(),
            ownerGithubAccountId: app.owner.id,
            githubAppId: app.githubAppId,
            clientId: app.clientId,
            slug: app.slug,
            ownerLoginAtCreation: app.owner.login,
            createdAt: now(),
            public: false,
            webhooks: "disabled",
          },
          { clientSecret: app.clientSecret, privateKeyPem: app.privateKeyPem },
        );
        if (created.status !== "created")
          return deny(
            created.status === "exists" ? "app_exists" : "storage_failed",
            "App not connected. Remove the newly created App on GitHub before retrying.",
          );
        return { ok: true as const };
      });
    },

    status(
      owner: number,
    ): Promise<PersonalGithubResult<{ status: PersonalAppStatusDto }>> {
      return guarded(owner, async () => {
        const record = await broker.getApp(owner);
        const grant = record ? await broker.getUserGrant(refOf(record)) : null;
        const app = record?.app;
        // Explicit projection: neither broker records nor tokens are spread.
        return {
          ok: true,
          status: {
            runtime: broker.authority.kind,
            needsDisconnect: record?.lifecycle === "revoking",
            app: app
              ? {
                  recordId: app.recordId,
                  githubAppId: app.githubAppId,
                  slug: app.slug,
                  clientId: app.clientId,
                  ownerLoginAtCreation: app.ownerLoginAtCreation,
                  createdAt: app.createdAt,
                  installUrl: `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`,
                  public: false,
                  webhooks: "disabled",
                }
              : null,
            installation: record?.installation
              ? {
                  installationId: record.installation.installationId,
                  accountLogin: record.installation.accountLogin,
                  repositorySelection: record.installation.repositorySelection,
                  suspended: record.installation.suspended,
                }
              : null,
            userGrant:
              grant && grant.grant.grantedGithubAccountId === owner
                ? {
                    grantedLogin: grant.grant.grantedLogin,
                    connectedAt: grant.grant.connectedAt,
                    expiresAt: grant.grant.expiresAt,
                    needsReconnect:
                      grant.grant.refreshFailedAt !== null ||
                      (grant.grant.expiresAt !== null &&
                        grant.grant.expiresAt <= now()),
                  }
                : null,
          },
        };
      });
    },

    startGrant(context: Context) {
      return guarded(context.ownerGithubAccountId, async () => {
        const record = await active(context.ownerGithubAccountId);
        if (!record) return deny("app_missing", "Personal App unavailable.");
        if (await broker.getUserGrant(refOf(record)))
          return deny(
            "app_exists",
            "A grant is already connected. Refresh it or disconnect first.",
          );
        if (
          record.app.connectionAcknowledgement?.version !==
            PERSONAL_CONNECTION_DISCLOSURE.version ||
          record.app.connectionAcknowledgement.ownerGithubAccountId !==
            context.ownerGithubAccountId
        )
          return deny(
            "disclosure_required",
            "Reconnect after reading the current shared-server disclosure.",
          );
        // Reuse origin/session validation without leaving a manifest pending.
        const binding = manifests.begin({ ...context, publicPrefix: "" });
        if (!binding.ok) return binding;
        manifests.consume({
          ...context,
          state: binding.state,
          operation: PERSONAL_MANIFEST_OPERATION,
        });
        for (const [id, item] of devices)
          if (item.expiresAt <= now()) devices.delete(id);
        if (
          devices.size >= 64 ||
          [...devices.values()].some(
            (item) =>
              item.ownerGithubAccountId === context.ownerGithubAccountId,
          )
        )
          return deny("manifest_limit", "A connection is already pending.");
        const started = await api.startDeviceFlow(record.app.clientId);
        if (!started.ok)
          return deny(
            "github_unavailable",
            "Cannot start personal authorization. Check that Device Flow is enabled.",
          );
        const flowId = randomUUID();
        const interval = Math.min(60, Math.max(5, started.value.interval));
        const expiresIn = Math.min(900, Math.max(1, started.value.expiresIn));
        devices.set(flowId, {
          ...context,
          recordId: record.app.recordId,
          deviceCode: started.value.deviceCode,
          expiresAt: now() + expiresIn * 1000,
          nextPollAt: now() + interval * 1000,
          interval,
        });
        return {
          ok: true as const,
          flowId,
          userCode: started.value.userCode,
          verificationUri: "https://github.com/login/device",
          interval,
          expiresIn,
        };
      });
    },

    pollGrant(context: Context, flowId: string) {
      return guarded(context.ownerGithubAccountId, async () => {
        const flow = devices.get(flowId);
        if (!flow || flow.expiresAt <= now()) {
          devices.delete(flowId);
          return deny("grant_missing", "Authorization expired or missing.");
        }
        if (
          flow.ownerGithubAccountId !== context.ownerGithubAccountId ||
          flow.origin !== context.origin ||
          flow.browserSessionId !== context.browserSessionId
        )
          return deny("grant_missing", "Authorization expired or missing.");
        const record = await active(context.ownerGithubAccountId);
        if (!record || record.app.recordId !== flow.recordId) {
          devices.delete(flowId);
          return deny("app_missing", "Personal App unavailable.");
        }
        if (flow.nextPollAt > now())
          return { ok: true as const, status: "pending" as const };
        flow.nextPollAt = now() + flow.interval * 1000;
        const polled = await api.pollDeviceFlow({
          clientId: record.app.clientId,
          deviceCode: flow.deviceCode,
        });
        if (!polled.ok)
          return deny(
            "github_unavailable",
            "Personal authorization unavailable.",
          );
        if (polled.value.status === "pending")
          return { ok: true as const, status: "pending" as const };
        if (polled.value.status === "slow_down") {
          flow.interval = Math.min(
            60,
            Math.max(flow.interval + 5, polled.value.interval),
          );
          flow.nextPollAt = now() + flow.interval * 1000;
          return { ok: true as const, status: "pending" as const };
        }
        devices.delete(flowId);
        if (polled.value.status === "denied")
          return deny("credential_denied", "GitHub authorization denied.");
        const token = polled.value.grant;
        const user = await api.getAuthenticatedUser(token.accessToken);
        if (
          !user.ok ||
          user.value.id !== context.ownerGithubAccountId ||
          user.value.type !== "User"
        ) {
          await broker.discardUserToken(refOf(record), token.accessToken);
          return deny(
            "grant_owner_mismatch",
            "Authorize using your personal account.",
          );
        }
        const ref = refOf(record);
        const previous = await broker.getUserGrant(ref);
        let saved: Awaited<ReturnType<PersonalGithubBroker["putUserGrant"]>>;
        try {
          saved = await broker.putUserGrant(
            ref,
            {
              accessToken: token.accessToken,
              expiresAt:
                token.expiresInSeconds === null
                  ? null
                  : now() + token.expiresInSeconds * 1000,
              refreshToken: token.refreshToken,
              refreshTokenExpiresAt:
                token.refreshTokenExpiresInSeconds === null
                  ? null
                  : now() + token.refreshTokenExpiresInSeconds * 1000,
              grantedGithubAccountId: user.value.id,
              grantedLogin: user.value.login,
              connectedAt: now(),
              refreshFailedAt: null,
            },
            previous?.rev ?? null,
          );
        } catch {
          await broker.discardUserToken(ref, token.accessToken);
          return deny(
            "storage_failed",
            "Authorization was not stored. Reconnect.",
          );
        }
        if (saved.status !== "committed") {
          await broker.discardUserToken(ref, token.accessToken);
          return deny(
            "revoked_during_operation",
            "Personal authorization changed. Reconnect.",
          );
        }
        return { ok: true as const, status: "connected" as const };
      });
    },

    refresh(owner: number) {
      return guarded(owner, async () => {
        const record = await active(owner);
        if (!record) return deny("app_missing", "Personal App unavailable.");
        const refreshed = await broker.refreshUserGrant(refOf(record));
        if (refreshed.status === "dead" || refreshed.status === "failed") {
          await broker.revokeAccess(refOf(record));
          return deny(
            "grant_needs_reconnect",
            "Personal authorization needs reconnection.",
          );
        }
        if (
          (refreshed.status === "current" ||
            refreshed.status === "refreshed") &&
          refreshed.grant.grantedGithubAccountId !== owner
        ) {
          await broker.revokeAccess(refOf(record));
          return deny("grant_owner_mismatch", "Personal grant owner mismatch.");
        }
        return discover(record);
      });
    },

    register(
      owner: number,
      selection: {
        appRecordId: string;
        githubAppId: number;
        installationId: number;
        repositoryId: number;
      },
    ): Promise<
      PersonalGithubResult<{
        descriptor: PersonalRepositoryDescriptor;
        registryId?: string;
      }>
    > {
      return guarded(owner, async () => {
        const record = await active(owner);
        if (
          !record ||
          record.app.recordId !== selection.appRecordId ||
          record.app.githubAppId !== selection.githubAppId
        )
          return deny("registration_app_mismatch", "Personal App unavailable.");
        if (
          !isGithubAccountId(selection.repositoryId) ||
          !isGithubAccountId(selection.installationId)
        )
          return deny("registration_invalid", "Invalid repository selection.");
        const discovered = await discover(record);
        if (!discovered.ok) return discovered;
        const repository = discovered.repositories.find(
          (item) => item.repositoryId === selection.repositoryId,
        );
        if (
          !repository ||
          discovered.installationId !== selection.installationId
        )
          return deny(
            "repository_not_accessible",
            "Repository unavailable in this personal installation.",
          );
        const descriptor: PersonalRepositoryDescriptor = Object.freeze({
          kind: "personal",
          ownerGithubAccountId: owner,
          appRecordId: record.app.recordId,
          githubAppId: record.app.githubAppId,
          installationId: discovered.installationId,
          repositoryId: repository.repositoryId,
          repositoryOwnerGithubAccountId: repository.ownerGithubAccountId,
          accessRevision: discovered.accessRevision,
          fullName: repository.fullName,
        });
        const registered = deps.repositoryCoordinator
          ? await deps.repositoryCoordinator.register(descriptor)
          : undefined;
        if (
          deps.repositoryCoordinator &&
          (!registered ||
            typeof registered.registryId !== "string" ||
            !registered.registryId ||
            registered.registryId.length > 256)
        )
          throw new Error("Catalog registration did not acknowledge an id");
        return {
          ok: true,
          descriptor,
          ...(registered ? { registryId: registered.registryId } : {}),
        };
      });
    },

    resolveCredential(
      owner: number,
      descriptor: PersonalRepositoryDescriptor,
      kind: PersonalCredentialKind,
    ): Promise<
      PersonalGithubResult<{ credential: PersonalRepositoryCredential }>
    > {
      return guarded(owner, async () => {
        const coordinator = deps.repositoryCoordinator;
        if (!coordinator || !isPersonalCredentialKind(kind))
          return deny(
            "credential_denied",
            "Repository credential service unavailable.",
          );
        if (
          descriptor?.kind !== "personal" ||
          descriptor.ownerGithubAccountId !== owner ||
          descriptor.repositoryOwnerGithubAccountId !== owner ||
          !isGithubAccountId(descriptor.repositoryId) ||
          !isGithubAccountId(descriptor.installationId) ||
          !isGithubAccountId(descriptor.accessRevision)
        )
          return deny(
            "registration_invalid",
            "Invalid personal repository binding.",
          );
        const record = await active(owner);
        if (
          !record ||
          record.app.recordId !== descriptor.appRecordId ||
          record.app.githubAppId !== descriptor.githubAppId
        )
          return deny("registration_app_mismatch", "Personal App unavailable.");
        const ref = refOf(record);
        if ((await broker.getAccessRevision(ref)) !== descriptor.accessRevision)
          return deny(
            "revoked_during_operation",
            "Repository binding changed.",
          );
        await coordinator.assertCurrent(owner, descriptor);
        const discovered = await discover(record);
        if (!discovered.ok) return discovered;
        const repository = discovered.repositories.find(
          (item) => item.repositoryId === descriptor.repositoryId,
        );
        if (
          !repository ||
          discovered.installationId !== descriptor.installationId ||
          discovered.accessRevision !== descriptor.accessRevision
        )
          return deny("revoked_during_operation", "Repository access changed.");
        const jwt = await broker.signAppJwt(ref, Math.floor(now() / 1000));
        if (!jwt)
          return deny(
            "credential_denied",
            "Personal App credential unavailable.",
          );
        const permissions =
          kind === "installation-write"
            ? { ...PERSONAL_APP_PERMISSIONS }
            : Object.fromEntries(
                Object.keys(PERSONAL_APP_PERMISSIONS).map((key) => [
                  key,
                  "read",
                ]),
              );
        const minted = await api.mintInstallationToken({
          appJwt: jwt,
          installationId: descriptor.installationId,
          repositoryIds: [descriptor.repositoryId],
          permissions,
        });
        if (!minted.ok)
          return deny(
            "credential_denied",
            "Repository-scoped credential unavailable.",
          );
        const { token, expiresAt } = minted.value;
        try {
          if (
            expiresAt === null ||
            !Number.isFinite(expiresAt) ||
            expiresAt <= now() + 60_000
          )
            throw new Error("Invalid credential expiry");
          await broker.trackInstallationToken(
            ref,
            token,
            expiresAt,
            descriptor.accessRevision,
          );
        } catch {
          const revoked = await api.revokeInstallationToken(token);
          if (!revoked.ok && revoked.status !== 401 && revoked.status !== 404) {
            await broker.retainInstallationCleanup(ref, token);
            await broker.revokeAccess(ref);
          }
          return deny(
            "credential_denied",
            "Credential was not safely recorded.",
          );
        }
        // Catalog callback cannot re-enter this owner's broker lane.
        try {
          await coordinator.assertCurrent(owner, descriptor);
        } catch {
          await broker.revokeAccess(ref);
          return deny("revoked_during_operation", "Repository access changed.");
        }
        if ((await broker.getAccessRevision(ref)) !== descriptor.accessRevision)
          return deny("revoked_during_operation", "Repository access changed.");
        return {
          ok: true,
          credential: {
            token,
            expiresAt,
            kind,
            ownerGithubAccountId: owner,
            appRecordId: descriptor.appRecordId,
            repositoryId: descriptor.repositoryId,
            installationId: descriptor.installationId,
            accessRevision: descriptor.accessRevision,
            fullName: repository.fullName,
          },
        };
      });
    },

    disconnect(owner: number) {
      return guarded(owner, async () => {
        disclosure.cancelOwner(owner);
        manifests.cancelOwner(owner);
        for (const [id, flow] of devices)
          if (flow.ownerGithubAccountId === owner) devices.delete(id);
        const record = await broker.getApp(owner);
        if (!record) return { ok: true as const };
        const ref = refOf(record);
        // Barrier remains durable if GitHub/storage fail. Retry continues from
        // revoking, never restores access or races an in-flight refresh.
        await broker.revokeAccess(ref);
        for (const [id, flow] of devices)
          if (flow.ownerGithubAccountId === owner) devices.delete(id);
        manifests.cancelOwner(owner);
        const revoked = await broker.revokeUserGrant(ref);
        if (revoked.status === "failed")
          return deny(
            "credential_denied",
            "Access blocked. GitHub revocation needs retry.",
          );
        const current = await broker.getApp(owner);
        if (!current || current.app.recordId !== ref.recordId)
          return deny("revoked_during_operation", "Personal App changed.");
        const deleted = await broker.deleteApp(ref, current.rev);
        return deleted === "deleted" || deleted === "missing"
          ? { ok: true as const }
          : deny("storage_failed", "Access blocked. Disconnect needs retry.");
      });
    },
  };
}
