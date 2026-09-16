import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAuthRoutes } from "./auth";
import type { RouteContext } from "./context";
import * as webAuth from "../web-auth";
import * as githubAuth from "../github-auth";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedStateDir = process.env.OPENSESSION_STATE_DIR;
const dirs: string[] = [];

afterEach(() => {
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  if (savedStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = savedStateDir;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("auth status exposes only the current verified human account id and cannot be cached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensession-auth-identity-"));
  dirs.push(dir);
  process.env.OPENSESSION_CONFIG = join(dir, "config.json");
  process.env.OPENSESSION_STATE_DIR = dir;
  writeFileSync(
    process.env.OPENSESSION_CONFIG,
    JSON.stringify({ organization: { name: "Acme" } }),
  );
  const identity = spyOn(webAuth, "resolveWebAuth");
  const reconnect = spyOn(githubAuth, "githubReconnectRequired");
  const required = spyOn(webAuth, "webAuthRequired").mockReturnValue(true);
  const human = { login: "alice", name: "Alex", githubAccountId: 101 };
  const cases: Array<{
    identity: webAuth.WebIdentity | null;
    reconnect?: boolean;
    expected?: number;
  }> = [
    { identity: human, expected: 101 },
    {
      identity: { ...human, login: "alice-renamed", name: "New name" },
      expected: 101,
    },
    {
      identity: { ...human, login: "bob", githubAccountId: 202 },
      expected: 202,
    },
    { identity: { ...human, automation: true } },
    { identity: human, reconnect: true },
    { identity: { login: "alice", name: "Alex" } },
    { identity: null },
    ...[0, -1, 1.5, "101", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
      (id) => ({
        identity: { ...human, githubAccountId: id as number },
      }),
    ),
  ];
  try {
    for (const fixture of cases) {
      identity.mockReturnValue(fixture.identity);
      reconnect.mockReturnValue(fixture.reconnect ?? false);
      const url = new URL(
        "http://localhost/api/auth/status?githubAccountId=999&login=alice",
      );
      const response = await handleAuthRoutes({
        req: new Request(url, { headers: { "X-GitHub-Account-Id": "999" } }),
        url,
        path: url.pathname,
        publicPrefix: "",
        authUser: { ...human, githubAccountId: 999 },
      });
      expect(response?.status).toBe(200);
      expect(response?.headers.get("Cache-Control")).toBe("no-store");
      const status = await response!.json();
      if (fixture.expected === undefined)
        expect(status).not.toHaveProperty("githubAccountId");
      else expect(status.githubAccountId).toBe(fixture.expected);
    }
  } finally {
    identity.mockRestore();
    reconnect.mockRestore();
    required.mockRestore();
  }
});

test("auth status names the server before sign-in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensession-auth-status-"));
  dirs.push(dir);
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ organization: { name: "Acme" } }));
  process.env.OPENSESSION_CONFIG = config;

  const url = new URL("http://localhost/api/auth/status");
  const context: RouteContext = {
    req: new Request(url),
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser: null,
  };
  const response = await handleAuthRoutes(context);

  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    authenticated: false,
    organizationName: "Acme",
  });
});

test("auth status carries the organization icon when one is configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensession-auth-status-"));
  dirs.push(dir);
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ organization: { name: "Acme" } }));
  process.env.OPENSESSION_CONFIG = config;
  // The icon lives in the state dir (organizationIconPath), not beside the
  // config, so this test isolates that too.
  process.env.OPENSESSION_STATE_DIR = dir;

  const url = new URL("http://localhost/api/auth/status");
  const context: RouteContext = {
    req: new Request(url),
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser: null,
  };
  const without = await handleAuthRoutes(context);
  expect((await without?.json()).organizationIconUrl).toBeNull();

  // An uploaded icon answers with its revisioned static URL, which the sign-in
  // gate can load because static assets stay pre-auth.
  mkdirSync(join(dir, ".opensession-organization"), { recursive: true });
  writeFileSync(
    join(dir, ".opensession-organization", "icon.png"),
    "png-bytes",
  );
  const withIcon = await handleAuthRoutes(context);
  expect((await withIcon?.json()).organizationIconUrl).toMatch(
    /^\/organization-icon\.png\?v=[a-f0-9]{12}$/,
  );
});
