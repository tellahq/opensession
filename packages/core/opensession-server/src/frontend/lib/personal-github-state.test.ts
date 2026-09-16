import { describe, expect, test } from "bun:test";
import type { PersonalGithubStatus } from "./personal-github";
import {
  ACCOUNT_CHANGED_MESSAGE,
  INITIAL_PERSONAL_GITHUB_STATE,
  canStartConnection,
  personalGithubReducer,
  personalGithubScope,
  personalRepositoryScope,
  type PersonalGithubState,
} from "./personal-github-state";

function status(owner: number): PersonalGithubStatus {
  return {
    ok: true,
    ownerGithubAccountId: owner,
    disclosure: { version: "shared-host-v1", text: "Shared server." },
    repositoryAdmission: false,
    status: { app: null, installation: null, userGrant: null },
  };
}

function run(
  actions: Parameters<typeof personalGithubReducer>[1][],
  from: PersonalGithubState = INITIAL_PERSONAL_GITHUB_STATE,
): PersonalGithubState {
  return actions.reduce(personalGithubReducer, from);
}

const flow = {
  ok: true as const,
  ownerGithubAccountId: 11,
  flowId: "flow-1",
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  interval: 5,
  expiresIn: 900,
};

describe("personal GitHub identity scope", () => {
  test("waits for sign-in to resolve and never keys on a display name", () => {
    expect(personalGithubScope(null)).toBeNull();
    expect(
      personalGithubScope({
        required: true,
        authenticated: true,
        githubAccountId: 11,
      }),
    ).toBe("github:11");
    expect(personalGithubScope({ required: true, authenticated: false })).toBe(
      null,
    );
    expect(personalGithubScope({ required: false, authenticated: false })).toBe(
      null,
    );
  });
});

describe("personal GitHub state", () => {
  test("a changed identity resets consent, pending operations and cached status", () => {
    const before = run([
      { type: "scope", scope: "github:11" },
      { type: "status.start" },
      { type: "status.ok", generation: 1, data: status(11) },
      { type: "consent", accepted: true },
      { type: "grant.started", generation: 1, flow },
    ]);
    expect(before.owner).toBe(11);
    expect(before.consent).toBe(true);
    expect(before.operation.kind).toBe("grant");

    const after = personalGithubReducer(before, {
      type: "scope",
      scope: "github:22",
    });
    expect(after).toEqual({
      ...INITIAL_PERSONAL_GITHUB_STATE,
      scope: "github:22",
      generation: 2,
    });
    // Same scope again is a no-op, so a re-render never clears consent.
    expect(
      personalGithubReducer(after, { type: "scope", scope: "github:22" }),
    ).toBe(after);
  });

  test("responses started under a previous account are dropped", () => {
    const state = run([
      { type: "scope", scope: "github:11" },
      { type: "status.start" },
      { type: "scope", scope: "github:22" },
      // Alice's status lands late, carrying generation 1.
      { type: "status.ok", generation: 1, data: status(11) },
      { type: "grant.started", generation: 1, flow },
      { type: "operation.failed", generation: 1, message: "late" },
    ]);
    expect(state.status.kind).toBe("idle");
    expect(state.owner).toBeNull();
    expect(state.operation.kind).toBe("none");
    expect(state.error).toBeNull();
  });

  test("a status for a different verified account is a changed account, not data", () => {
    const state = run([
      { type: "scope", scope: "github:11" },
      { type: "status.ok", generation: 1, data: status(11) },
      { type: "consent", accepted: true },
      { type: "status.ok", generation: 1, data: status(22) },
    ]);
    expect(state.owner).toBeNull();
    expect(state.consent).toBe(false);
    expect(state.status).toEqual({
      kind: "error",
      message: ACCOUNT_CHANGED_MESSAGE,
      previous: null,
    });
  });

  test("a reload keeps the last good status visible while it is in flight", () => {
    const state = run([
      { type: "scope", scope: "github:11" },
      { type: "status.ok", generation: 1, data: status(11) },
      { type: "status.start" },
    ]);
    expect(state.status).toEqual({ kind: "loading", previous: status(11) });
    const failed = personalGithubReducer(state, {
      type: "status.failed",
      generation: 1,
      message: "offline",
      signInRequired: false,
    });
    expect(failed.status).toEqual({
      kind: "error",
      message: "offline",
      previous: status(11),
    });
  });

  test("a fresh status ends the redirect step but leaves other work alone", () => {
    const base = run([
      { type: "scope", scope: "github:11" },
      { type: "status.ok", generation: 1, data: status(11) },
    ]);
    const redirected = personalGithubReducer(base, {
      type: "operation.start",
      operation: { kind: "redirecting" },
    });
    expect(
      personalGithubReducer(redirected, {
        type: "status.ok",
        generation: 1,
        data: status(11),
      }).operation,
    ).toEqual({ kind: "none" });
    const granting = personalGithubReducer(base, {
      type: "grant.started",
      generation: 1,
      flow,
    });
    expect(
      personalGithubReducer(granting, {
        type: "status.ok",
        generation: 1,
        data: status(11),
      }).operation.kind,
    ).toBe("grant");
  });

  test("an unverified sign-in is its own state", () => {
    const state = run([
      { type: "scope", scope: "github:11" },
      {
        type: "status.failed",
        generation: 1,
        message: "Sign in again",
        signInRequired: true,
      },
    ]);
    expect(state.status).toEqual({
      kind: "signin_required",
      message: "Sign in again",
    });
    expect(canStartConnection({ ...state, consent: true })).toBe(false);
  });

  test("connecting needs the loaded disclosure, the checkbox and an idle card", () => {
    const loaded = run([
      { type: "scope", scope: "github:11" },
      { type: "status.ok", generation: 1, data: status(11) },
    ]);
    expect(canStartConnection(loaded)).toBe(false);
    const consented = personalGithubReducer(loaded, {
      type: "consent",
      accepted: true,
    });
    expect(canStartConnection(consented)).toBe(true);
    expect(
      canStartConnection(
        personalGithubReducer(consented, {
          type: "operation.start",
          operation: { kind: "acknowledging" },
        }),
      ),
    ).toBe(false);
    expect(
      canStartConnection(
        personalGithubReducer(consented, { type: "status.start" }),
      ),
    ).toBe(false);
  });

  test("a failed operation reports and frees the card; cancel only stops a device flow", () => {
    const failed = run([
      { type: "scope", scope: "github:11" },
      { type: "operation.start", operation: { kind: "preparing" } },
      { type: "operation.failed", generation: 1, message: "Too many" },
    ]);
    expect(failed.operation.kind).toBe("none");
    expect(failed.error).toBe("Too many");
    expect(personalGithubReducer(failed, { type: "error.dismiss" }).error).toBe(
      null,
    );

    const granting = personalGithubReducer(failed, {
      type: "grant.started",
      generation: 1,
      flow,
    });
    expect(
      personalGithubReducer(granting, { type: "grant.cancel" }).operation.kind,
    ).toBe("none");
    const refreshing = personalGithubReducer(failed, {
      type: "operation.start",
      operation: { kind: "refreshing" },
    });
    expect(
      personalGithubReducer(refreshing, { type: "grant.cancel" }).operation,
    ).toEqual({ kind: "refreshing" });
  });
});

