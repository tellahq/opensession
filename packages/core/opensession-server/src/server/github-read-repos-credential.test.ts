import { describe, expect, test } from "bun:test";
import {
  githubGitCredentialEnv,
  INLINE_GITHUB_READ_CREDENTIAL_HELPER,
  withReadRepoCredentials,
} from "./github-git-credential";
import {
  INLINE_GITHUB_CREDENTIAL_HELPER,
  remoteCommandEnv,
} from "./remote-workspace";

function runEnv() {
  return withReadRepoCredentials(
    {
      ...githubGitCredentialEnv("main-token", INLINE_GITHUB_CREDENTIAL_HELPER),
      GH_READ_TOKEN: "read-token",
    },
    ["acme/private-dep"],
  );
}

/** What git itself answers for `url` with only this environment's config. */
function gitPassword(env: Record<string, string>, url: string): string {
  const result = Bun.spawnSync(["git", "credential", "fill"], {
    stdin: new TextEncoder().encode(`url=${url}\n\n`),
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: "/nonexistent",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...env,
    },
  });
  return (
    result.stdout
      .toString()
      .split("\n")
      .find((line) => line.startsWith("password="))
      ?.slice("password=".length) ?? ""
  );
}

describe("read-only repositories beside a run's own", () => {
  test("git uses the read token for exactly the listed repositories", () => {
    const env = runEnv();
    expect(gitPassword(env, "https://github.com/acme/private-dep.git")).toBe(
      "read-token",
    );
    expect(gitPassword(env, "https://github.com/acme/private-dep")).toBe(
      "read-token",
    );
    expect(gitPassword(env, "https://github.com/acme/app.git")).toBe(
      "main-token",
    );
  });

  test("the helper list keeps its reset first and its SSH rewrites", () => {
    const env = runEnv();
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    expect(Number(env.GIT_CONFIG_COUNT)).toBe(6);
    expect(Object.values(env)).toContain("git@github.com:");
  });

  test("nothing changes without a read token or with malformed names", () => {
    const base = githubGitCredentialEnv("t", INLINE_GITHUB_CREDENTIAL_HELPER);
    expect(withReadRepoCredentials(base, ["acme/dep"])).toEqual(base);
    const withToken = { ...base, GH_READ_TOKEN: "r" };
    expect(
      withReadRepoCredentials(withToken, ["acme/dep; rm -rf /"])
        .GIT_CONFIG_COUNT,
    ).toBe(base.GIT_CONFIG_COUNT);
  });

  test("a Sandbox command keeps the read helper and still answers", () => {
    const env = remoteCommandEnv(
      runEnv(),
      { scratchDir: "/home/ubuntu/.opensession/session-scratch/s1" },
      "run-1",
      false,
    );
    expect(Object.values(env)).toContain(INLINE_GITHUB_READ_CREDENTIAL_HELPER);
    expect(gitPassword(env, "https://github.com/acme/private-dep.git")).toBe(
      "read-token",
    );
    expect(gitPassword(env, "https://github.com/acme/app.git")).toBe(
      "main-token",
    );
  });
});
