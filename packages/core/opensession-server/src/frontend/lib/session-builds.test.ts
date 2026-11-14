import { describe, expect, test } from "bun:test";
import type { SessionBuildWire } from "@tellahq/opensession-protocol/session";
import {
  buildGroupUrl,
  buildsFlapStatus,
  createBuildsClock,
  hideKey,
  visibleBuildGroups,
} from "./session-builds";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function row(overrides: Partial<SessionBuildWire>): SessionBuildWire {
  return {
    id: overrides.id ?? Math.random().toString(36),
    kind: "workflow",
    repo: "acme/app",
    title: "CI",
    state: "success",
    sha: "a1",
    branch: "feature-x",
    startedAt: ago(20),
    updatedAt: ago(1),
    endedAt: ago(1),
    ...overrides,
  };
}

describe("visibleBuildGroups", () => {
  test("groups a merge's workflows and rollouts per app", () => {
    const [group] = visibleBuildGroups(
      [
        row({ title: "Deploy", sha: "m1", prNumber: 4, state: "running" }),
        row({
          kind: "rollout",
          title: "web",
          target: "prod",
          sha: "m1",
          prNumber: 4,
          startedAt: ago(5),
        }),
        row({
          kind: "rollout",
          title: "web",
          target: "dev",
          sha: "m1",
          prNumber: 4,
          startedAt: ago(6),
        }),
      ],
      new Set(),
      NOW,
    );
    expect(group).toMatchObject({ prNumber: 4, live: true, failed: false });
    expect(group!.workflows.map((w) => w.title)).toEqual(["Deploy"]);
    expect(group!.rollouts).toHaveLength(1);
    expect(group!.rollouts[0]!.targets.map((t) => t.target)).toEqual([
      "dev",
      "prod",
    ]);
  });

  test("a newer push replaces the branch's older commit, even a failed one", () => {
    const groups = visibleBuildGroups(
      [
        row({ sha: "old", state: "failure", startedAt: ago(30) }),
        row({ sha: "new", state: "running", startedAt: ago(2) }),
      ],
      new Set(),
      NOW,
    );
    expect(groups.map((g) => g.sha)).toEqual(["new"]);
  });

  test("passing groups leave after a while, failures stay", () => {
    const passed = row({ sha: "p", endedAt: ago(10), updatedAt: ago(10) });
    const failed = row({
      sha: "f",
      branch: "other",
      state: "failure",
      endedAt: ago(60),
    });
    expect(
      visibleBuildGroups([passed, failed], new Set(), NOW).map((g) => g.sha),
    ).toEqual(["f"]);
  });

  test("closing a passing group does not hide a later failure", () => {
    const [ok] = visibleBuildGroups(
      [row({ state: "running" })],
      new Set(),
      NOW,
    );
    const hidden = new Set([hideKey(ok!)]);
    expect(
      visibleBuildGroups([row({ state: "running" })], hidden, NOW),
    ).toEqual([]);
    expect(
      visibleBuildGroups([row({ state: "failure" })], hidden, NOW),
    ).toHaveLength(1);
  });

  test("a rollout that never reports back stops counting as live", () => {
    const [group] = visibleBuildGroups(
      [
        row({
          kind: "rollout",
          title: "web",
          target: "prod",
          sha: "m1",
          prNumber: 4,
          state: "running",
          updatedAt: ago(50),
          endedAt: undefined,
        }),
      ],
      new Set(),
      NOW,
    );
    // Not live, not failed, ended long ago: nothing left to show.
    expect(group).toBeUndefined();
  });
});

describe("buildGroupUrl", () => {
  test("links a deploy to its PR and a branch build to its commit", () => {
    const [deploy] = visibleBuildGroups(
      [row({ sha: "m1", prNumber: 4 })],
      new Set(),
      NOW,
    );
    const [branch] = visibleBuildGroups([row({ sha: "b2" })], new Set(), NOW);
    expect(buildGroupUrl(deploy!)).toBe("https://github.com/acme/app/pull/4");
    expect(buildGroupUrl(branch!)).toBe(
      "https://github.com/acme/app/commit/b2",
    );
  });
});

describe("buildsFlapStatus", () => {
  test("says whether a flap shows and whether it still runs", () => {
    const flapStatus = (rows: SessionBuildWire[], now = NOW) =>
      buildsFlapStatus(visibleBuildGroups(rows, new Set(), now));
    expect(flapStatus([])).toBe("none");
    expect(flapStatus([row({ state: "running", endedAt: undefined })])).toBe(
      "live",
    );
    expect(flapStatus([row({})])).toBe("ended");
    expect(flapStatus([row({})], NOW + 10 * 60_000)).toBe("none");
  });
});

describe("createBuildsClock", () => {
  test("hands each tick to its subscribers until they leave", () => {
    const clock = createBuildsClock(1);
    const seen: number[] = [];
    const off = clock.subscribe(() => seen.push(clock.get()));
    clock.set(2);
    off();
    clock.set(3);
    expect(seen).toEqual([2]);
    expect(clock.get()).toBe(3);
  });
});