describe("disclosure and logout invalidation", () => {
  test("missing or invalid numeric identities never fall back to a login", () => {
    for (const githubAccountId of [undefined, 0, -1, NaN, 1.5]) {
      expect(
        personalGithubScope({
          required: true,
          authenticated: true,
          githubAccountId,
        }),
      ).toBeNull();
    }
  });

  test("logout discards every cached field and ignores a pending result", () => {
    const loaded = run([
      { type: "scope", scope: "github:11" },
      { type: "status.ok", generation: 1, data: status(11) },
      { type: "consent", accepted: true },
      { type: "grant.started", generation: 1, flow },
      { type: "scope", scope: null },
      { type: "operation.failed", generation: 1, message: "Private error" },
      { type: "status.ok", generation: 1, data: status(11) },
    ]);
    expect(loaded).toEqual({ ...INITIAL_PERSONAL_GITHUB_STATE, generation: 2 });
  });

  test("a new disclosure version needs new consent", () => {
    const changed = status(11);
    changed.disclosure = {
      version: "shared-host-v2",
      text: "Updated disclosure",
    };
    const state = run([
      { type: "scope", scope: "github:11" },
      { type: "status.ok", generation: 1, data: status(11) },
      { type: "consent", accepted: true },
      { type: "status.ok", generation: 1, data: changed },
    ]);
    expect(state.consent).toBe(false);
    expect(canStartConnection(state)).toBe(false);
  });
});

test("disconnect barrier cancels a pending grant and rejects its late start result", () => {
  const revoked = status(11);
  revoked.status.needsDisconnect = true;
  const state = run([
    { type: "scope", scope: "github:11" },
    { type: "status.ok", generation: 1, data: status(11) },
    { type: "grant.started", generation: 1, flow },
    { type: "status.ok", generation: 1, data: revoked },
    { type: "grant.started", generation: 1, flow },
  ]);
  expect(state.operation.kind).toBe("none");
  expect(canStartConnection({ ...state, consent: true })).toBe(false);
});

test("repository UI requires real admission, installation and a usable grant; tuple changes reset lifetime", () => {
  const data: PersonalGithubStatus = {
    ...status(11),
    repositoryAdmission: true,
    status: {
      app: {
        recordId: "rec",
        githubAppId: 1,
        slug: "app",
        clientId: "client",
        ownerLoginAtCreation: "alice",
        createdAt: 1,
        installUrl: "https://github.com/apps/app/installations/new",
      },
      installation: {
        installationId: 7,
        accountLogin: "alice",
        repositorySelection: "selected",
        suspended: false,
      },
      userGrant: {
        grantedLogin: "alice",
        connectedAt: 1,
        expiresAt: null,
        needsReconnect: false,
      },
    },
  };
  const key = personalRepositoryScope(data);
  expect(key).not.toBeNull();
  expect(
    personalRepositoryScope({ ...data, repositoryAdmission: false }),
  ).toBeNull();
  for (const patch of [
    { needsDisconnect: true },
    { app: null },
    { installation: null },
    { userGrant: null },
    { installation: { ...data.status.installation!, suspended: true } },
    { userGrant: { ...data.status.userGrant!, needsReconnect: true } },
  ])
    expect(
      personalRepositoryScope({
        ...data,
        status: { ...data.status, ...patch },
      }),
    ).toBeNull();
  expect(
    personalRepositoryScope({ ...data, ownerGithubAccountId: 22 }),
  ).not.toBe(key);
  expect(
    personalRepositoryScope({
      ...data,
      status: { ...data.status, app: { ...data.status.app!, recordId: "new" } },
    }),
  ).not.toBe(key);
  expect(
    personalRepositoryScope({
      ...data,
      status: {
        ...data.status,
        installation: { ...data.status.installation!, installationId: 8 },
      },
    }),
  ).not.toBe(key);
});
