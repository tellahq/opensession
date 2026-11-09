import { describe, expect, test } from "bun:test";
import {
  githubGitCredentialEnv,
  withOwnerCredentials,
  withReadRepoCredentials,
} from "./github-git-credential";
import { INLINE_GITHUB_CREDENTIAL_HELPER } from "./remote-workspace";

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

function baseEnv() {
  return githubGitCredentialEnv(
    "primary-token",
    INLINE_GITHUB_CREDENTIAL_HELPER,
  );
}

describe("owner-scoped GitHub credentials", () => {
  test("git answers each owner with its own token and every other owner with the primary one", () => {
    const env = withOwnerCredentials(baseEnv(), [
      { owner: "OctoCat", token: "personal-token" },
    ]);
    expect(gitPassword(env, "https://github.com/OctoCat/fork.git")).toBe(
      "personal-token",
    );
    expect(gitPassword(env, "https://github.com/octocat/fork")).toBe(
      "personal-token",
    );
    expect(gitPassword(env, "https://github.com/acme/app.git")).toBe(
      "primary-token",
    );
    // Scoped at a path boundary: a longer login is someone else.
    expect(gitPassword(env, "https://github.com/octocat2/x.git")).toBe(
      "primary-token",
    );
  });

  test("a newer token for the same owner replaces the older helper", () => {
    const first = withOwnerCredentials(baseEnv(), [
      { owner: "octocat", token: "old-token" },
    ]);
    const second = withOwnerCredentials(first, [
      { owner: "OCTOCAT", token: "new-token" },
    ]);
    expect(gitPassword(second, "https://github.com/octocat/fork.git")).toBe(
      "new-token",
    );
    expect(gitPassword(second, "https://github.com/OCTOCAT/fork.git")).toBe(
      "new-token",
    );
  });

  test("keeps read-repo routing and the SSH rewrites", () => {
    const env = withReadRepoCredentials(
      {
        ...withOwnerCredentials(baseEnv(), [
          { owner: "octocat", token: "personal-token" },
        ]),
        GH_READ_TOKEN: "read-token",
      },
      ["acme/dep"],
    );
    expect(gitPassword(env, "https://github.com/acme/dep.git")).toBe(
      "read-token",
    );
    expect(gitPassword(env, "https://github.com/octocat/fork.git")).toBe(
      "personal-token",
    );
    expect(gitPassword(env, "https://github.com/acme/app.git")).toBe(
      "primary-token",
    );
    const values = Object.entries(env)
      .filter(([key]) => key.startsWith("GIT_CONFIG_VALUE_"))
      .map(([, value]) => value);
    expect(values).toContain("git@github.com:");
    expect(values).toContain("ssh://git@github.com/");
  });

  test("ignores invalid owners and empty tokens", () => {
    const env = baseEnv();
    expect(
      withOwnerCredentials(env, [
        { owner: "../evil", token: "x" },
        { owner: "octocat", token: "" },
      ]),
    ).toEqual(env);
  });
});
