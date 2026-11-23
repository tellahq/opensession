import { describe, expect, test } from "bun:test";
import type { PrInfo } from "../../server/pr-cache";
import type { UnifiedSession } from "../../server/types";
import {
  deliverCapFollowUp,
  resolveHandoffOwner,
  settlePassedReview,
} from "./handoff";
import { handoffDecision, type HandoffState } from "./handoff-gates";

const WORKSPACE = "acme-app";
const OPENER = "os-opener";

function session(overrides: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: OPENER,
    mode: "code",
    branch: "feature-c",
    ...overrides,
  } as UnifiedSession;
}

function cachedPr(number: number, sessionRef?: string): PrInfo {
  return { number, ...(sessionRef ? { sessionRef } : {}) } as PrInfo;
}

/** One automation-started session opened PRs #11 (feature-a) and #12
 *  (feature-b) from its worktree, then checked out feature-c. */
function deps(
  overrides: {
    cache?: Record<string, PrInfo>;
    footer?: Record<number, string>;
    sessions?: UnifiedSession[];
    branchOwners?: Record<string, UnifiedSession[]>;
  } = {},
) {
  const sessions = overrides.sessions ?? [
    session({ automation: "Ticket triage" }),
  ];
  const footerReads: number[] = [];
  return {
    footerReads,
    deps: {
      cachedPr: (_workspace: string, branch: string) =>
        overrides.cache?.[branch],
      footerSessionRef: async (prNumber: number) => {
        footerReads.push(prNumber);
        return overrides.footer?.[prNumber];
      },
      getSession: (id: string) => sessions.find((s) => s.id === id),
      branchOwners: async (_workspace: string, branch: string) =>
        overrides.branchOwners?.[branch] ?? [],
    },
  };
}

describe("review handoff owner", () => {
  test("the session that opened the PR owns it while on another branch, even when an automation started it", async () => {
    const { deps: d } = deps({ cache: { "feature-a": cachedPr(11, OPENER) } });
    const owner = await resolveHandoffOwner(
      { number: 11, headRef: "feature-a" },
      WORKSPACE,
      d,
    );
    expect(owner?.id).toBe(OPENER);
  });

  test("a PR not in the bulk cache yet is matched by its footer on GitHub", async () => {
    const { deps: d, footerReads } = deps({ footer: { 12: OPENER } });
    const owner = await resolveHandoffOwner(
      { number: 12, headRef: "feature-b" },
      WORKSPACE,
      d,
    );
    expect(owner?.id).toBe(OPENER);
    expect(footerReads).toEqual([12]);
  });

  test("a cache row for an older PR on the branch does not stand in for this one", async () => {
    const { deps: d, footerReads } = deps({
      cache: { "feature-b": cachedPr(3, "os-someone-else") },
      footer: { 12: OPENER },
    });
    const owner = await resolveHandoffOwner(
      { number: 12, headRef: "feature-b" },
      WORKSPACE,
      d,
    );
    expect(owner?.id).toBe(OPENER);
    expect(footerReads).toEqual([12]);
  });

  test("a cached row for this PR is enough: GitHub is not asked again", async () => {
    const { deps: d, footerReads } = deps({
      cache: { "feature-a": cachedPr(11) },
    });
    expect(
      await resolveHandoffOwner(
        { number: 11, headRef: "feature-a" },
        WORKSPACE,
        d,
      ),
    ).toBeUndefined();
    expect(footerReads).toEqual([]);
  });

  test("an archived opener or a PR agent run falls back to the branch owner", async () => {
    for (const opener of [
      session({ archived: true }),
      session({ id: "bks-ghpr-11-review" }),
      session({ mode: "ask" }),
    ]) {
      const { deps: d } = deps({
        cache: { "feature-a": cachedPr(11, opener.id) },
        sessions: [opener],
        branchOwners: {
          "feature-a": [
            session({ id: "bks-ghpr-11-review" }),
            session({ id: "os-branch" }),
          ],
        },
      });
      const owner = await resolveHandoffOwner(
        { number: 11, headRef: "feature-a" },
        WORKSPACE,
        d,
      );
      expect(owner?.id).toBe("os-branch");
    }
  });

  test("no footer session and nobody on the branch keeps the label path", async () => {
    const { deps: d } = deps({ cache: { "feature-a": cachedPr(11) } });
    expect(
      await resolveHandoffOwner(
        { number: 11, headRef: "feature-a" },
        WORKSPACE,
        d,
      ),
    ).toBeUndefined();
  });

  test("a failed GitHub read keeps the branch lookup", async () => {
    const { deps: d } = deps({
      branchOwners: { "feature-b": [session({ id: "os-branch" })] },
    });
    d.footerSessionRef = async () => {
      throw new Error("rate limited");
    };
    const owner = await resolveHandoffOwner(
      { number: 12, headRef: "feature-b" },
      WORKSPACE,
      d,
    );
    expect(owner?.id).toBe("os-branch");
  });
});

