import { getConfigAsync } from "./config";
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pi-runner-attached-repos-"));
const previous = {
  OPENSESSION_CONFIG: process.env.OPENSESSION_CONFIG,
  OPENSESSION_GITHUB_RUN_AUTH_FILE:
    process.env.OPENSESSION_GITHUB_RUN_AUTH_FILE,
};
process.env.OPENSESSION_CONFIG = join(scratch, "config.json");
delete process.env.OPENSESSION_GITHUB_RUN_AUTH_FILE;
const app = join(scratch, "app");
const ops = join(scratch, "ops");
const docs = join(scratch, "docs");
for (const dir of [app, ops, docs]) mkdirSync(dir);
writeFileSync(
  process.env.OPENSESSION_CONFIG,
  JSON.stringify({
    repos: {
      app: { repo: app, ghRepo: "acme/app", defaultBranch: "main" },
      ops: { repo: ops, ghRepo: "acme/ops", defaultBranch: "main" },
      docs: {
        repo: docs,
        host: "codestorage",
        csRepo: "acme/docs",
        ghRepo: "",
        defaultBranch: "main",
      },
    },
  }),
);
await getConfigAsync();
const { runGithubEnv } = await import("./pi-runner");
const { attachedGithubRepos, sessionGithubRepos } =
  await import("./session-repos");
const prCache = await import("./pr-cache");
const github = await import("./github-app");
const code = spyOn(github, "githubServiceCredentialEnv").mockImplementation(
  async (ghRepo, also) => ({
    GH_TOKEN: `code:${[ghRepo, ...(also || [])].join(",")}`,
  }),
);
const read = spyOn(github, "githubServiceReadOnlyEnv").mockImplementation(
  async (ghRepo, also) => ({
    GH_TOKEN: `read:${[ghRepo, ...(also || [])].join(",")}`,
  }),
);

const cached = spyOn(prCache, "getPrsByRepo").mockImplementation(
  () => new Map(),
);
// The PR cache: a PR in acme/ops whose attribution footer names session s1.
const footer = spyOn(prCache, "prsBySessionRef").mockImplementation(
  () =>
    new Map([
      [
        "s1",
        [
          {
            repo: "ops",
            branch: "fix",
            pr: {} as import("./pr-cache").PrInfo,
          },
        ],
      ],
    ]),
);

afterAll(() => {
  footer.mockRestore();
  cached.mockRestore();
  code.mockRestore();
  read.mockRestore();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

test("attached repositories resolve to their GitHub names", () => {
  const session = {
    attachedRepos: [
      { repo: "ops", branch: "b", dir: "/w/ops" },
      { repo: "docs", branch: "b", dir: "/w/docs" },
      { repo: "gone", branch: "b", dir: "/w/gone" },
      { repo: "ops", branch: "c", dir: "/w/ops2" },
    ],
  } as Parameters<typeof attachedGithubRepos>[0];
  // Not on GitHub, or no longer registered: nothing to mint for.
  expect(attachedGithubRepos(session)).toEqual(["acme/ops"]);
});

test("the run token also reaches repositories of PRs the session opened", () => {
  // The agent cloned acme/ops instead of attaching it and opened a PR there.
  // A later review handoff for that PR must be able to reply on it.
  const session = {
    id: "s1",
    repo: "app",
    linkedPrs: [{ repo: "docs", branch: "b" }],
  } as Parameters<typeof sessionGithubRepos>[0];
  expect(sessionGithubRepos(session)).toEqual(["acme/ops"]);
  // Automation sessions keep their attached repositories only.
  expect(sessionGithubRepos({ ...session, automationId: "a1" })).toEqual([]);
  // The primary repository is the token's own; it is not listed twice.
  expect(
    sessionGithubRepos({
      ...session,
      repo: "ops",
    } as Parameters<typeof sessionGithubRepos>[0]),
  ).toEqual([]);
});

test("a machine-started turn's App token reaches the attached repositories", async () => {
  // A review handoff or worker report is nobody's turn, so the run holds an
  // App token. It must still reach every repository the session spans.
  const codeEnv = await runGithubEnv({
    isCode: true,
    ownerTurn: false,
    githubKindRun: false,
    cwd: app,
    attachedRepos: ["acme/ops"],
  });
  expect(codeEnv.GH_TOKEN).toBe("code:acme/app,acme/ops");

  const askEnv = await runGithubEnv({
    isCode: false,
    ownerTurn: false,
    githubKindRun: false,
    cwd: app,
    attachedRepos: ["acme/ops"],
  });
  expect(askEnv.GH_TOKEN).toBe("read:acme/app,acme/ops");
});

test("run options carry attached repositories to the credential selector", async () => {
  const runSession = await Bun.file(
    new URL("./run-session.ts", import.meta.url),
  ).text();
  expect(runSession).toContain("attachedRepos: attachedGhRepos,");
  const client = await Bun.file(
    new URL("./host-client.ts", import.meta.url),
  ).text();
  expect(client).toContain("attachedRepos: opts.attachedRepos,");
  expect(client).toContain("attachedRepos: spec.attachedRepos,");
  const host = await Bun.file(
    new URL("../runner-host/host.ts", import.meta.url),
  ).text();
  expect(host).toContain("attachedRepos: spec.attachedRepos,");
  const runner = await Bun.file(
    new URL("./pi-runner.ts", import.meta.url),
  ).text();
  expect(runner).toContain("attachedRepos: opts.attachedRepos,");
});
