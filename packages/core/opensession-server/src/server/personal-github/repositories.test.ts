import { personalCredentialKind } from "../personal-repo-runtime-default";
import { PERSONAL_APP_PERMISSIONS } from "./permissions";
import type { PersonalCredentialKind } from "./repository-coordinator";
import { SessionKernelStore } from "../session-kernel/store";
import { __setSessionKernelStoreForTest } from "../session-kernel/kernel";
import {
  createPersonalRepositoryCoordinator,
  readPersonalRepository,
} from "../personal-repository-coordinator";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTrustedHostConnections } from "./service";
import { createPersonalConnectionWorkerClient } from "./worker-client";
import { PERSONAL_CONNECTION_DISCLOSURE } from "./disclosure";
import { PERSONAL_MANIFEST_OPERATION } from "./manifest";
import { syntheticFixture } from "./synthetic.test-support";
import type { PersonalRepositoryCoordinator } from "./repository-coordinator";
import type { PersonalRepositoryDescriptor } from "./types";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(actualCoordinator?: PersonalRepositoryCoordinator) {
  const dir = await mkdtemp(join(tmpdir(), "personal-repository-broker-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const fake = syntheticFixture();
  const bindings = new Map<
    string,
    { descriptor: PersonalRepositoryDescriptor; active: boolean }
  >();
  const events: string[] = [];
  const requests: string[] = [];
  const mints: {
    repository_ids: number[];
    permissions: Record<string, string>;
  }[] = [];
  let failRevoke = false;
  let failRegister = false;
  let failTokenRevoke = false;
  let owner = 11;
  let repoIds = [501];
  let convertedName = "";
  let projected = 0;
  let invalidExpiry = false;
  let mintPause: (() => Promise<void>) | undefined;
  let assertCount = 0;
  let failAssertAt = 0;
  let userOwner: number | undefined;
  const coordinator: PersonalRepositoryCoordinator = actualCoordinator ?? {
    async register(descriptor) {
      const disk = JSON.parse(
        await readFile(join(dir, "connections.json"), "utf8"),
      );
      expect(disk).toMatchObject({ version: 2, admission: "catalog_bound" });
      const registryId = `personal-${descriptor.appRecordId}-${descriptor.repositoryId}`;
      bindings.set(registryId, {
        descriptor: structuredClone(descriptor),
        active: true,
      });
      if (failRegister)
        throw new Error("Lost callback acknowledgement after catalog commit");
      return { registryId };
    },
    async assertCurrent(id, descriptor) {
      if (++assertCount === failAssertAt)
        throw new Error("Catalog changed during mint");
      const binding = bindings.get(
        `personal-${descriptor.appRecordId}-${descriptor.repositoryId}`,
      );
      if (
        id !== descriptor.ownerGithubAccountId ||
        !binding?.active ||
        binding.descriptor.ownerGithubAccountId !== id ||
        binding.descriptor.accessRevision !== descriptor.accessRevision ||
        binding.descriptor.installationId !== descriptor.installationId
      )
        throw new Error("Catalog binding unavailable");
    },
    async revoke(ref) {
      events.push(`revoke:${ref.ownerGithubAccountId}`);
      for (const binding of bindings.values())
        if (binding.descriptor.appRecordId === ref.recordId)
          binding.active = false;
      if (failRevoke) throw new Error("Runtime cancellation not acknowledged");
    },
    async reconcile(ref, installationId, ids, revision) {
      for (const binding of bindings.values())
        if (binding.descriptor.appRecordId === ref.recordId) {
          binding.active = ids.includes(binding.descriptor.repositoryId);
          binding.descriptor = {
            ...binding.descriptor,
            installationId,
            accessRevision: revision,
          };
        }
    },
  };
  const transport: import("./github-api").PersonalGithubTransport = async (
    url,
    init,
  ) => {
    requests.push(url);
    if (url.includes("/conversions"))
      return fake.json(fake.converted(convertedName, owner), 201);
    if (url.includes("/app/installations?"))
      return fake.json([fake.install(owner)]);
    if (url.endsWith("/access_tokens")) {
      const body = JSON.parse(init.body!);
      if (body.repository_ids) {
        expect(body.repository_ids).toHaveLength(1);
        expect(repoIds).toContain(body.repository_ids[0]);
        mints.push(body);
        expect(body.permissions.members).toBeUndefined();
        events.push(`mint:${body.permissions.contents}`);
        projected++;
        await mintPause?.();
      }
      return fake.json(
        {
          token: body.repository_ids ? `projected-${projected}` : "discovery",
          expires_at:
            body.repository_ids && invalidExpiry
              ? "invalid"
              : new Date(fake.now() + 3600_000).toISOString(),
        },
        201,
      );
    }
    if (url.includes("/installation/repositories?"))
      return fake.json({
        total_count: repoIds.length,
        repositories: repoIds.map((id) => fake.repository(owner, id)),
      });
    if (url.endsWith("/installation/token")) {
      const token = init.headers.Authorization;
      events.push(`token-revoke:${token}`);
      if (token?.includes("projected") && failTokenRevoke)
        return fake.json({}, 503);
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/login/device/code"))
      return fake.json({
        device_code: "synthetic-device",
        user_code: "ABCD-EFGH",
        interval: 5,
        expires_in: 900,
      });
    if (url.endsWith("/login/oauth/access_token"))
      return fake.json({
        access_token: "personal-user-token",
        refresh_token: "personal-refresh-token",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
      });
    if (url.endsWith("/user"))
      return fake.json({
        id: userOwner ?? owner,
        login: "renamed-user",
        type: "User",
      });
    if (url.endsWith("/grant")) return new Response(null, { status: 204 });
    throw new Error("Unexpected synthetic GitHub request");
  };
  const opened = await openTrustedHostConnections({
    directory: dir,
    transport,
    coordinator,
    now: fake.now,
  });
  let closed = false;
  const close = async () => {
    if (!closed) {
      await opened.close();
      closed = true;
    }
  };
  cleanup.push(close);
  async function register() {
    const context = fake.context(owner);
    const ack = await opened.connections.acknowledgeDisclosure(context, {
      version: PERSONAL_CONNECTION_DISCLOSURE.version,
      accepted: true,
    });
    if (!ack.ok) throw new Error(ack.code);
    const began = await opened.connections.beginManifest(
      context,
      ack.disclosureReceipt,
    );
    if (!began.ok) throw new Error(began.code);
    convertedName = JSON.parse(began.manifest).name;
    const done = await opened.connections.completeManifest(context, {
      state: began.state,
      code: "synthetic",
      operation: PERSONAL_MANIFEST_OPERATION,
    });
    if (!done.ok) throw new Error(done.code);
    const status = await opened.connections.status(owner);
    if (!status.ok || !status.status.app) throw new Error("Missing app");
    return opened.repositories!.register(owner, {
      appRecordId: status.status.app.recordId,
      githubAppId: owner * 10,
      installationId: 101,
      repositoryId: 501,
    });
  }
  return {
    dir,
    fake,
    opened,
    close,
    coordinator,
    bindings,
    events,
    requests,
    mints,
    transport,
    register,
    owner: (id: number) => {
      owner = id;
    },
    repos: (ids: number[]) => {
      repoIds = ids;
    },
    userOwner: (id: number) => {
      userOwner = id;
    },
    pauseMint: (pause: () => Promise<void>) => {
      mintPause = pause;
    },
    invalidExpiry: () => {
      invalidExpiry = true;
    },
    failAssertAt: (value: number) => {
      failAssertAt = value;
    },
    failRevoke: (value: boolean) => {
      failRevoke = value;
    },
    failRegister: (value: boolean) => {
      failRegister = value;
    },
    failTokenRevoke: (value: boolean) => {
      failTokenRevoke = value;
    },
  };
}

test("catalog registration is durable before callback; scoped token is tracked and revoked", async () => {
  const f = await fixture();
  const registered = await f.register();
  if (!registered.ok) throw new Error(registered.code);
  expect(registered.registryId).toBe(
    `personal-${registered.descriptor.appRecordId}-501`,
  );
  expect(
    await f.opened.repositories!.resolveCredential(
      11,
      registered.descriptor,
      "installation-read",
    ),
  ).toMatchObject({
    ok: true,
    credential: {
      token: "projected-1",
      repositoryId: 501,
      ownerGithubAccountId: 11,
      fullName: "renamed-11/private",
    },
  });
  const disk = JSON.parse(
    await readFile(join(f.dir, "connections.json"), "utf8"),
  );
  expect(disk.records[0].projectedTokens[0].token).toBe("projected-1");
  expect(await f.opened.connections.disconnect(11)).toEqual({ ok: true });
  expect(f.events).toContain("token-revoke:Bearer projected-1");
});

test("A/B overlapping repo ids cannot cross owner/App/installation/revision; no user fallback", async () => {
  const f = await fixture();
  const a = await f.register();
  if (!a.ok) throw new Error(a.code);
  f.owner(12);
  const b = await f.register();
  if (!b.ok) throw new Error(b.code);
  for (const descriptor of [
    a.descriptor,
    { ...b.descriptor, appRecordId: a.descriptor.appRecordId },
    { ...b.descriptor, installationId: 999 },
    { ...b.descriptor, accessRevision: 99 },
  ])
    expect(
      (
        await f.opened.repositories!.resolveCredential(
          12,
          descriptor,
          "installation-write",
        )
      ).ok,
    ).toBe(false);
  expect(
    await f.opened.repositories!.resolveCredential(
      12,
      b.descriptor,
      "user" as PersonalCredentialKind,
    ),
  ).toMatchObject({ code: "credential_denied" });
  expect(f.events.filter((event) => event.startsWith("mint:"))).toHaveLength(0);
  expect(
    await f.opened.repositories!.resolveCredential(
      12,
      b.descriptor,
      "installation-write",
    ),
  ).toMatchObject({ ok: true, credential: { ownerGithubAccountId: 12 } });
});

test("removed repository and changed revision deny old descriptor", async () => {
  const f = await fixture();
  const registered = await f.register();
  if (!registered.ok) throw new Error(registered.code);
  f.repos([]);
  expect(
    (
      await f.opened.repositories!.resolveCredential(
        11,
        registered.descriptor,
        "installation-read",
      )
    ).ok,
  ).toBe(false);
  expect(f.events.filter((event) => event.startsWith("mint:"))).toHaveLength(0);
  expect([...f.bindings.values()][0]?.active).toBe(false);
});

test("failed runtime acknowledgement or token revoke keeps denied retryable state", async () => {
  const f = await fixture();
  const registered = await f.register();
  if (!registered.ok) throw new Error(registered.code);
  expect(
    (
      await f.opened.repositories!.resolveCredential(
        11,
        registered.descriptor,
        "installation-write",
      )
    ).ok,
  ).toBe(true);
  f.failRevoke(true);
  expect((await f.opened.connections.disconnect(11)).ok).toBe(false);
  expect(await f.opened.connections.status(11)).toMatchObject({
    ok: true,
    status: { needsDisconnect: true },
  });
  f.failRevoke(false);
  f.failTokenRevoke(true);
  expect((await f.opened.connections.disconnect(11)).ok).toBe(false);
  expect(
    JSON.parse(await readFile(join(f.dir, "connections.json"), "utf8"))
      .records[0].projectedTokens,
  ).toHaveLength(1);
  f.failTokenRevoke(false);
  expect(await f.opened.connections.disconnect(11)).toEqual({ ok: true });
});

test("lost registration acknowledgement never restores zero-consumer provenance", async () => {
  const f = await fixture();
  f.failRegister(true);
  expect((await f.register()).ok).toBe(false);
  expect(f.bindings.size).toBe(1);
  await f.close();
  await expect(
    openTrustedHostConnections({ directory: f.dir, transport: f.transport }),
  ).rejects.toThrow();
  const reopened = await openTrustedHostConnections({
    directory: f.dir,
    transport: f.transport,
    coordinator: f.coordinator,
  });
  try {
    expect(await reopened.connections.disconnect(11)).toEqual({ ok: true });
  } finally {
    await reopened.close();
  }
});

test("real worker reverse RPC reaches gateway revocation without GitHub calls", async () => {
  const f = await fixture();
  const registered = await f.register();
  if (!registered.ok) throw new Error(registered.code);
  await f.close();
  const worker = createPersonalConnectionWorkerClient(f.dir, f.coordinator);
  try {
    expect(worker.repositoryAdmission).toBe(true);
    expect(await worker.call("disconnect", 11)).toEqual({ ok: true });
    expect([...f.bindings.values()][0]?.active).toBe(false);
  } finally {
    await worker.close();
  }
});

test("broker registration and disconnect enforce the real owner-scoped central catalog", async () => {
  const catalog = new SessionKernelStore(":memory:");
  const old = __setSessionKernelStoreForTest(catalog);
  const revoked: string[] = [];
  try {
    const coordinator = createPersonalRepositoryCoordinator({
      async assertReady() {},
      async revoke(_ref, ids) {
        revoked.push(...ids);
      },
      async reconcile() {},
    });
    const f = await fixture(coordinator);
    const registered = await f.register();
    if (!registered.ok || !registered.registryId)
      throw new Error("Registration failed");
    expect(await readPersonalRepository(11, registered.registryId)).toEqual({
      registryId: registered.registryId,
      descriptor: registered.descriptor,
    });
    const denied = await readPersonalRepository(12, registered.registryId).then(
      () => false,
      () => true,
    );
    expect(denied).toBe(true);
    const credential = await f.opened.repositories!.resolveCredential(
      11,
      registered.descriptor,
      "installation-read",
    );
    expect(credential.ok).toBe(true);
    // All projected-token revocation here uses fake GitHub. The separate
    // reverse-RPC test above has no projected tokens and makes no live call.
    expect(await f.opened.connections.disconnect(11)).toEqual({ ok: true });
    expect(revoked).toContain(registered.registryId);
    const removed = await readPersonalRepository(
      11,
      registered.registryId,
    ).then(
      () => false,
      () => true,
    );
    expect(removed).toBe(true);
  } finally {
    __setSessionKernelStoreForTest(old);
    catalog.close();
  }
});

test("disconnect waits for in-flight projection and revokes its token before acknowledging", async () => {
  const f = await fixture();
  const registered = await f.register();
  if (!registered.ok) throw new Error(registered.code);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.pauseMint(async () => {
    entered();
    await paused;
  });
  const projected = f.opened.repositories!.resolveCredential(
    11,
    registered.descriptor,
    "installation-write",
  );
  await started;
  let acknowledged = false;
  const disconnected = f.opened.connections.disconnect(11).then((result) => {
    acknowledged = true;
    return result;
  });
  expect(acknowledged).toBe(false);
  release();
  expect((await projected).ok).toBe(true);
  expect(await disconnected).toEqual({ ok: true });
  expect(f.events).toContain("token-revoke:Bearer projected-1");
  expect(
    (
      await f.opened.repositories!.resolveCredential(
        11,
        registered.descriptor,
        "installation-write",
      )
    ).ok,
  ).toBe(false);
});

test("catalog change after mint denies token delivery and revokes the durable projection", async () => {
  const f = await fixture();
  const registered = await f.register();
  if (!registered.ok) throw new Error(registered.code);
  f.failAssertAt(2);
  const result = await f.opened.repositories!.resolveCredential(
    11,
    registered.descriptor,
    "installation-read",
  );
  expect(result).toMatchObject({ code: "revoked_during_operation" });
  expect(JSON.stringify(result)).not.toContain("projected-1");
  expect(f.events).toContain("token-revoke:Bearer projected-1");
  expect(await f.opened.connections.status(11)).toMatchObject({
    ok: true,
    status: { needsDisconnect: true },
  });
});

test("uncommitted installation token cleanup failure is durable and cannot expire silently", async () => {
  const f = await fixture();
  const registered = await f.register();
  if (!registered.ok) throw new Error(registered.code);
  f.invalidExpiry();
  f.failTokenRevoke(true);
  const result = await f.opened.repositories!.resolveCredential(
    11,
    registered.descriptor,
    "installation-read",
  );
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain("projected-1");
  const record = JSON.parse(
    await readFile(join(f.dir, "connections.json"), "utf8"),
  ).records[0];
  expect(record.lifecycle).toBe("revoking");
  expect(record.projectedTokens).toEqual([
    { token: "projected-1", expiresAt: Number.MAX_SAFE_INTEGER },
  ]);
  f.failTokenRevoke(false);
  expect(await f.opened.connections.disconnect(11)).toEqual({ ok: true });
});

test("human and machine runtime tokens are narrowed to A when the App also selects B", async () => {
  const f = await fixture();
  f.repos([501, 502]);
  const a = await f.register();
  if (!a.ok) throw new Error(a.code);
  const context = f.fake.context();
  const begun = await f.opened.connections.startGrant(context);
  if (!begun.ok) throw new Error(begun.code);
  f.fake.advance(5000);
  expect(await f.opened.connections.pollGrant(context, begun.flowId)).toEqual({
    ok: true,
    status: "connected",
  });
  for (const [code, human] of [
    [true, true],
    [true, false],
    [false, true],
  ] as const) {
    const kind = personalCredentialKind(code, human);
    const result = await f.opened.repositories!.resolveCredential(
      11,
      a.descriptor,
      kind,
    );
    expect(result).toMatchObject({
      ok: true,
      credential: { kind, repositoryId: 501 },
    });
    expect(JSON.stringify(result)).not.toContain("personal-user-token");
    expect(f.mints.at(-1)?.repository_ids).toEqual([501]);
    expect(f.mints.at(-1)?.permissions).toEqual(
      code
        ? PERSONAL_APP_PERMISSIONS
        : Object.fromEntries(
            Object.keys(PERSONAL_APP_PERMISSIONS).map((key) => [key, "read"]),
          ),
    );
    const disk = JSON.parse(
      await readFile(join(f.dir, "connections.json"), "utf8"),
    );
    expect(disk.records[0].projectedTokens).toHaveLength(f.mints.length);
  }
  const before = f.requests.length;
  expect(
    await f.opened.repositories!.resolveCredential(
      11,
      a.descriptor,
      "user" as PersonalCredentialKind,
    ),
  ).toMatchObject({ ok: false, code: "credential_denied" });
  expect(f.requests).toHaveLength(before);
  expect(await f.opened.connections.disconnect(11)).toEqual({ ok: true });
  for (let i = 1; i <= 3; i++)
    expect(f.events).toContain(`token-revoke:Bearer projected-${i}`);
});

test("existing catalog-bound worker dispatches callbacks to the latest coordinator without restart", async () => {
  const f = await fixture();
  const registered = await f.register();
  if (!registered.ok) throw new Error(registered.code);
  await f.close();
  let current = f.coordinator;
  let updatedCalls = 0;
  const worker = createPersonalConnectionWorkerClient(f.dir, () => current);
  try {
    expect((await worker.call("status", 11)).ok).toBe(true);
    current = {
      ...f.coordinator,
      async revoke(ref) {
        updatedCalls++;
        await f.coordinator.revoke(ref);
      },
    };
    expect(await worker.call("disconnect", 11)).toEqual({ ok: true });
    expect(updatedCalls).toBe(1);
  } finally {
    await worker.close();
  }
});
