import { describe, expect, test } from "bun:test";
import type { ClaudeAccountPublic } from "./claude-accounts";
import type { CodexAccountPublic } from "./codex-accounts";
import type { XaiAccountPublic } from "./xai-accounts";
import { buildUsageReport, windowName } from "./usage-mcp";

const NOW = Date.parse("2026-01-10T12:00:00Z");
const LATER = "2026-01-10T15:00:00.000Z";
const EARLIER = "2026-01-10T11:00:00.000Z";

function claude(over: Partial<ClaudeAccountPublic> = {}): ClaudeAccountPublic {
  return {
    id: "c1",
    name: "Team pool",
    tokenMasked: "sk-…abcd",
    authKind: "setup-token",
    email: "pool@example.test",
    createdAt: EARLIER,
    mode: "shared",
    sidelined: false,
    noUsageScope: false,
    exhaustedUntil: null,
    usable: true,
    usage: {
      fetchedAt: EARLIER,
      fiveHour: { utilization: 40, resetsAt: LATER },
      sevenDay: { utilization: 75, resetsAt: LATER },
      scopedLimits: [{ label: "Fable", utilization: 90, resetsAt: LATER }],
    },
    ...over,
  };
}

const codex: CodexAccountPublic = {
  id: "x1",
  name: "codex",
  kind: "home",
  valueMasked: "~/.codex-1",
  mode: "shared",
  createdAt: EARLIER,
  exhaustedUntil: null,
  usable: true,
  usage: {
    fetchedAt: EARLIER,
    resetCreditsAvailable: null,
    buckets: [
      {
        id: "codex",
        primary: {
          utilization: 20,
          resetsAt: LATER,
          windowDurationMins: 300,
        },
        secondary: {
          utilization: 10,
          resetsAt: LATER,
          windowDurationMins: 10080,
        },
      },
    ],
  },
};

const xai: XaiAccountPublic = {
  id: "g1",
  name: "grok",
  kind: "oauth",
  mode: "shared",
  createdAt: EARLIER,
  exhaustedUntil: null,
  usable: true,
  reloginRequired: false,
  usage: {
    fetchedAt: EARLIER,
    subscriptionTier: "SuperGrok",
    creditUsagePercent: 30,
    periodEnd: LATER,
  },
};

describe("buildUsageReport", () => {
  test("reports remaining percent per limit across providers", () => {
    const report = buildUsageReport({
      now: NOW,
      lists: { claude: [claude()], codex: [codex], xai: [xai] },
    });
    const p = report.providers as Record<string, any>;
    expect(p.claude.list[0].limits).toEqual([
      { name: "5h", usedPercent: 40, remainingPercent: 60, resetsAt: LATER },
      { name: "7d", usedPercent: 75, remainingPercent: 25, resetsAt: LATER },
      {
        name: "Fable weekly",
        usedPercent: 90,
        remainingPercent: 10,
        resetsAt: LATER,
        modelScoped: true,
      },
    ]);
    // Tightest account-wide limit (7d), not the model-scoped cap.
    expect(p.claude.bestRemainingPercent).toBe(25);
    expect(p.codex.list[0].limits.map((l: any) => l.name)).toEqual([
      "5h",
      "7d",
    ]);
    expect(p.codex.bestRemainingPercent).toBe(80);
    expect(p.xai.list[0]).toMatchObject({
      plan: "SuperGrok",
      limits: [{ remainingPercent: 70, resetsAt: LATER }],
    });
    // The email field and masked token stay out; the account name is kept.
    expect(JSON.stringify(report)).not.toContain("example.test");
    expect(JSON.stringify(report)).not.toContain("sk-");
  });

  test("a window whose reset passed reads as empty", () => {
    const report = buildUsageReport({
      now: NOW,
      providers: ["claude"],
      lists: {
        claude: [
          claude({
            usage: {
              fetchedAt: EARLIER,
              fiveHour: { utilization: 99, resetsAt: EARLIER },
              sevenDay: null,
            },
          }),
        ],
        codex: [],
        xai: [],
      },
    });
    const p = report.providers as Record<string, any>;
    expect(p.claude.list[0].limits[0]).toMatchObject({
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: null,
    });
    expect(p.codex).toBeUndefined();
  });

  test("a run without a user sees shared accounts only", () => {
    const lists = {
      claude: [
        claude(),
        claude({ id: "c2", owner: "someone", mode: "personal" }),
      ],
      codex: [],
      xai: [],
    };
    const pool = buildUsageReport({ now: NOW, lists });
    expect((pool.providers as any).claude.accounts).toBe(1);
    expect(pool.scope).toBe("shared pool accounts only");
    const owner = buildUsageReport({ now: NOW, lists, user: "someone" });
    expect((owner.providers as any).claude.accounts).toBe(2);
  });

  test("sidelined accounts report when they return", () => {
    const report = buildUsageReport({
      now: NOW,
      providers: ["claude"],
      lists: {
        claude: [claude({ usable: false, exhaustedUntil: LATER })],
        codex: [],
        xai: [],
      },
    });
    expect((report.providers as any).claude).toMatchObject({
      usableNow: 0,
      nextSidelineEnds: LATER,
    });
  });

  test("windowName", () => {
    expect(windowName(300)).toBe("5h");
    expect(windowName(10080)).toBe("7d");
    expect(windowName(90)).toBe("90m");
    expect(windowName(null)).toBe("window");
  });
});
