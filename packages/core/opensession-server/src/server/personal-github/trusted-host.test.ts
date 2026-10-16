import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTrustedHostConnections } from "./service";
import { openTrustedHostStore } from "./trusted-host-store";
import { PERSONAL_CONNECTION_DISCLOSURE } from "./disclosure";
import { PERSONAL_MANIFEST_OPERATION } from "./manifest";
import { syntheticFixture } from "./synthetic.test-support";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "personal-trusted-host-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const fake = syntheticFixture();
  let calls = 0;
  let name = "";
  let response: import("./github-api").PersonalGithubTransport | undefined;
  const input = {
    directory,
    now: fake.now,
    transport: async (
      url: string,
      init: Parameters<import("./github-api").PersonalGithubTransport>[1],
    ) => {
      calls++;
      if (response) return response(url, init);
      return fake.json(fake.converted(name), 201);
    },
  };
  let opened = await openTrustedHostConnections(input);
  cleanups.push(() => opened.close());
  const context = fake.context();
  const accepted = () =>
    opened.connections.acknowledgeDisclosure(context, {
      version: PERSONAL_CONNECTION_DISCLOSURE.version,
      accepted: true,
    });
  const start = async () => {
    const ack = await accepted();
    if (!ack.ok) throw new Error(ack.code);
    const begun = await opened.connections.beginManifest(
      context,
      ack.disclosureReceipt,
    );
    if (!begun.ok) throw new Error(begun.code);
    name = JSON.parse(begun.manifest).name;
    return begun;
  };
  const connect = async () => {
    const begun = await start();
    return opened.connections.completeManifest(context, {
      state: begun.state,
      code: "synthetic-code",
      operation: PERSONAL_MANIFEST_OPERATION,
    });
  };
  return {
    directory,
    fake,
    context,
    accepted,
    start,
    connect,
    input,
    get service() {
      return opened.connections;
    },
    calls: () => calls,
    respond: (transport: import("./github-api").PersonalGithubTransport) => {
      response = transport;
    },
    async reopen() {
      await opened.close();
      opened = await openTrustedHostConnections(input);
    },
  };
}

test("trusted-host connection requires versioned consent before any GitHub exchange", async () => {
  const f = await fixture();
  expect(await f.service.beginManifest(f.context)).toMatchObject({
    code: "disclosure_required",
  });
  expect(
    await f.service.acknowledgeDisclosure(f.context, {
      version: "shared-host-v1",
      accepted: true,
    }),
  ).toMatchObject({ code: "disclosure_required" });
  expect(
    await f.service.acknowledgeDisclosure(f.context, {
      version: PERSONAL_CONNECTION_DISCLOSURE.version,
      accepted: false,
    }),
  ).toMatchObject({ code: "disclosure_required" });
  expect(f.calls()).toBe(0);
  expect(await f.connect()).toEqual({ ok: true });
  const stored = JSON.parse(
    await readFile(join(f.directory, "connections.json"), "utf8"),
  );
  expect(stored.records[0].app.connectionAcknowledgement).toMatchObject({
    version: PERSONAL_CONNECTION_DISCLOSURE.version,
    ownerGithubAccountId: 11,
    browserSessionId: f.context.browserSessionId,
    operation: PERSONAL_MANIFEST_OPERATION,
  });
  expect(stored).toMatchObject({ admission: "connections_only", bindings: [] });
  expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(f.directory, "connections.json"))).mode & 0o777).toBe(
    0o600,
  );
  expect("register" in f.service).toBe(false);
});

for (const mismatch of [
  "ownerGithubAccountId",
  "browserSessionId",
  "origin",
] as const)
  test(`disclosure receipt binds ${mismatch} and is single use`, async () => {
    const f = await fixture();
    const ack = await f.accepted();
    if (!ack.ok) throw new Error(ack.code);
    const context = {
      ...f.context,
      [mismatch]:
        mismatch === "ownerGithubAccountId"
          ? 12
          : mismatch === "origin"
            ? "https://other.example"
            : "other-session",
    };
    expect(
      await f.service.beginManifest(context, ack.disclosureReceipt),
    ).toMatchObject({ code: "disclosure_required" });
    expect(
      await f.service.beginManifest(f.context, ack.disclosureReceipt),
    ).toMatchObject({ code: "disclosure_required" });
    expect(f.calls()).toBe(0);
  });

test("expired consent and disconnect invalidate pending callbacks before conversion", async () => {
  const f = await fixture();
  const begun = await f.start();
  f.fake.advance(900_000);
  expect(
    (
      await f.service.completeManifest(f.context, {
        state: begun.state,
        code: "code",
        operation: PERSONAL_MANIFEST_OPERATION,
      })
    ).ok,
  ).toBe(false);
  const fresh = await f.start();
  await f.service.disconnect(11);
  expect(
    await f.service.completeManifest(f.context, {
      state: fresh.state,
      code: "code",
      operation: PERSONAL_MANIFEST_OPERATION,
    }),
  ).toMatchObject({ code: "manifest_replayed" });
  expect(f.calls()).toBe(0);
});

test("persisted App survives restart, pending consent does not; one OS writer", async () => {
  const f = await fixture();
  expect(await f.connect()).toEqual({ ok: true });
  const old = await f.service.status(11);
  await expect(openTrustedHostStore(f.directory)).rejects.toThrow();
  await f.reopen();
  expect(await f.service.status(11)).toEqual(old);
  expect(await f.service.status(12)).toMatchObject({
    ok: true,
    status: { app: null },
  });
});