describe("review findings after the round cap", () => {
  const FINDINGS =
    "- [@acme-os[bot] · comment 9 · thread PRRT_1] src/a.ts:3 — P1: guard the null";

  /** Runs reviews of `shas` through the gate and follow-up, keeping state.
   * A sha ending in "+pass" is a passing review with no findings of its own. */
  async function reviewAfterCap(
    shas: string[],
    failFirst = false,
    live = (_id: string) => true,
  ) {
    let handoff: HandoffState = {
      rounds: 6,
      lastSha: "r6",
      sessionId: "os-rounds",
    };
    const sent: { to: string; message: string; deliveryId: string }[] = [];
    let failures = failFirst ? 1 : 0;
    for (const reviewed of shas) {
      const passed = reviewed.endsWith("+pass");
      const sha = reviewed.replace("+pass", "");
      const decision = handoffDecision(handoff, sha, 6);
      // maybeHandoffFindings routes a pass at the round cap here as a post-cap
      // pass, whether or not the capped wrap-up got through.
      if (decision === "duplicate" || decision === "deliver") continue;
      await deliverCapFollowUp(
        {
          pr: { number: 9, title: "Example", headRef: "feature/x" },
          review: passed
            ? { verdict: "approve", confidence: 4, findings: 0 }
            : { verdict: "request_changes", confidence: 3, findings: 1 },
          decision: passed ? "post-cap" : decision,
          passed,
          sha,
          repoFull: "acme/app",
          handoff,
          ownerId: OPENER,
        },
        {
          fetchFindings: async () => FINDINGS,
          sessionExists: live,
          deliver: async (to, message, deliveryId) => {
            if (failures-- > 0) return { status: "error", message: "down" };
            sent.push({ to, message, deliveryId });
            return { status: "delivered" };
          },
          recordCapped: async (reviewed) => {
            handoff = {
              ...handoff,
              cappedAnnounced: true,
              cappedSha: reviewed,
            };
          },
        },
      );
    }
    return sent;
  }

  test("the capped wrap-up carries the final review's findings", async () => {
    const [wrapUp] = await reviewAfterCap(["s1"]);
    expect(wrapUp?.to).toBe("os-rounds");
    expect(wrapUp?.message).toStartWith("<!--os:review-settled:capped-->");
    expect(wrapUp?.message).toContain("P1: guard the null");
  });

  test("a later push's review delivers its findings once per commit", async () => {
    const sent = await reviewAfterCap(["s1", "s1", "s2", "s2", "s3"]);
    expect(sent.map((d) => d.deliveryId)).toEqual([
      "github-review-settled:acme/app:9:capped:s1",
      "github-review-post-cap:acme/app:9:s2",
      "github-review-post-cap:acme/app:9:s3",
    ]);
    const notice = sent[1]!;
    expect(notice.to).toBe(OPENER);
    expect(notice.message).toStartWith("<!--os:review-handoff-->");
    expect(notice.message).toContain("not another fix round");
    expect(notice.message).toContain("P1: guard the null");
  });

  test("the wrap-up goes to the current owner once the round session is gone", async () => {
    const sent = await reviewAfterCap(
      ["s1", "s2"],
      false,
      (id) => id !== "os-rounds",
    );
    expect(sent.map((d) => [d.to, d.deliveryId])).toEqual([
      [OPENER, "github-review-settled:acme/app:9:capped:s1"],
      [OPENER, "github-review-post-cap:acme/app:9:s2"],
    ]);
  });

  test("a pass after the cap reaches the current owner and keeps the cap", async () => {
    const sent = await reviewAfterCap(
      ["s1", "s2+pass", "s2+pass", "s3"],
      false,
      (id) => id !== "os-rounds",
    );
    expect(sent.map((d) => [d.to, d.deliveryId])).toEqual([
      [OPENER, "github-review-settled:acme/app:9:capped:s1"],
      [OPENER, "github-review-settled:acme/app:9:passed:s2"],
      // The cap still stands: a later failing review is a notice, not round 1.
      [OPENER, "github-review-post-cap:acme/app:9:s3"],
    ]);
    expect(sent[1]?.message).toStartWith("<!--os:review-settled:passed-->");
    expect(sent[1]?.message).toContain("P1: guard the null");
  });

  test("a pass after a failed capped wrap-up still keeps the cap", async () => {
    const sent = await reviewAfterCap(["s1", "s2+pass", "s3"], true);
    expect(sent.map((d) => d.deliveryId)).toEqual([
      "github-review-settled:acme/app:9:passed:s2",
      "github-review-post-cap:acme/app:9:s3",
    ]);
  });

  test("a pass with no findings of its own still lists unresolved threads", async () => {
    const [, passed] = await reviewAfterCap(["s1", "s2+pass"]);
    expect(passed?.message).toStartWith("<!--os:review-settled:passed-->");
    expect(passed?.message).toContain("P1: guard the null");
  });

  test("a failed delivery is retried by the next review of that commit", async () => {
    const sent = await reviewAfterCap(["s1", "s1"], true);
    expect(sent.map((d) => d.deliveryId)).toEqual([
      "github-review-settled:acme/app:9:capped:s1",
    ]);
  });
});

describe("a pass below the round cap", () => {
  async function pass(opts: { settled: boolean; notified: boolean }) {
    const steps: string[] = [];
    await settlePassedReview({
      settle: async () => (steps.push("settle"), opts.settled),
      noticeNeeded: (settled) => !settled,
      notify: async () => (steps.push("notify"), opts.notified),
      clear: async () => void steps.push("clear"),
    });
    return steps;
  }

  test("a delivered wrap-up clears the rounds without a notice", async () => {
    expect(await pass({ settled: true, notified: true })).toEqual([
      "settle",
      "clear",
    ]);
  });

  test("a failed fallback notice keeps the rounds for the next review", async () => {
    expect(await pass({ settled: false, notified: false })).toEqual([
      "settle",
      "notify",
    ]);
    expect(await pass({ settled: false, notified: true })).toEqual([
      "settle",
      "notify",
      "clear",
    ]);
  });
});
