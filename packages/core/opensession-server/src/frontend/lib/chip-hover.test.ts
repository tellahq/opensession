import { describe, expect, test } from "bun:test";
import { chipPr, chipPrIsWorthShowing, chipTarget } from "./chip-hover";
import type { OpenPr, RecentPr } from "./api";
import type { UnifiedSession } from "./types";

// The chips are HTML the markdown renderer wrote, so the only handle the card
// has on them is their data attributes. A fake element is enough to pin that.
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    createElement: () => ({ dataset: {} }),
  },
});

const chip = (dataset: Record<string, string>) => {
  const element = document.createElement("span");
  Object.assign(element.dataset, dataset);
  return element;
};

const session = (over: Partial<UnifiedSession>): UnifiedSession => ({
  id: "os-1",
  title: "Give the PR chips a hover card",
  source: "opensession",
  branch: "chip-hover-cards",
  worktreeDir: null,
  startedBy: "kent",
  createdAt: "2026-08-14T09:00:00.000Z",
  lastActivity: "2026-08-14T10:00:00.000Z",
  isRunning: false,
  ...over,
});

const openPr = (over: Partial<OpenPr>): OpenPr => ({
  repo: "opensession",
  branch: "chip-hover-cards",
  url: "https://github.com/tellahq/opensession/pull/128",
  number: 128,
  title: "Hover cards for transcript chips",
  isDraft: false,
  reviewDecision: "",
  author: "kentdebruin",
  person: "kent",
  createdAt: "2026-08-14T08:00:00.000Z",
  updatedAt: "2026-08-14T09:30:00.000Z",
  checks: { total: 4, passed: 4, failed: 0, pending: 0 },
  ...over,
});

const recentPr = (over: Partial<RecentPr>): RecentPr => ({
  ...openPr({}),
  state: "MERGED",
  additions: 120,
  deletions: 24,
  ...over,
});

describe("chipTarget", () => {
  test("reads a session chip", () => {
    expect(chipTarget(chip({ sessionId: "os-019f" }))).toEqual({
      kind: "session",
      key: "session:os-019f",
      id: "os-019f",
    });
  });

  test("reads a PR chip", () => {
    expect(
      chipTarget(chip({ prRepo: "opensession", prNumber: "128" })),
    ).toEqual({
      kind: "pr",
      key: "pr:opensession#128",
      repo: "opensession",
      number: 128,
    });
  });

  test("ignores an anchor that names neither", () => {
    expect(chipTarget(chip({ assetPath: "shot.png" }))).toBeNull();
  });
});

describe("chipPr", () => {
  test("is null when nothing loaded knows the PR", () => {
    expect(chipPr("opensession", 128, [], [])).toBeNull();
    expect(chipPrIsWorthShowing(null)).toBe(false);
  });

  test("takes the rich half from the open list and the session that owns it", () => {
    const owner = session({
      repo: "opensession",
      prNumber: 128,
      branch: "chip-hover-cards",
    });
    const pr = chipPr("opensession", 128, [owner], [openPr({})]);
    expect(pr?.title).toBe("Hover cards for transcript chips");
    expect(pr?.author).toBe("kentdebruin");
    expect(pr?.session?.id).toBe("os-1");
    expect(chipPrIsWorthShowing(pr)).toBe(true);
  });

  test("a PR no session owns still resolves from the open list", () => {
    const pr = chipPr("opensession", 128, [], [openPr({})]);
    expect(pr?.title).toBe("Hover cards for transcript chips");
    expect(pr?.session).toBeUndefined();
  });

  // The open-PR list is cached for a minute and holds only open PRs, so a PR
  // the session list already saw merge must not read as open.
  test("lifecycle comes from the fresher session list", () => {
    const owner = session({
      repo: "opensession",
      prNumber: 128,
      prState: "MERGED",
    });
    expect(chipPr("opensession", 128, [owner], [openPr({})])?.state).toBe(
      "MERGED",
    );
  });

  test("an archived PR resolves from recent history without a live session", () => {
    const pr = chipPr("opensession", 128, [], [], [recentPr({})]);
    expect(pr).toMatchObject({
      title: "Hover cards for transcript chips",
      state: "MERGED",
      additions: 120,
      deletions: 24,
    });
    expect(chipPrIsWorthShowing(pr)).toBe(true);
  });

  test("terminal history beats stale open session and open-list state", () => {
    const owner = session({
      repo: "opensession",
      prNumber: 128,
      prState: "OPEN",
    });
    const pr = chipPr(
      "opensession",
      128,
      [owner],
      [openPr({})],
      [recentPr({ state: "CLOSED" })],
    );
    expect(pr?.state).toBe("CLOSED");
  });

  test("keeps richer live conflict status while a PR remains open", () => {
    const owner = session({
      repo: "opensession",
      prNumber: 128,
      prState: "OPEN",
      prMergeable: "CONFLICTING",
    });
    const pr = chipPr(
      "opensession",
      128,
      [owner],
      [openPr({ mergeable: "UNKNOWN" })],
      [recentPr({ state: "OPEN", mergeable: "UNKNOWN" })],
    );
    expect(pr?.mergeable).toBe("CONFLICTING");
  });

  test("falls back to the PRs a session merely spans", () => {
    const spanning = session({
      repo: "tella-fusion",
      prs: [
        {
          repo: "opensession",
          branch: "chip-hover-cards",
          source: "attached",
          number: 128,
          title: "Hover cards for transcript chips",
          state: "OPEN",
        },
      ],
    });
    const pr = chipPr("opensession", 128, [spanning], []);
    expect(pr?.title).toBe("Hover cards for transcript chips");
    expect(pr?.branch).toBe("chip-hover-cards");
  });
});
