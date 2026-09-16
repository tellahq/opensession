import { describe, expect, test } from "bun:test";
import {
  PrivacyPrincipalChanged,
  validatePrivacyPrincipal,
  accessForAuthenticatedSession,
  accessForVerifiedWebIdentity,
  canReadApplicationResource,
  canTransferApplicationResource,
  canWriteApplicationResource,
  resolveApplicationSession,
} from "./application-access";
import type { AccessScope } from "../shared/access-scope";

const shared = { kind: "shared" } as const;
const personalA = { kind: "personal", ownerGithubAccountId: 101 } as const;
const personalB = { kind: "personal", ownerGithubAccountId: 202 } as const;
const identityA = { login: "a", name: "Same name", githubAccountId: 101 };
const identityB = { login: "b", name: "Same name", githubAccountId: 202 };

describe("application access contexts", () => {
  test("numeric identity, not attribution, partitions reads and cache keys", () => {
    const a = accessForVerifiedWebIdentity(identityA);
    const b = accessForVerifiedWebIdentity(identityB);
    expect(a.audience).toBe("github:101");
    expect(b.audience).toBe("github:202");
    for (const context of [a, b]) {
      expect(canReadApplicationResource(context, shared)).toBe(true);
    }
    expect(canReadApplicationResource(a, personalA)).toBe(true);
    expect(canReadApplicationResource(b, personalA)).toBe(false);
    expect(canReadApplicationResource(a, personalB)).toBe(false);
    expect(canReadApplicationResource(b, personalB)).toBe(true);
    expect(
      accessForVerifiedWebIdentity({
        ...identityA,
        login: "renamed",
        name: "New",
      }).audience,
    ).toBe(a.audience);
  });

  test("legacy, machine and invalid numeric identities remain shared-only", () => {
    for (const identity of [
      null,
      undefined,
      { login: "a", name: "Same name" },
      { ...identityA, automation: true },
      ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
        (githubAccountId) => ({ ...identityA, githubAccountId }),
      ),
    ]) {
      const context = accessForVerifiedWebIdentity(identity);
      expect(context.audience).toBe("shared");
      expect(canReadApplicationResource(context, shared)).toBe(true);
      expect(canReadApplicationResource(context, personalA)).toBe(false);
    }
  });

  test("a shared run cannot ingest even its initiator's private data", () => {
    const run = accessForAuthenticatedSession({
      id: "shared-session",
      accessScope: shared,
    });
    expect(run.principal).toBeUndefined();
    expect(canReadApplicationResource(run, personalA)).toBe(false);
    expect(canWriteApplicationResource(run, personalA)).toBe(false);
    expect(canReadApplicationResource(run, shared)).toBe(true);
    expect(canWriteApplicationResource(run, shared)).toBe(true);
    expect(accessForAuthenticatedSession({ id: "legacy" }).audience).toBe(
      "shared",
    );
    expect(() => accessForAuthenticatedSession(undefined)).toThrow(
      "Session access unavailable",
    );
  });

  test("private run reads shared input but cannot write it back to shared/B", () => {
    const run = accessForAuthenticatedSession({
      id: "private-session",
      accessScope: personalA,
    });
    expect(canReadApplicationResource(run, shared)).toBe(true);
    expect(canReadApplicationResource(run, personalA)).toBe(true);
    expect(canReadApplicationResource(run, personalB)).toBe(false);
    expect(canWriteApplicationResource(run, personalA)).toBe(true);
    expect(canWriteApplicationResource(run, shared)).toBe(false);
    expect(canWriteApplicationResource(run, personalB)).toBe(false);
    expect(canTransferApplicationResource(run, shared, shared)).toBe(false);
    expect(canTransferApplicationResource(run, shared, personalA)).toBe(true);
    expect(canTransferApplicationResource(run, personalA, personalA)).toBe(
      true,
    );
  });

  test("a human's readable private source is not an implicit export grant", () => {
    const a = accessForVerifiedWebIdentity(identityA);
    expect(canWriteApplicationResource(a, shared)).toBe(true);
    expect(canTransferApplicationResource(a, personalA, shared)).toBe(false);
    expect(canTransferApplicationResource(a, personalA, personalB)).toBe(false);
    expect(canTransferApplicationResource(a, personalB, personalA)).toBe(false);
    expect(canTransferApplicationResource(a, shared, personalA)).toBe(true);
    expect(canTransferApplicationResource(a, personalA, personalA)).toBe(true);
  });

  test("malformed scope fails closed rather than becoming shared", () => {
    const a = accessForVerifiedWebIdentity(identityA);
    for (const invalid of [
      null,
      {},
      [],
      { kind: "future" },
      { kind: "personal" },
    ]) {
      expect(() =>
        accessForAuthenticatedSession({
          id: "invalid",
          accessScope: invalid as AccessScope,
        }),
      ).toThrow();
      expect(canReadApplicationResource(a, invalid)).toBe(false);
      expect(canWriteApplicationResource(a, invalid)).toBe(false);
      expect(canTransferApplicationResource(a, invalid, shared)).toBe(false);
      expect(canTransferApplicationResource(a, shared, invalid)).toBe(false);
    }
  });

  test("captured identity/scope cannot change while an operation awaits", async () => {
    const identity = { ...identityA };
    const scope: AccessScope = { ...personalA };
    const web = accessForVerifiedWebIdentity(identity);
    const run = accessForAuthenticatedSession({
      id: "private-session",
      accessScope: scope,
    });
    identity.githubAccountId = 202;
    scope.ownerGithubAccountId = 202;
    await Promise.resolve();
    expect(web.principal?.githubAccountId).toBe(101);
    expect(run.principal?.githubAccountId).toBe(101);
    expect(run.origin).toEqual(personalA);
    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.principal)).toBe(true);
    expect(Object.isFrozen(run.origin)).toBe(true);
  });

  test("resolution returns the canonical handle, not the supplied alias", async () => {
    const a = accessForVerifiedWebIdentity(identityA);
    const calls: unknown[] = [];
    const handle = await resolveApplicationSession(
      "historical-id",
      a,
      async (id, principal) => {
        calls.push([id, principal]);
        return { id: "canonical-id", accessScope: personalA };
      },
    );
    expect(calls).toEqual([["historical-id", { githubAccountId: 101 }]]);
    expect(handle).toEqual({ id: "canonical-id", accessScope: personalA });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.isFrozen(handle?.accessScope)).toBe(true);
  });

  test("unfiltered resolver output cannot authorize B or a shared run", async () => {
    for (const context of [
      accessForVerifiedWebIdentity(identityB),
      accessForAuthenticatedSession({
        id: "shared-session",
        accessScope: shared,
      }),
    ]) {
      expect(
        await resolveApplicationSession("known-id", context, async () => ({
          id: "canonical-id",
          accessScope: personalA,
        })),
      ).toBeUndefined();
    }
    const a = accessForVerifiedWebIdentity(identityA);
    expect(
      await resolveApplicationSession("missing", a, async () => undefined),
    ).toBeUndefined();
    await expect(
      resolveApplicationSession("known-id", a, async () => {
        throw new Error("Authority unavailable");
      }),
    ).rejects.toThrow("Authority unavailable");
  });
});

