import { describe, expect, test } from "bun:test";
import { ghPrView, type GhPrViewDeps } from "./session-repos";

function deps(
  result: { out?: string; err?: string; code?: number },
  credential: () => Promise<Record<string, string>> = async () => ({
    GH_TOKEN: "repo-token",
  }),
) {
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  const value: GhPrViewDeps = {
    credentialEnv: () => credential(),
    async run(args, env) {
      calls.push({ args, env });
      return {
        out: result.out ?? "",
        err: result.err ?? "",
        code: result.code ?? 0,
      };
    },
  };
  return { value, calls };
}

describe("ghPrView", () => {
  test("reads the PR with a credential minted for its repository", async () => {
    const seen: string[] = [];
    const { value, calls } = deps(
      {
        out: JSON.stringify({
          headRefName: "feature",
          number: 42,
          url: "https://github.com/acme/app/pull/42",
          title: "Add feature",
        }),
      },
      async () => ({ GH_TOKEN: "repo-token" }),
    );
    const credentialEnv = value.credentialEnv;
    value.credentialEnv = (repo) => {
      seen.push(repo);
      return credentialEnv(repo);
    };
    expect(await ghPrView("acme/app", "42", value)).toEqual({
      branch: "feature",
      number: 42,
      url: "https://github.com/acme/app/pull/42",
      title: "Add feature",
    });
    expect(seen).toEqual(["acme/app"]);
    expect(calls[0].env.GH_TOKEN).toBe("repo-token");
    expect(calls[0].args).toContain("--repo");
    expect(calls[0].args).toContain("acme/app");
  });

  test("a PR GitHub does not know is null, not an error", async () => {
    const { value } = deps({
      code: 1,
      err: "GraphQL: Could not resolve to a PullRequest with the number of 9.",
    });
    expect(await ghPrView("acme/app", "9", value)).toBeNull();
    const branch = deps({
      code: 1,
      err: 'no pull requests found for branch "wip"',
    });
    expect(await ghPrView("acme/app", "wip", branch.value)).toBeNull();
  });

  test("surfaces gh's own reason for any other failure", async () => {
    const { value } = deps({
      code: 4,
      err: "To get started with GitHub CLI, please run:  gh auth login\n",
    });
    await expect(ghPrView("acme/app", "7", value)).rejects.toThrow(
      "Couldn't look up PR #7 in acme/app: To get started with GitHub CLI",
    );
  });

  test("surfaces a missing repository credential", async () => {
    const { value, calls } = deps({}, async () => {
      throw new Error("The selected GitHub bot credential is unavailable");
    });
    await expect(ghPrView("acme/app", "feature", value)).rejects.toThrow(
      "Couldn't look up branch feature in acme/app: The selected GitHub bot credential is unavailable",
    );
    expect(calls).toHaveLength(0);
  });
});
