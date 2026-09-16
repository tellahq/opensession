import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePersonalGithubRoutes } from "./personal-github";
import type { RouteContext } from "./context";
import { openTrustedHostConnections } from "../personal-github/service";
import type {
  PersonalConnectionClient,
  ConnectionMethod,
  PersonalConnectionService,
} from "../personal-github/worker-protocol";
import { PERSONAL_CONNECTION_DISCLOSURE } from "../personal-github/disclosure";
import { syntheticFixture } from "../personal-github/synthetic.test-support";
const savedConfig = process.env.OPENSESSION_CONFIG;
let directory: string;
let opened: Awaited<ReturnType<typeof openTrustedHostConnections>>;
let client: PersonalConnectionClient;
let fake: ReturnType<typeof syntheticFixture>;
let calls: number;
let appName: string;
const alice = { login: "alice", name: "Alice", githubAccountId: 11 };
const bob = { login: "bob", name: "Bob", githubAccountId: 12 };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "personal-github-routes-"));
  process.env.OPENSESSION_CONFIG = join(directory, "config.json");
  await writeFile(
    process.env.OPENSESSION_CONFIG,
    JSON.stringify({
      integrations: {
        github: { userPrAuth: true, oauthClientId: "synthetic" },
      },
    }),
  );
  fake = syntheticFixture();
  calls = 0;
  appName = "";
  opened = await openTrustedHostConnections({
    directory: join(directory, "broker"),
    transport: async () => {
      calls++;
      return fake.json(fake.converted(appName), 201);
    },
  });
  client = {
    call<K extends ConnectionMethod>(
      method: K,
      ...args: Parameters<PersonalConnectionService[K]>
    ): ReturnType<PersonalConnectionService[K]> {
      const call = opened.connections[method] as (
        ...args: unknown[]
      ) => Promise<unknown>;
      return call(...args) as ReturnType<PersonalConnectionService[K]>;
    },
  };
});
afterEach(async () => {
  await opened.close();
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  await rm(directory, { recursive: true, force: true });
});
function context(
  path: string,
  method = "GET",
  authUser: RouteContext["authUser"] = alice,
  body?: unknown,
  cookie?: string,
): RouteContext {
  const url = new URL(path, "https://demo.example");
  return {
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser,
    req: new Request(url, {
      method,
      headers: {
        cookie: `opensession_auth=${cookie ?? `browser-${authUser?.githubAccountId ?? "unknown"}`}`,
        origin: url.origin,
        ...(url.pathname.endsWith("/manifest/callback")
          ? {}
          : {
              "X-OpenSession-Privacy": "personal-v1",
              "X-OpenSession-Expected-GitHub-Account-Id": String(
                authUser?.githubAccountId ?? "",
              ),
            }),
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  };
}
const run = (ctx: RouteContext) => handlePersonalGithubRoutes(ctx, client);
async function begin() {
  const accepted = await run(
    context("/api/personal/github/disclosure", "POST", alice, {
      version: PERSONAL_CONNECTION_DISCLOSURE.version,
      accepted: true,
    }),
  );
  const receipt = await accepted!.json();
  const started = await run(
    context("/api/personal/github/manifest", "POST", alice, {
      disclosureReceipt: receipt.disclosureReceipt,
    }),
  );
  const manifest = await started!.json();
  appName = JSON.parse(manifest.manifest).name;
  return manifest;
}

test("anonymous/automation/legacy identities cannot spoof verified account from JSON", async () => {
  for (const identity of [
    null,
    { login: "alice", name: "Alice" },
    { ...alice, automation: true },
  ]) {
    const response = await run(
      context("/api/personal/github/disclosure", "POST", identity, {
        githubAccountId: 11,
        accepted: true,
        version: PERSONAL_CONNECTION_DISCLOSURE.version,
      }),
    );
    expect(response?.status).toBe(401);
    expect(await response?.json()).toMatchObject({
      code: "verified_signin_required",
    });
  }
  expect(calls).toBe(0);
});

test("status publishes current disclosure and verified owner, not premature repository admission", async () => {
  const response = await run(context("/api/personal/github/status"));
  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(await response?.json()).toMatchObject({
    ok: true,
    ownerGithubAccountId: 11,
    disclosure: PERSONAL_CONNECTION_DISCLOSURE,
    repositoryAdmission: false,
    status: {
      runtime: "shared_trusted_host",
      app: null,
      installation: null,
      userGrant: null,
    },
  });
  expect(
    await run(context("/api/setup/github/manifest", "POST")),
  ).toBeUndefined();
  expect(await run(context("/api/repos"))).toBeUndefined();
  expect(calls).toBe(0);
});

test("receipt precedes manifest and conversion; response is bound to actual browser credential", async () => {
  expect(
    (
      await run(
        context("/api/personal/github/manifest", "POST", alice, {
          accepted: true,
          version: PERSONAL_CONNECTION_DISCLOSURE.version,
        }),
      )
    )?.status,
  ).toBe(400);
  const started = await begin();
  expect(new URL(started.action).searchParams.get("state")).toBe(started.state);
  expect(JSON.parse(started.manifest).public).toBe(false);
  const callback = `/api/personal/github/manifest/callback?state=${started.state}&code=synthetic-code`;
  const wrong = await run(
    context(callback, "GET", alice, undefined, "other-browser"),
  );
  expect(wrong?.status).toBe(404);
  expect(calls).toBe(0);
  expect((await run(context(callback)))?.status).toBe(404);
  const fresh = await begin();
  const success = await run(
    context(
      `/api/personal/github/manifest/callback?state=${fresh.state}&code=synthetic-code`,
    ),
  );
  expect(success?.status).toBe(200);
  const html = await success!.text();
  expect(html).toContain("GitHub App connected");
  expect(html).toContain("/settings/myAccounts");
  expect(html).not.toContain("synthetic-code");
  expect(html).not.toContain("secret-110");
  expect(calls).toBe(1);
  const own = await (await run(context("/api/personal/github/status")))!.json();
  expect(own.status.app.githubAppId).toBe(110);
  const other = await (await run(
    context("/api/personal/github/status", "GET", bob),
  ))!.json();
  expect(other).toMatchObject({
    ownerGithubAccountId: 12,
    status: { app: null },
  });
});

test("cross-origin mutations and disclosure-version spoofing are denied without GitHub calls", async () => {
  const ctx = context("/api/personal/github/disclosure", "POST", alice, {
    version: PERSONAL_CONNECTION_DISCLOSURE.version,
    accepted: true,
  });
  ctx.req.headers.set("origin", "https://evil.example");
  expect((await run(ctx))?.status).toBe(403);
  expect(
    (
      await run(
        context("/api/personal/github/disclosure", "POST", alice, {
          version: "old",
          accepted: true,
        }),
      )
    )?.status,
  ).toBe(400);
  expect(calls).toBe(0);
});

test("unknown paths and repo registration remain denied despite acknowledged host trust", async () => {
  await begin();
  expect(
    (
      await run(
        context("/api/personal/repos", "POST", alice, {
          githubAccountId: 11,
          acknowledged: true,
        }),
      )
    )?.status,
  ).toBe(503);
  expect(
    (await run(context("/api/personal/repos/known-other-repo")))?.status,
  ).toBe(404);
  expect(
    (await run(context("/api/personal/github/apps/other/refresh", "POST")))
      ?.status,
  ).toBe(404);
  expect(calls).toBe(0);
});

test("bounded malformed requests and worker failure expose no secret exception", async () => {
  expect(
    (
      await run(
        context("/api/personal/github/disclosure", "POST", alice, {
          junk: "x".repeat(9000),
        }),
      )
    )?.status,
  ).toBe(400);
  const dead = {
    call() {
      throw new Error("secret-token-never-render");
    },
  } as PersonalConnectionClient;
  const response = await handlePersonalGithubRoutes(
    context("/api/personal/github/status"),
    dead,
  );
  expect(response?.status).toBe(503);
  expect(await response!.text()).not.toContain("secret-token");
});

test("coordinator-backed registration uses verified owner and returns only opaque registry metadata", async () => {
  await opened.close();
  const registeredOwners: number[] = [];
  opened = await openTrustedHostConnections({
    directory: join(directory, "broker"),
    coordinator: {
      async register(descriptor) {
        registeredOwners.push(descriptor.ownerGithubAccountId);
        return {
          registryId: `personal-${descriptor.appRecordId}-${descriptor.repositoryId}`,
        };
      },
      async assertCurrent() {},
      async revoke() {},
      async reconcile() {},
    },
    transport: async (url) => {
      calls++;
      if (url.includes("/conversions"))
        return fake.json(fake.converted(appName), 201);
      if (url.includes("/app/installations?"))
        return fake.json([fake.install()]);
      if (url.endsWith("/access_tokens"))
        return fake.json(
          {
            token: "synthetic-discovery-secret",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
          201,
        );
      if (url.includes("/installation/repositories?"))
        return fake.json({ total_count: 1, repositories: [fake.repository()] });
      if (url.endsWith("/installation/token"))
        return new Response(null, { status: 204 });
      throw new Error("Unexpected synthetic GitHub operation");
    },
  });
  const repositoryClient = {
    ...client,
    repositoryAdmission: true,
    register: opened.repositories!.register,
    resolveCredential: opened.repositories!.resolveCredential,
  };
  const started = await begin();
  expect(
    (
      await run(
        context(
          `/api/personal/github/manifest/callback?state=${started.state}&code=synthetic`,
        ),
      )
    )?.status,
  ).toBe(200);
  const status = await (await handlePersonalGithubRoutes(
    context("/api/personal/github/status"),
    repositoryClient,
  ))!.json();
  expect(status.repositoryAdmission).toBe(true);
  const selection = {
    appRecordId: status.status.app.recordId,
    githubAppId: 110,
    installationId: 101,
    repositoryId: 501,
    ownerGithubAccountId: 999,
  };
  const response = await handlePersonalGithubRoutes(
    context("/api/personal/repos", "POST", alice, selection),
    repositoryClient,
  );
  expect(response?.status).toBe(200);
  const body = await response!.json();
  expect(body).toMatchObject({
    ok: true,
    ownerGithubAccountId: 11,
    descriptor: { ownerGithubAccountId: 11, repositoryId: 501 },
  });
  expect(body.registryId).toBe(`personal-${selection.appRecordId}-501`);
  expect(JSON.stringify(body)).not.toContain("synthetic-discovery-secret");
  expect(registeredOwners).toEqual([11]);
  expect(
    (
      await handlePersonalGithubRoutes(
        context("/api/personal/repos", "POST", bob, selection),
        repositoryClient,
      )
    )?.status,
  ).toBe(404);
  for (const endpoint of ["resolveCredential", "credential", "getUserGrant"])
    expect(
      (
        await handlePersonalGithubRoutes(
          context(`/api/personal/github/${endpoint}`, "POST", alice, selection),
          repositoryClient,
        )
      )?.status,
    ).toBe(404);
});

test("personal routes require negotiated privacy and exact captured numeric principal before effects", async () => {
  const unmarked = context("/api/personal/github/status");
  unmarked.req.headers.delete("X-OpenSession-Privacy");
  expect((await run(unmarked))?.status).toBe(404);
  for (const expected of ["12", "011", "", "11.0", "9007199254740992"]) {
    const changed = context("/api/personal/github/disclosure", "POST", alice, {
      accepted: true,
      version: PERSONAL_CONNECTION_DISCLOSURE.version,
    });
    changed.req.headers.set(
      "X-OpenSession-Expected-GitHub-Account-Id",
      expected,
    );
    const response = await run(changed);
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ code: "principal_changed" });
  }
  expect(calls).toBe(0);
});
