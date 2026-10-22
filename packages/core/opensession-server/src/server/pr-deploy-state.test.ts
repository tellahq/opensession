import { describe, expect, test } from "bun:test";
import { withPrDeploy } from "./pr-deploy-state";
import { awaitingPrDeploy, PR_DEPLOY_WAIT_MS } from "../shared/pr-deploy";
import { mergesCoveredByDeploy } from "../agents/github/session-notify";

const deploying = {
  repoId: "acme",
  prNumber: 7,
  sha: "aaa",
  state: "deploying" as const,
  at: "2026-01-01T00:00:00.000Z",
};
const start = Date.parse(deploying.at);

describe("awaitingPrDeploy", () => {
  test("holds a merged PR until its deploy finishes", () => {
    expect(
      awaitingPrDeploy([deploying], { repoId: "acme", prNumber: 7 }, start),
    ).toBe(true);
    const deployed = withPrDeploy([deploying], {
      ...deploying,
      state: "deployed",
    });
    expect(
      awaitingPrDeploy(deployed, { repoId: "acme", prNumber: 7 }, start),
    ).toBe(false);
  });

  test("a PR without deploy tracking is live at merge", () => {
    expect(awaitingPrDeploy(undefined, { repoId: "acme", prNumber: 7 })).toBe(
      false,
    );
    expect(
      awaitingPrDeploy([deploying], { repoId: "acme", prNumber: 8 }, start),
    ).toBe(false);
    expect(
      awaitingPrDeploy([deploying], { repoId: "other", prNumber: 7 }, start),
    ).toBe(false);
  });

  test("stops waiting on a deploy that never reported back", () => {
    expect(
      awaitingPrDeploy(
        [deploying],
        { repoId: "acme", prNumber: 7 },
        start + PR_DEPLOY_WAIT_MS + 1,
      ),
    ).toBe(false);
  });

  test("keeps holding a failed deploy", () => {
    const failed = withPrDeploy([deploying], { ...deploying, state: "failed" });
    expect(
      awaitingPrDeploy(
        failed,
        { repoId: "acme", prNumber: 7 },
        start + PR_DEPLOY_WAIT_MS + 1,
      ),
    ).toBe(true);
  });
});

describe("withPrDeploy", () => {
  test("a deployed PR stays deployed when its own run fails later", () => {
    const deployed = withPrDeploy([deploying], {
      ...deploying,
      state: "deployed",
    });
    expect(withPrDeploy(deployed, { ...deploying, state: "failed" })).toBe(
      deployed,
    );
  });

  test("keeps the time the wait started", () => {
    const [record] = withPrDeploy([deploying], {
      ...deploying,
      state: "deployed",
      at: "2026-01-01T01:00:00.000Z",
    });
    expect(record.at).toBe(deploying.at);
  });
});

describe("mergesCoveredByDeploy", () => {
  const entry = (recordedAt: string, ghRepo = "acme/app") => ({
    prNumber: 1,
    title: "",
    headRef: "x",
    sessionIds: [],
    recordedAt,
    ghRepo,
  });
  test("covers its own merge and earlier merges in the same repo", () => {
    const pending = {
      own: entry("2026-01-01T00:10:00.000Z"),
      earlier: entry("2026-01-01T00:00:00.000Z"),
      later: entry("2026-01-01T00:20:00.000Z"),
      elsewhere: entry("2026-01-01T00:00:00.000Z", "acme/other"),
    };
    expect(
      mergesCoveredByDeploy(
        pending,
        { head_sha: "own", created_at: "2026-01-01T00:05:00.000Z" },
        "acme/app",
      ).sort(),
    ).toEqual(["earlier", "own"]);
  });
});
