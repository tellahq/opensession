import { expect, test } from "bun:test";
import { githubGitCredentialEnvWithHelper } from "./github-git-credential-env";
import { githubGitCredentialEnv } from "./github-git-credential";

test("pure projection preserves shared wrapper contract with an explicit helper", () => {
  for (const token of ["synthetic-token", ""]) {
    expect(githubGitCredentialEnvWithHelper(token, "!fixed-helper")).toEqual(
      githubGitCredentialEnv(token, "!fixed-helper"),
    );
    expect(
      githubGitCredentialEnvWithHelper(token, "!fixed-helper"),
    ).toMatchObject({
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_VALUE_1: "!fixed-helper",
      GIT_CONFIG_VALUE_2: "git@github.com:",
      GIT_CONFIG_VALUE_3: "ssh://git@github.com/",
    });
  }
});
test("each projection is independent and does not cache another caller's credential", () => {
  const a = githubGitCredentialEnvWithHelper("synthetic-a", "!fixed-helper");
  const b = githubGitCredentialEnvWithHelper("synthetic-b", "!fixed-helper");
  a.GH_TOKEN = "changed";
  expect(b.GH_TOKEN).toBe("synthetic-b");
  expect(githubGitCredentialEnvWithHelper("", "!fixed-helper").GH_TOKEN).toBe(
    "",
  );
});
