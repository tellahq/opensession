import { describe, expect, test } from "bun:test";
import type { PrInfo } from "../../server/pr-cache";
import type { UnifiedSession } from "../../server/types";
import { resolveHandoffOwner } from "./handoff";

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
