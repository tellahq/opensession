import { describe, expect, test } from "bun:test";
import { syntheticFixture } from "./synthetic.test-support";
import type { PersonalUserGrant } from "./types";

function grant(owner: number, now: number): PersonalUserGrant {
  return {
    accessToken: `access-${owner}`,
    expiresAt: now - 1,
    refreshToken: `refresh-${owner}`,
    refreshTokenExpiresAt: now + 1000_000,
    grantedGithubAccountId: owner,
    grantedLogin: "old-login",
    connectedAt: now - 100,
    refreshFailedAt: null,
  };
}

describe("personal grants and revocation (synthetic)", () => {
  test("device grant is owner/origin/session/App bound, rate limited, secret-free", async () => {
    const f = syntheticFixture();
    await f.connect();
    f.respond(async (url) => {
      if (url.endsWith("/login/device/code"))
        return f.json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          interval: 5,
          expires_in: 900,
        });
      if (url.endsWith("/login/oauth/access_token"))
        return f.json({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          expires_in: 3600,
          refresh_token_expires_in: 86400,
        });
      if (url.endsWith("/user"))
        return f.json({ id: 11, login: "renamed", type: "User" });
      throw new Error("Unexpected call");
    });
    const start = await f.engine.startGrant(f.context());
    if (!start.ok) throw new Error(start.code);
    expect(JSON.stringify(start)).not.toContain("device-secret");
    expect(await f.engine.pollGrant(f.context(12), start.flowId)).toMatchObject(
      { code: "grant_missing" },
    );
    expect(
      await f.engine.pollGrant(
        { ...f.context(), origin: "https://evil.example" },
        start.flowId,
      ),
    ).toMatchObject({ code: "grant_missing" });
    expect(
      await f.engine.pollGrant(
        { ...f.context(), browserSessionId: "other" },
        start.flowId,
      ),
    ).toMatchObject({ code: "grant_missing" });
    expect(await f.engine.pollGrant(f.context(), start.flowId)).toEqual({
      ok: true,
      status: "pending",
    });
    f.advance(5000);
    const results = await Promise.all(
      [1, 2].map(() => f.engine.pollGrant(f.context(), start.flowId)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      f.calls.filter((c) => c.url.endsWith("/login/oauth/access_token")),
    ).toHaveLength(1);
    expect(f.records.get(11)?.grant?.value.grantedLogin).toBe("renamed");
    const status = JSON.stringify(await f.engine.status(11));
    for (const secret of ["access-secret", "refresh-secret", "device-secret"])
      expect(status).not.toContain(secret);
  });

  for (const mode of ["wrong-owner", "storage", "denied", "expired"] as const)
    test(`device grant cleanup ${mode}`, async () => {
      const f = syntheticFixture();
      await f.connect();
      f.respond(async (url) => {
        if (url.endsWith("/login/device/code"))
          return f.json({
            device_code: "device-secret",
            user_code: "ABCD-EFGH",
            interval: 5,
            expires_in: 900,
          });
        if (url.endsWith("/login/oauth/access_token"))
          return f.json(
            mode === "denied"
              ? { error: "access_denied", error_description: "secret" }
              : { access_token: "uncommitted-token" },
          );
        if (url.endsWith("/user"))
          return f.json({
            id: mode === "wrong-owner" ? 12 : 11,
            login: "person",
            type: "User",
          });
        if (url.endsWith("/token")) return new Response(null, { status: 204 });
        throw new Error("Unexpected call");
      });
      const start = await f.engine.startGrant(f.context());
      if (!start.ok) throw new Error(start.code);
      f.advance(mode === "expired" ? 900_000 : 5000);
      f.failWrite(mode === "storage");
      expect((await f.engine.pollGrant(f.context(), start.flowId)).ok).toBe(
        false,
      );
      expect(f.records.get(11)?.grant).toBeNull();
      expect(f.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(
        mode === "wrong-owner" || mode === "storage" ? 1 : 0,
      );
    });

  test("refresh lock/token cache partition by issuing App AND owner; rename stays owned", async () => {
    const f = syntheticFixture();
    const a = await f.connect(11);
    const b = await f.connect(12);
    await f.broker.putUserGrant(a, grant(11, f.now()), null);
    await f.broker.putUserGrant(b, grant(12, f.now()), null);
    f.respond(async (url, init) => {
      if (url.endsWith("/login/oauth/access_token")) {
        const body = JSON.parse(init.body!);
        const owner = body.client_id === "client-110" ? 11 : 12;
        expect(body.client_secret).toBe(`secret-${owner * 10}`);
        expect(body.refresh_token).toBe(`refresh-${owner}`);
        return f.json({
          access_token: `new-${owner}`,
          refresh_token: `rotated-${owner}`,
          expires_in: 3600,
          refresh_token_expires_in: 86400,
        });
      }
      if (url.endsWith("/user"))
        return f.json({
          id: init.headers.Authorization === "Bearer new-11" ? 11 : 12,
          login: "renamed",
          type: "User",
        });
      throw new Error("Unexpected call");
    });
    const result = await Promise.all([
      f.broker.refreshUserGrant(a),
      f.broker.refreshUserGrant(a),
      f.broker.refreshUserGrant(b),
    ]);
    expect(result.map((r) => r.status).sort()).toEqual([
      "current",
      "refreshed",
      "refreshed",
    ]);
    expect(
      f.calls.filter((c) => c.url.endsWith("/login/oauth/access_token")),
    ).toHaveLength(2);
    expect(
      await f.broker.getUserGrant({ ...a, ownerGithubAccountId: 12 }),
    ).toBeNull();
    expect(
      await f.broker.signAppJwt({ ...a, ownerGithubAccountId: 12 }, 1),
    ).toBeNull();
    expect(f.lanes.size).toBe(0);
  });

  test("refresh/disconnect serialize; disconnect invalidates before GitHub revoke and cannot resurrect", async () => {
    const f = syntheticFixture();
    const ref = await f.connect();
    await f.broker.putUserGrant(ref, grant(11, f.now()), null);
    let release!: () => void;
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.respond(async (url) => {
      if (url.endsWith("/login/oauth/access_token")) {
        reached();
        await proceed;
        return f.json({
          access_token: "new",
          refresh_token: "rotated",
          expires_in: 3600,
        });
      }
      if (url.endsWith("/user"))
        return f.json({ id: 11, login: "person", type: "User" });
      if (url.includes("/app/installations?")) return f.json([f.install()]);
      if (url.endsWith("/access_tokens"))
        return f.json(
          { token: "install", expires_at: "2027-01-01T00:00:00Z" },
          201,
        );
      if (url.includes("/installation/repositories?"))
        return f.json({ total_count: 0, repositories: [] });
      if (url.endsWith("/grant")) {
        expect(f.records.get(11)?.lifecycle).toBe("revoking");
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/installation/token"))
        return new Response(null, { status: 204 });
      throw new Error("Unexpected call");
    });
    const refreshing = f.engine.refresh(11);
    await started;
    const disconnecting = f.engine.disconnect(11);
    release();
    expect((await refreshing).ok).toBe(true);
    expect(await disconnecting).toEqual({ ok: true });
    expect(f.records.has(11)).toBe(false);
    expect(await f.broker.refreshUserGrant(ref)).toEqual({ status: "missing" });
    expect(await f.engine.refresh(11)).toMatchObject({ code: "app_missing" });
  });

  test("dead refresh durably blocks personal access without shared credential fallback", async () => {
    const f = syntheticFixture();
    const ref = await f.connect();
    await f.broker.putUserGrant(ref, grant(11, f.now()), null);
    f.respond(async () =>
      f.json({
        error: "bad_refresh_token",
        error_description: "do not leak secret",
      }),
    );
    const result = await f.engine.refresh(11);
    expect(result).toMatchObject({ code: "grant_needs_reconnect" });
    expect(JSON.stringify(result)).not.toContain("do not leak");
    expect(f.records.get(11)?.lifecycle).toBe("revoking");
    expect(await f.broker.getUserGrant(ref)).toBeNull();
    expect(
      f.calls.filter((c) => c.url.endsWith("/login/oauth/access_token")),
    ).toHaveLength(1);
  });
});

test("wrong refreshed numeric owner is revoked and blocks access, never cached", async () => {
  const f = syntheticFixture();
  const ref = await f.connect();
  await f.broker.putUserGrant(ref, grant(11, f.now()), null);
  f.respond(async (url) => {
    if (url.endsWith("/login/oauth/access_token"))
      return f.json({ access_token: "wrong-owner", expires_in: 3600 });
    if (url.endsWith("/user"))
      return f.json({ id: 12, login: "person", type: "User" });
    if (url.endsWith("/token")) return new Response(null, { status: 204 });
    throw new Error("Unexpected request");
  });
  expect(await f.engine.refresh(11)).toMatchObject({
    code: "grant_needs_reconnect",
  });
  expect(f.records.get(11)?.grant?.value.accessToken).toBe("access-11");
  expect(f.records.get(11)?.lifecycle).toBe("revoking");
  expect(f.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
});

test("GitHub revoke failure keeps denied credentials for retry, never exposes them", async () => {
  const f = syntheticFixture();
  const ref = await f.connect();
  await f.broker.putUserGrant(ref, grant(11, f.now()), null);
  f.respond(async () => f.json({ message: "access-11" }, 503));
  expect(await f.engine.disconnect(11)).toMatchObject({
    code: "credential_denied",
  });
  expect(f.records.get(11)?.lifecycle).toBe("revoking");
  expect(await f.broker.getUserGrant(ref)).toBeNull();
  expect(JSON.stringify(await f.engine.status(11))).not.toContain("access-11");
  f.respond(async () => new Response(null, { status: 204 }));
  expect(await f.engine.disconnect(11)).toEqual({ ok: true });
  expect(f.records.has(11)).toBe(false);
});

test("uncommitted-token cleanup failure is private, bounded, retryable and denied", async () => {
  const f = syntheticFixture();
  const ref = await f.connect();
  f.respond(async () => f.json({}, 503));
  await f.broker.discardUserToken(ref, "orphan-secret");
  expect(f.records.get(11)?.cleanupTokens).toEqual(["orphan-secret"]);
  expect(f.records.get(11)?.lifecycle).toBe("revoking");
  expect(JSON.stringify(await f.engine.status(11))).not.toContain(
    "orphan-secret",
  );
  f.respond(async () => new Response(null, { status: 204 }));
  expect(await f.engine.disconnect(11)).toEqual({ ok: true });
  expect(f.records.has(11)).toBe(false);
});

test("device authorization cannot silently replace an existing owner grant", async () => {
  const f = syntheticFixture();
  const ref = await f.connect();
  await f.broker.putUserGrant(ref, grant(11, f.now()), null);
  const calls = f.calls.length;
  expect(await f.engine.startGrant(f.context())).toMatchObject({
    code: "app_exists",
  });
  expect(
    await f.broker.putUserGrant(
      ref,
      { ...grant(11, f.now()), accessToken: "replacement" },
      1,
    ),
  ).toMatchObject({ status: "conflict" });
  expect(f.records.get(11)?.grant?.value.accessToken).toBe("access-11");
  expect(f.calls).toHaveLength(calls);
});