test("privacy capability never grants identity and changed expected principals reject", () => {
  expect(
    validatePrivacyPrincipal(null, "101", identityA).principal,
  ).toBeUndefined();
  expect(
    validatePrivacyPrincipal("future", "101", identityA).principal,
  ).toBeUndefined();
  expect(
    validatePrivacyPrincipal("personal-v1", "101", identityA).principal,
  ).toEqual({ githubAccountId: 101 });
  for (const expected of [
    null,
    undefined,
    "",
    "0",
    "-1",
    "01",
    "101.0",
    "1.01e2",
    " 101",
    "9007199254740992",
    "202",
  ]) {
    expect(() =>
      validatePrivacyPrincipal("personal-v1", expected, identityA),
    ).toThrow(PrivacyPrincipalChanged);
  }
  expect(() =>
    validatePrivacyPrincipal("personal-v1", "101", identityB),
  ).toThrow(PrivacyPrincipalChanged);
  expect(() =>
    validatePrivacyPrincipal("personal-v1", "101", {
      ...identityA,
      automation: true,
    }),
  ).toThrow(PrivacyPrincipalChanged);
  expect(() => validatePrivacyPrincipal("personal-v1", "101", null)).toThrow(
    PrivacyPrincipalChanged,
  );
  try {
    validatePrivacyPrincipal("personal-v1", "101", identityB);
  } catch (error) {
    expect(error).toMatchObject({ status: 409, code: "principal_changed" });
  }
});