for (const mutation of ["future", "bindings", "record-bindings"] as const)
  test(`unknown durable provenance denies access/disconnect: ${mutation}`, async () => {
    const f = await fixture();
    expect(await f.connect()).toEqual({ ok: true });
    const path = join(f.directory, "connections.json");
    const data = JSON.parse(await readFile(path, "utf8"));
    if (mutation === "future") data.version = 2;
    else if (mutation === "bindings")
      data.bindings = [{ sessionId: "future-session" }];
    else data.records[0].runtimeBindings = ["future-run"];
    await writeFile(path, JSON.stringify(data), { mode: 0o600 });
    expect((await f.service.disconnect(11)).ok).toBe(false);
    expect((await f.service.status(11)).ok).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8")).records).toHaveLength(1);
  });

test("acknowledgement is rechecked after slow conversion and before credential persistence", async () => {
  const f = await fixture();
  const begun = await f.start();
  f.respond(async () => {
    f.fake.advance(900_000);
    return f.fake.json(f.fake.converted(JSON.parse(begun.manifest).name), 201);
  });
  expect(
    await f.service.completeManifest(f.context, {
      state: begun.state,
      code: "code",
      operation: PERSONAL_MANIFEST_OPERATION,
    }),
  ).toMatchObject({ code: "disclosure_required" });
  expect(await f.service.status(11)).toMatchObject({
    ok: true,
    status: { app: null },
  });
});

test("grants persist with App+owner and restart/disconnect preserve secret-free status", async () => {
  const f = await fixture();
  expect(await f.connect()).toEqual({ ok: true });
  f.respond(async (url) => {
    if (url.endsWith("/login/device/code"))
      return f.fake.json({
        device_code: "synthetic-device",
        user_code: "ABCD-EFGH",
        interval: 5,
        expires_in: 900,
      });
    if (url.endsWith("/login/oauth/access_token"))
      return f.fake.json({
        access_token: "synthetic-user-token",
        refresh_token: "synthetic-refresh-token",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
      });
    if (url.endsWith("/user"))
      return f.fake.json({ id: 11, login: "renamed-owner", type: "User" });
    if (url.endsWith("/grant")) return new Response(null, { status: 204 });
    throw new Error("Unexpected synthetic GitHub call");
  });
  const started = await f.service.startGrant(f.context);
  if (!started.ok) throw new Error(started.code);
  f.fake.advance(5000);
  expect(await f.service.pollGrant(f.context, started.flowId)).toEqual({
    ok: true,
    status: "connected",
  });
  const stored = JSON.parse(
    await readFile(join(f.directory, "connections.json"), "utf8"),
  );
  expect(stored.records[0].grant.value.grantedGithubAccountId).toBe(11);
  expect(stored.records[0].grant.value.refreshToken).toBe(
    "synthetic-refresh-token",
  );
  await f.reopen();
  const status = await f.service.status(11);
  expect(status).toMatchObject({
    ok: true,
    status: { userGrant: { grantedLogin: "renamed-owner" } },
  });
  expect(JSON.stringify(status)).not.toContain("synthetic-user-token");
  expect(JSON.stringify(status)).not.toContain("synthetic-refresh-token");
  expect(await f.service.disconnect(11)).toEqual({ ok: true });
  expect(
    JSON.parse(await readFile(join(f.directory, "connections.json"), "utf8"))
      .records,
  ).toEqual([]);
});

test("a new App can wait for installation; a denied existing connection stays visible for disconnect", async () => {
  const f = await fixture();
  expect(await f.connect()).toEqual({ ok: true });
  f.respond(async () => f.fake.json([]));
  expect(await f.service.refresh(11)).toMatchObject({
    code: "installation_missing",
  });
  expect(await f.service.status(11)).toMatchObject({
    ok: true,
    status: { needsDisconnect: false, app: { githubAppId: 110 } },
  });
  f.respond(async () =>
    f.fake.json([{ ...f.fake.install(), repository_selection: "all" }]),
  );
  expect((await f.service.refresh(11)).ok).toBe(false);
  expect(await f.service.status(11)).toMatchObject({
    ok: true,
    status: {
      needsDisconnect: true,
      app: { githubAppId: 110 },
      userGrant: null,
    },
  });
  expect(await f.service.disconnect(11)).toEqual({ ok: true });
});

test("a worker restart invalidates pending consent without exchanging the old manifest", async () => {
  const f = await fixture();
  const begun = await f.start();
  await f.reopen();
  expect(
    await f.service.completeManifest(f.context, {
      state: begun.state,
      code: "old-code",
      operation: PERSONAL_MANIFEST_OPERATION,
    }),
  ).toMatchObject({ code: "manifest_replayed" });
  expect(f.calls()).toBe(0);
});

test("future bindings injected before the first App cannot be overwritten by an empty snapshot", async () => {
  const f = await fixture();
  await writeFile(
    join(f.directory, "connections.json"),
    JSON.stringify({
      version: 1,
      admission: "connections_only",
      bindings: [{ sessionId: "future" }],
      records: [],
    }),
    { mode: 0o600 },
  );
  expect((await f.service.disconnect(11)).ok).toBe(false);
  expect((await f.service.status(11)).ok).toBe(false);
  expect(f.calls()).toBe(0);
});
