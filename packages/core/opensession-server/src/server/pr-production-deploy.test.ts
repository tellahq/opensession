import { beforeEach, describe, expect, test } from "bun:test";
import type { PrDetails } from "./pr-contract";
import {
  __resetProductionDeployForTest,
  withProductionDeploy,
} from "./pr-production-deploy";

const config = () => ({
  environment: "Production – acme",
  url: "https://acme.example",
});

function details(overrides: Partial<PrDetails> = {}): PrDetails {
  return {
    number: 7,
    title: "Change",
    url: "https://github.com/acme/app/pull/7",
    state: "MERGED",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature",
    mergeCommitOid: "merge",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: "",
    author: "octo",
    body: "",
    checks: [],
    comments: [],
    commits: [],
    files: [],
    reviewers: [],
    mergeable: "UNKNOWN",
    mergeStateStatus: "",
    staging: { url: "https://app-git-feature.acme.example", status: "Ready" },
    ...overrides,
  };
}

/** A fake GitHub: deployments newest first, each with its latest status, and
 *  which commits the deployed one includes. */
function github(
  deployments: Array<{ sha: string; state: string }>,
  includes: Record<string, string[]> = {},
) {
  const calls: string[] = [];
  const read = async (_repo: string, path: string) => {
    calls.push(path);
    if (path.includes("/deployments?"))
      return {
        ok: true,
        data: deployments.map((d, i) => ({ id: i + 1, sha: d.sha })),
      };
    const status = path.match(/\/deployments\/(\d+)\/statuses/);
    if (status)
      return {
        ok: true,
        data: [{ state: deployments[Number(status[1]) - 1]!.state }],
      };
    const compare = path.match(/\/compare\/(\w+)\.\.\.(\w+)/);
    if (compare)
      return {
        ok: true,
        data: {
          status: includes[compare[2]!]?.includes(compare[1]!)
            ? "ahead"
            : "diverged",
        },
      };
    return { ok: false, data: null };
  };
  return { read: read as any, calls };
}

beforeEach(() => __resetProductionDeployForTest());

describe("withProductionDeploy", () => {
  test("keeps the preview while production has not deployed the merge", async () => {
    const { read } = github([
      { sha: "merge", state: "in_progress" },
      { sha: "older", state: "success" },
    ]);
    const out = await withProductionDeploy(details(), "acme/app", {
      read,
      config,
    });
    expect(out?.staging).toEqual({
      url: "https://app-git-feature.acme.example",
      status: "Ready",
      awaitingProduction: true,
    });
  });

  test("hands over to production once the merge commit is deployed", async () => {
    const { read } = github([{ sha: "merge", state: "success" }]);
    const out = await withProductionDeploy(details(), "acme/app", {
      read,
      config,
    });
    expect(out?.staging).toEqual({
      url: "https://acme.example",
      status: "Ready",
      live: true,
      production: true,
    });
  });

  test("counts a later deploy that includes the merge", async () => {
    const { read } = github([{ sha: "newer", state: "success" }], {
      newer: ["merge"],
    });
    const out = await withProductionDeploy(details(), "acme/app", {
      read,
      config,
    });
    expect(out?.staging?.production).toBe(true);
  });

  test("leaves open PRs, PRs without a preview, and unconfigured repos alone", async () => {
    const { read, calls } = github([{ sha: "merge", state: "success" }]);
    const open = details({ state: "OPEN" });
    expect(await withProductionDeploy(open, "acme/app", { read, config })).toBe(
      open,
    );
    const noPreview = details({ staging: null });
    expect(
      await withProductionDeploy(noPreview, "acme/app", { read, config }),
    ).toBe(noPreview);
    const merged = details();
    expect(
      await withProductionDeploy(merged, "acme/app", {
        read,
        config: () => null,
      }),
    ).toBe(merged);
    expect(calls).toEqual([]);
  });

  test("shares one recent answer across PRs of the same repo", async () => {
    const { read, calls } = github([{ sha: "merge", state: "success" }]);
    await withProductionDeploy(details(), "acme/app", { read, config });
    await withProductionDeploy(details(), "acme/app", { read, config });
    expect(calls.filter((c) => c.includes("/deployments?"))).toHaveLength(1);
  });
});
