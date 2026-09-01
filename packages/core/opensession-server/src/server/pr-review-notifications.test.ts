import { describe, expect, test } from "bun:test";
import { createPrReviewNotifier } from "./pr-review-notifications";
import type { OpenPrEntry } from "./sessions";

function pr(
  number: number,
  reviewRequested: string[],
  repo = "tella-fusion",
): OpenPrEntry {
  return {
    repo,
    branch: `review-${number}`,
    url: `https://github.com/tellahq/${repo}/pull/${number}`,
    number,
    title: `Review PR ${number}`,
    isDraft: false,
    reviewDecision: "",
    author: "author",
    person: null,
    createdAt: "2026-07-22T00:00:00Z",
    updatedAt: "2026-07-22T00:00:00Z",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: "MERGEABLE",
    reviewRequested,
    reviewActive: false,
  };
}

function harness(initial: OpenPrEntry[] = []) {
  let prs = initial;
  let freshRepos = new Set(["tella-fusion"]);
  let refreshCalls = 0;
  const pushes: Array<{ user: string; title: string; url?: string }> = [];
  const notifier = createPrReviewNotifier({
    refresh: async () => {
      refreshCalls++;
      return freshRepos;
    },
    getPrs: () => prs,
    resolveUser: (key) => (key === "alex" ? "Alex" : null),
    sendPush: async (user, payload) => {
      pushes.push({ user, title: payload.title, url: payload.url });
    },
  });
  return {
    notifier,
    pushes,
    setPrs(next: OpenPrEntry[]) {
      prs = next;
    },
    setFresh(next: string[]) {
      freshRepos = new Set(next);
    },
    get refreshCalls() {
      return refreshCalls;
    },
  };
}

describe("GitHub review request push notifications", () => {
  test("seeds existing requests silently and alerts on a new assignment", async () => {
    const h = harness([pr(1, ["alex"])]);
    await h.notifier.pollOnce();
    expect(h.pushes).toEqual([]);

    h.setPrs([pr(1, ["alex"]), pr(2, ["alex"])]);
    await h.notifier.pollOnce();
    expect(h.pushes).toEqual([
      {
        user: "Alex",
        title: "GitHub review requested",
        url: "/pr/tella-fusion/review-2",
      },
    ]);
  });

  test("alerts again after a request is removed and re-added", async () => {
    const h = harness([]);
    await h.notifier.pollOnce();
    h.setPrs([pr(1, ["alex"])]);
    await h.notifier.pollOnce();
    h.setPrs([pr(1, [])]);
    await h.notifier.pollOnce();
    h.setPrs([pr(1, ["alex"])]);
    await h.notifier.pollOnce();
    expect(h.pushes).toHaveLength(2);
  });

  test("does not replace the baseline for an untrusted repository snapshot", async () => {
    const h = harness([pr(1, ["alex"])]);
    await h.notifier.pollOnce();
    h.setFresh([]);
    h.setPrs([]);
    await h.notifier.pollOnce();
    h.setFresh(["tella-fusion"]);
    h.setPrs([pr(1, ["alex"])]);
    await h.notifier.pollOnce();
    expect(h.pushes).toEqual([]);
  });

  test("coalesces concurrent polls", async () => {
    let release!: (repos: Set<string>) => void;
    const refresh = new Promise<Set<string>>((resolve) => {
      release = resolve;
    });
    let refreshCalls = 0;
    const notifier = createPrReviewNotifier({
      refresh: () => {
        refreshCalls++;
        return refresh;
      },
      getPrs: () => [],
      resolveUser: () => null,
      sendPush: async () => {},
    });
    const first = notifier.pollOnce();
    const second = notifier.pollOnce();
    expect(first).toBe(second);
    expect(refreshCalls).toBe(1);
    release(new Set(["tella-fusion"]));
    await first;
  });

  test("suppresses a GitHub transition already pushed by the Reviewer picker", async () => {
    let prs: OpenPrEntry[] = [];
    const pushes: string[] = [];
    const notifier = createPrReviewNotifier({
      refresh: async () => new Set(["tella-fusion"]),
      getPrs: () => prs,
      resolveUser: () => "Alex",
      shouldSuppress: (_pr, reviewer) => reviewer === "alex",
      sendPush: async (user) => {
        pushes.push(user);
      },
    });
    await notifier.pollOnce();
    prs = [pr(1, ["alex"])];
    await notifier.pollOnce();
    expect(pushes).toEqual([]);
  });
});
