import { describe, expect, test } from "bun:test";
import { syntheticFixture } from "./synthetic.test-support";
import { createBrokerPersonalGithubEngine } from "./engine";
import { PERSONAL_MANIFEST_OPERATION } from "./manifest";

const operation = PERSONAL_MANIFEST_OPERATION;

describe("personal broker state machine (synthetic)", () => {
  test("unwired engine denies absent authority and a copied synthetic broker identity", async () => {
    const f = syntheticFixture();
    const dependencies = {
      broker: f.broker,
      api: f.api,
      admission: { admit: () => true },
      enabled: true,
    };
    const prod = createBrokerPersonalGithubEngine({
      ...dependencies,
      admission: undefined,
    });
    expect(await prod.beginManifest(f.context())).toMatchObject({
      code: "runtime_unavailable",
    });
    expect(
      await prod.completeManifest(f.context(), {
        state: "guess",
        code: "code",
        operation,
      }),
    ).toMatchObject({ code: "runtime_unavailable" });
    expect(await prod.status(11)).toMatchObject({
      code: "runtime_unavailable",
    });
    expect(f.calls).toHaveLength(0);
    expect(f.records.size).toBe(0);
    const forged = createBrokerPersonalGithubEngine({
      broker: { ...f.broker, authority: { ...f.authority } },
      api: f.api,
      admission: f.admission,
    });
    expect(await forged.status(11)).toMatchObject({
      code: "runtime_unavailable",
    });
  });
  test("single-use concurrent callback exchanges once, unique App per owner", async () => {
    const f = syntheticFixture();
    const start = await f.engine.beginManifest(f.context());
    if (!start.ok) throw new Error(start.code);
    f.respond(async () =>
      f.json(f.converted(JSON.parse(start.manifest).name), 201),
    );
    const results = await Promise.all(
      [1, 2].map(() =>
        f.engine.completeManifest(f.context(), {
          state: start.state,
          code: "code",
          operation,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
    expect(f.records.size).toBe(1);
    expect(await f.engine.beginManifest(f.context())).toMatchObject({
      code: "app_exists",
    });
    expect(f.lanes.size).toBe(0);
  });
  for (const scenario of [
    "wrong-owner",
    "organization",
    "denied",
    "storage",
    "wrong-name",
    "public",
    "webhooks",
  ] as const)
    test(`conversion fails cleanly: ${scenario}`, async () => {
      const f = syntheticFixture();
      const start = await f.engine.beginManifest(f.context());
      if (!start.ok) throw new Error(start.code);
      const converted = f.converted(JSON.parse(start.manifest).name);
      if (scenario === "wrong-owner") converted.owner.id = 12;
      if (scenario === "organization") converted.owner.type = "Organization";
      if (scenario === "wrong-name") converted.name = "Another manifest";
      if (scenario === "public") converted.public = true;
      f.respond(async () =>
        f.json(
          scenario === "webhooks"
            ? { ...converted, events: ["push"] }
            : converted,
          scenario === "denied" ? 403 : 201,
        ),
      );
      f.failWrite(scenario === "storage");
      const result = await f.engine.completeManifest(f.context(), {
        state: start.state,
        code: "code",
        operation,
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("secret-110");
      expect(f.records.size).toBe(0);
      expect(
        await f.engine.completeManifest(f.context(), {
          state: start.state,
          code: "code",
          operation,
        }),
      ).toMatchObject({ code: "manifest_replayed" });
      expect(f.calls).toHaveLength(1);
    });
  test("status is secret-free; account renames do not transfer ownership", async () => {
    const f = syntheticFixture();
    await f.connect();
    const status = await f.engine.status(11);
    expect(status.ok).toBe(true);
    const json = JSON.stringify(status);
    for (const secret of [
      f.pem,
      "secret-110",
      "privateKeyPem",
      "accessToken",
      "refreshToken",
    ])
      expect(json).not.toContain(secret);
    expect(await f.engine.status(12)).toMatchObject({
      ok: true,
      status: { app: null },
    });
    f.discovery();
    expect(await f.engine.refresh(11)).toMatchObject({
      ok: true,
      repositories: [
        { ownerGithubAccountId: 11, fullName: "renamed-11/private" },
      ],
    });
  });
  test("registration tuple is immutable and App-scoped even for overlapping repo IDs", async () => {
    const f = syntheticFixture();
    const a = await f.connect(11);
    const b = await f.connect(12);
    f.discovery(11);
    const registered = await f.engine.register(11, {
      appRecordId: a.recordId,
      githubAppId: 110,
      installationId: 101,
      repositoryId: 501,
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(Object.isFrozen(registered.descriptor)).toBe(true);
    expect(registered.descriptor).toMatchObject({
      ownerGithubAccountId: 11,
      repositoryId: 501,
      repositoryOwnerGithubAccountId: 11,
      githubAppId: 110,
    });
    expect(
      await f.engine.register(12, {
        appRecordId: a.recordId,
        githubAppId: 110,
        installationId: 101,
        repositoryId: 501,
      }),
    ).toMatchObject({ code: "registration_app_mismatch" });
    f.discovery(12);
    expect(
      await f.engine.register(12, {
        appRecordId: b.recordId,
        githubAppId: 120,
        installationId: 101,
        repositoryId: 501,
      }),
    ).toMatchObject({
      ok: true,
      descriptor: {
        ownerGithubAccountId: 12,
        appRecordId: b.recordId,
        repositoryId: 501,
      },
    });
    f.discovery(11, []);
    expect(
      await f.engine.register(11, {
        appRecordId: a.recordId,
        githubAppId: 110,
        installationId: 101,
        repositoryId: 501,
      }),
    ).toMatchObject({ code: "repository_not_accessible" });
    expect(f.records.get(11)!.accessRevision).toBeGreaterThan(
      registered.descriptor.accessRevision,
    );
  });
  for (const scenario of [
    "wrong-owner",
    "organization",
    "all",
    "suspended",
    "ambiguous",
  ] as const)
    test(`rejects installation ${scenario}`, async () => {
      const f = syntheticFixture();
      await f.connect();
      const install = f.install();
      if (scenario === "wrong-owner") install.account.id = 12;
      if (scenario === "organization") install.target_type = "Organization";
      if (scenario === "all") install.repository_selection = "all";
      f.respond(async () =>
        f.json(
          scenario === "ambiguous"
            ? [install, { ...install, id: 102 }]
            : [
                {
                  ...install,
                  suspended_at: scenario === "suspended" ? "2026-01-01" : null,
                },
              ],
        ),
      );
      expect((await f.engine.refresh(11)).ok).toBe(false);
      expect(f.records.get(11)!.lifecycle).toBe("revoking");
      expect(
        f.calls.filter((c) => c.url.endsWith("/access_tokens")),
      ).toHaveLength(0);
    });
  test("disconnect revocation failure is durably denied; retry deletes only own App", async () => {
    const f = syntheticFixture();
    await f.connect(11);
    await f.connect(12);
    f.failRevocation(true);
    expect(await f.engine.disconnect(11)).toMatchObject({ ok: false });
    expect(f.records.get(11)!.lifecycle).toBe("revoking");
    expect(await f.engine.refresh(11)).toMatchObject({ code: "app_missing" });
    f.failRevocation(false);
    expect(await f.engine.disconnect(11)).toEqual({ ok: true });
    expect(f.records.has(11)).toBe(false);
    expect(f.records.has(12)).toBe(true);
    expect(await f.engine.disconnect(11)).toEqual({ ok: true });
  });
});

test("pending alternate manifest cannot race overwrite or survive disconnect", async () => {
  const f = syntheticFixture();
  const first = await f.engine.beginManifest(f.context());
  const second = await f.engine.beginManifest(f.context());
  if (!first.ok || !second.ok) throw new Error("Expected pending manifests");
  f.respond(async () =>
    f.json(f.converted(JSON.parse(first.manifest).name), 201),
  );
  expect(
    await f.engine.completeManifest(f.context(), {
      state: first.state,
      code: "code",
      operation,
    }),
  ).toEqual({ ok: true });
  expect(await f.engine.disconnect(11)).toEqual({ ok: true });
  expect(
    await f.engine.completeManifest(f.context(), {
      state: second.state,
      code: "other-code",
      operation,
    }),
  ).toMatchObject({ code: "manifest_replayed" });
  expect(f.calls).toHaveLength(1);
});

test("repository verification failures revoke previous access and always dispose discovery token", async () => {
  const f = syntheticFixture();
  await f.connect();
  f.discovery();
  const first = await f.engine.refresh(11);
  expect(first.ok).toBe(true);
  f.respond(async (url) => {
    if (url.includes("/app/installations?")) return f.json([f.install()]);
    if (url.endsWith("/access_tokens"))
      return f.json(
        { token: "install", expires_at: "2027-01-01T00:00:00Z" },
        201,
      );
    if (url.includes("/installation/repositories?"))
      return f.json({ total_count: 1, repositories: [f.repository(12)] });
    if (url.endsWith("/installation/token"))
      return new Response(null, { status: 204 });
    throw new Error("Unexpected request");
  });
  expect(await f.engine.refresh(11)).toMatchObject({
    code: "repository_owner_mismatch",
  });
  expect(f.records.get(11)?.lifecycle).toBe("revoking");
  expect(
    f.calls.filter((c) => c.url.endsWith("/installation/token")),
  ).toHaveLength(2);
});

test("old App reference cannot alias replacement App for the same numeric owner", async () => {
  const f = syntheticFixture();
  const old = await f.connect();
  expect(await f.engine.disconnect(11)).toEqual({ ok: true });
  const replacement = await f.connect();
  expect(old.recordId).not.toBe(replacement.recordId);
  expect(await f.broker.getUserGrant(old)).toBeNull();
  expect(await f.broker.signAppJwt(old, 1)).toBeNull();
  expect(
    await f.engine.register(11, {
      appRecordId: old.recordId,
      githubAppId: 110,
      repositoryId: 501,
      installationId: 101,
    }),
  ).toMatchObject({ code: "registration_app_mismatch" });
});
