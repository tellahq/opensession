import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runIsolatedTests, testEnvironment } from "./test-isolated";

test("test environments exclude operator credentials, state pointers and runtime bypasses", () => {
  const env = testEnvironment("/private-test-home", {
    PATH: "/bin",
    GH_TOKEN: "secret",
    AWS_ACCESS_KEY_ID: "secret",
    OPENSESSION_STATE_DIR: "/live",
    OPENSESSION_SESSIONS_DIR: "/live/sessions",
    OPENSESSION_CONFIG: "/live/config",
    OPENSESSION_SESSION_KERNEL_TOKEN: "secret",
    OPENSESSION_EXECUTOR: "0",
    OPENSESSION_TEST_IN_PROCESS_RUNS: "1",
    XDG_CONFIG_HOME: "/live/configs",
    NODE_OPTIONS: "--require /live/preload.js",
  });
  expect(env.PATH).toBe("/bin");
  expect(env.HOME).toBe("/private-test-home");
  expect(env.OPENSESSION_CONFIG).toBe("/private-test-home/config.json");
  for (const key of [
    "GH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "OPENSESSION_STATE_DIR",
    "OPENSESSION_SESSIONS_DIR",
    "OPENSESSION_SESSION_KERNEL_TOKEN",
    "OPENSESSION_EXECUTOR",
    "OPENSESSION_TEST_IN_PROCESS_RUNS",
    "NODE_OPTIONS",
  ])
    expect(env[key]).toBeUndefined();
});

test("a repointed fixture and delayed row publication never touch the operator index", async () => {
  const root = await mkdtemp(join(tmpdir(), "isolation-proof-"));
  const report = join(root, "report.json");
  const fixture = join(root, "fixture.test.ts");
  const state = join(root, "state");
  await mkdir(state);
  const operatorIndex = join(state, ".opensession-session-list.db");
  const operatorConfig = join(root, "config.json");
  await writeFile(
    operatorConfig,
    JSON.stringify({ integrations: { aws: { untrustedRuns: true } } }),
  );
  await writeFile(operatorIndex, "untouched");
  const server = resolve(
    import.meta.dir,
    "../packages/core/opensession-server/src/server",
  );
  await writeFile(
    fixture,
    `
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { __setSessionsDirForTest, statePath } from ${JSON.stringify(server + "/paths.ts")};
import { upsertIndexedSession, indexedSession, closeSessionListIndex } from ${JSON.stringify(server + "/session-list-store.ts")};
import { getConfig } from ${JSON.stringify(server + "/config.ts")};
test("publish", async () => {
  expect(getConfig()).toEqual({});
  const fixtureRoot = join(process.env.HOME!, "fixture-sessions");
  mkdirSync(fixtureRoot);
  const previous = __setSessionsDirForTest(fixtureRoot);
  const pending = Bun.sleep(5).then(() => upsertIndexedSession({ id: "os-fixture", source: "opensession", title: "test", createdAt: "2026-09-17T00:00:00Z" } as any));
  __setSessionsDirForTest(previous);
  await pending;
  expect((await indexedSession("os-fixture"))?.id).toBe("os-fixture");
  const path = statePath(".opensession-session-list.db");
  expect(path.startsWith(process.env.HOME! + "/")).toBe(true);
  expect(existsSync(path)).toBe(true);
  writeFileSync(${JSON.stringify(report)}, JSON.stringify({ home: process.env.HOME, path }));
  closeSessionListIndex();
});
`,
  );
  const overrides = {
    HOME: root,
    OPENSESSION_STATE_DIR: state,
    OPENSESSION_CONFIG: operatorConfig,
  };
  const saved = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, overrides);
    expect(await runIsolatedTests([fixture])).toBe(0);
    let result = JSON.parse(await readFile(report, "utf8"));
    expect(result.home).not.toBe(root);
    expect(existsSync(result.home)).toBe(false);

    // Direct Bun invocation is protected by the repository preload as well.
    const env = { ...process.env };
    delete env.OPENSESSION_TEST_ISOLATED_HOME;
    const child = Bun.spawn(
      [process.execPath, "test", "--no-orphans", fixture],
      {
        cwd: resolve(import.meta.dir, ".."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, output] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect({ code, error: code ? output : "" }).toEqual({ code: 0, error: "" });
    result = JSON.parse(await readFile(report, "utf8"));
    expect(result.home).not.toBe(root);
    expect(existsSync(result.home)).toBe(false);
    expect(await readFile(operatorIndex, "utf8")).toBe("untouched");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
