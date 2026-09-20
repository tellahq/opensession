import { getConfigAsync } from "./config";
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "slack-session-mode-"));
const previous = {
  OPENSESSION_STATE_DIR: process.env.OPENSESSION_STATE_DIR,
  OPENSESSION_CONFIG: process.env.OPENSESSION_CONFIG,
  OPENSESSION_GITHUB_RUN_AUTH_FILE:
    process.env.OPENSESSION_GITHUB_RUN_AUTH_FILE,
};
process.env.OPENSESSION_STATE_DIR = scratch;
process.env.OPENSESSION_CONFIG = join(scratch, "config.json");
await getConfigAsync();
delete process.env.OPENSESSION_GITHUB_RUN_AUTH_FILE;
const cwd = join(scratch, "repo");
mkdirSync(cwd);
mkdirSync(join(scratch, ".slack-sessions"));
writeFileSync(
  process.env.OPENSESSION_CONFIG,
  JSON.stringify({
    repos: { app: { repo: cwd, ghRepo: "tellahq/app", defaultBranch: "main" } },
  }),
);
await getConfigAsync();
const { readSlackSession, readAgentSessionListRowAsync } =
  await import("./sessions");
const { runGithubEnv } = await import("./pi-runner");
const github = await import("./github-app");
const code = spyOn(github, "githubServiceCredentialEnv").mockResolvedValue({
  GH_TOKEN: "fake-code",
});
const read = spyOn(github, "githubServiceReadOnlyEnv").mockResolvedValue({
  GH_TOKEN: "fake-read",
});

afterAll(() => {
  code.mockRestore();
  read.mockRestore();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

for (const mode of [undefined, "code", "ask"] as const) {
  test(`Slack ${mode ?? "legacy"} metadata retains continuation credential policy`, async () => {
    const key = `C123-${mode ?? "legacy"}`;
    writeFileSync(
      join(scratch, ".slack-sessions", `${key}.json`),
      JSON.stringify({
        channel: "C123",
        threadTs: mode ?? "legacy",
        worktreeDir: cwd,
        createdAt: "2026-09-14T00:00:00.000Z",
        mode,
      }),
    );
    const direct = readSlackSession(`slack-${key}`)!;
    const session = (await readAgentSessionListRowAsync(
      `slack-${key}`,
      undefined,
      null,
    ))!;
    expect(direct).not.toBeNull();
    expect(session).toBeDefined();
    expect(direct.mode).toBe(session.mode);
    // The hosted continuation forwards session.mode unchanged. Exercise the
    // actual credential selector for a machine-authored continuation, not a
    // connected person's token (which could mask the App permission regression).
    const env = await runGithubEnv({
      isCode: session.mode === "code",
      ownerTurn: false,
      githubKindRun: false,
      cwd: session.worktreeDir!,
      launcherEnv: { GH_TOKEN: "must-not-override-ask" },
    });
    expect(env.GH_TOKEN).toBe(mode === "ask" ? "fake-read" : "fake-code");
    expect(session.mode).toBe(mode ?? "code");
  });
}

test("continuation and detached host forward mode to the credential selector", async () => {
  // Contract checks on the glue between the behavioral endpoints above; no
  // model, live credentials, or detached subprocess is needed for this test.
  const continuation = await Bun.file(
    new URL("./run-session.ts", import.meta.url),
  ).text();
  expect(continuation).toMatch(
    /runAgentHosted\(\{[\s\S]*?mode: session\.mode,/,
  );
  const client = await Bun.file(
    new URL("./host-client.ts", import.meta.url),
  ).text();
  expect(client).toContain("mode: opts.mode,");
  const host = await Bun.file(
    new URL("../runner-host/host.ts", import.meta.url),
  ).text();
  expect(host).toContain("mode: spec.mode,");
  const runner = await Bun.file(
    new URL("./pi-runner.ts", import.meta.url),
  ).text();
  expect(runner).toMatch(/runGithubEnv\(\{\s*isCode: mode === "code",/);
});
