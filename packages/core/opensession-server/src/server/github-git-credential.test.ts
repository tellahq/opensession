import { describe, expect, test } from "bun:test";
import {
  githubCredentialHelperCommand,
  githubGitCredentialEnv,
} from "./github-git-credential";

describe("GitHub Git credential environment", () => {
  test("rewrites SSH remotes to process-local HTTPS authority", () => {
    const env = githubGitCredentialEnv("projected-token", "!credential-helper");
    expect(env).toMatchObject({
      GH_TOKEN: "projected-token",
      GITHUB_TOKEN: "projected-token",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_2: "git@github.com:",
      GIT_CONFIG_KEY_3: "url.https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_3: "ssh://git@github.com/",
    });
  });

  test("keeps the HTTPS rewrite when authority is unavailable", () => {
    const env = githubGitCredentialEnv("", "!credential-helper");
    expect(env.GH_TOKEN).toBe("");
    expect(env.GIT_CONFIG_VALUE_2).toBe("git@github.com:");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("never carries a second, git-only credential", () => {
    // One token for API and transport. An operator variable that used to
    // name a separate push credential must stay inert.
    const saved = process.env.OPENSESSION_GITHUB_PUSH_TOKEN;
    process.env.OPENSESSION_GITHUB_PUSH_TOKEN = "github_pat_push_only";
    try {
      const env = githubGitCredentialEnv("projected-token", "!helper");
      expect(Object.values(env)).not.toContain("github_pat_push_only");
      expect(Object.keys(env).some((k) => /PUSH_TOKEN/.test(k))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.OPENSESSION_GITHUB_PUSH_TOKEN;
      else process.env.OPENSESSION_GITHUB_PUSH_TOKEN = saved;
    }
  });
});

describe("GitHub Git credential helper command", () => {
  test("prefers the installed shim", () => {
    expect(
      githubCredentialHelperCommand("/opt/os/bin/opensession", true, true),
    ).toBe("!/opt/os/bin/opensession github-credential");
  });

  test("re-invokes a compiled binary that has no shim, such as the Sandbox runner", () => {
    expect(
      githubCredentialHelperCommand(
        "/home/ubuntu/.opensession/bin/opensession",
        false,
        true,
        "/home/ubuntu/.local/bin/opensession-runner",
      ),
    ).toBe("!/home/ubuntu/.local/bin/opensession-runner github-credential");
  });

  test("runs the source script under bun when developing from source", () => {
    expect(
      githubCredentialHelperCommand("/nowhere/opensession", false, false),
    ).toMatch(/^!bun \S*scripts\/gh-credential\.ts$/);
  });
});
