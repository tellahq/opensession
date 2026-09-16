import { expect, test } from "bun:test";
import { runGithubEnv, runGithubMergeGuard } from "./pi-runner";
import { personalCredentialKind } from "./personal-repo-runtime-default";
import type { PersonalRepoBinding } from "./personal-repo-runtime";

const binding: PersonalRepoBinding = {
  registryId: "personal-no-global-repo",
  descriptor: {
    kind: "personal",
    ownerGithubAccountId: 41,
    appRecordId: "app",
    githubAppId: 1,
    installationId: 2,
    repositoryId: 3,
    repositoryOwnerGithubAccountId: 41,
    accessRevision: 1,
    fullName: "owner/private",
  },
};
test("Pi personal branch precedes ask, shared-user and launcher credential selection", async () => {
  for (const [isCode, ownerTurn, kind] of [
    [false, true, "installation-read"],
    [true, true, "installation-write"],
    [true, false, "installation-write"],
  ] as const) {
    let calls = 0;
    const env = await runGithubEnv(
      {
        personalRepo: binding,
        isCode,
        ownerTurn,
        user: "someone",
        githubKindRun: true,
        launcherEnv: { GH_TOKEN: "wrong-shared-token" },
        cwd: "/synthetic/private-not-global",
      },
      async (actual, code, owner) => {
        calls++;
        expect(actual).toBe(binding);
        expect(personalCredentialKind(code, owner)).toBe(kind);
        return {
          GH_TOKEN: `synthetic-${kind}`,
          GITHUB_TOKEN: `synthetic-${kind}`,
        };
      },
    );
    expect(calls).toBe(1);
    expect(env.GH_TOKEN).toBe(`synthetic-${kind}`);
  }
});
test("personal denial or missing projected token never falls through to shared credentials", async () => {
  const input = {
    personalRepo: binding,
    isCode: true,
    ownerTurn: true,
    githubKindRun: true,
    launcherEnv: { GH_TOKEN: "wrong-shared-token" },
    cwd: "/synthetic/private",
  };
  await expect(
    runGithubEnv(input, async () => {
      throw new Error("denied");
    }),
  ).rejects.toThrow("denied");
  await expect(runGithubEnv(input, async () => ({}))).rejects.toThrow(
    "Personal repository credential unavailable",
  );
});

test("unsupported local hosts do not fall back to in-process personal inference", async () => {
  const previous = process.env.OPENSESSION_TEST_IN_PROCESS_RUNS;
  process.env.OPENSESSION_TEST_IN_PROCESS_RUNS = "1";
  try {
    const { runAgentHosted } = await import("./host-client");
    const run = runAgentHosted({
      osSessionId: "synthetic",
      prompt: "synthetic",
      cwd: "/synthetic",
      mode: "code",
      personalRepo: binding,
      mcpServers: [],
      proxyMcpServers: [],
    });
    await expect(run.next()).rejects.toThrow("compatible detached runtime");
  } finally {
    if (previous === undefined)
      delete process.env.OPENSESSION_TEST_IN_PROCESS_RUNS;
    else process.env.OPENSESSION_TEST_IN_PROCESS_RUNS = previous;
  }
});

test("private owner code cannot bypass App publication guards with a human login", () => {
  expect(
    runGithubMergeGuard({
      isCode: true,
      ownerLogin: "owner",
      personalRepo: binding,
      baseBranch: "main",
    }),
  ).toEqual({ baseBranch: "main" });
  expect(
    runGithubMergeGuard({
      isCode: true,
      ownerLogin: "owner",
      baseBranch: "main",
    }),
  ).toBeUndefined();
});
