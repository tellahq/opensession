import { describe, expect, test } from "bun:test";
import { claudeLimits, liveLimits, liveUtilization } from "./account-usage";

const NOW = Date.parse("2026-08-15T12:00:00Z");
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

describe("liveUtilization", () => {
  test("reads a window that has not reset yet at face value", () => {
    expect(
      liveUtilization(
        { label: "7d", utilization: 92, resetsAt: inHours(96) },
        NOW,
      ),
    ).toBe(92);
  });

  test("counts a window whose reset has passed as empty", () => {
    // The server's picker does the same (currentUtilization); without it a
    // just-reset account reads 100% until the next poll.
    expect(
      liveUtilization(
        { label: "5h", utilization: 100, resetsAt: inHours(-1) },
        NOW,
      ),
    ).toBe(0);
  });

  test("keeps an unknown utilization unknown", () => {
    expect(
      liveUtilization({ label: "5h", utilization: null, resetsAt: null }, NOW),
    ).toBeNull();
  });
});

describe("liveLimits", () => {
  test("keeps every window the account reports a number for", () => {
    const limits = liveLimits(
      [
        { label: "5h", utilization: 4, resetsAt: inHours(3) },
        { label: "7d", utilization: 92, resetsAt: inHours(96) },
        {
          label: "Fable",
          utilization: 89,
          resetsAt: inHours(96),
          scoped: true,
        },
      ],
      NOW,
    );
    expect(limits.map((w) => [w.label, w.utilization])).toEqual([
      ["5h", 4],
      ["7d", 92],
      ["Fable", 89],
    ]);
  });

  test("lists per-model caps after the account's own windows", () => {
    const limits = liveLimits(
      [
        {
          label: "Spark 7d",
          utilization: 0,
          resetsAt: inHours(96),
          scoped: true,
        },
        { label: "Codex 5h", utilization: 12, resetsAt: inHours(2) },
      ],
      NOW,
    );
    expect(limits.map((w) => w.label)).toEqual(["Codex 5h", "Spark 7d"]);
  });

  test("reads a stale window as empty rather than at its stored number", () => {
    const limits = liveLimits(
      [
        { label: "5h", utilization: 100, resetsAt: inHours(-1) },
        { label: "7d", utilization: 40, resetsAt: inHours(96) },
      ],
      NOW,
    );
    expect(limits.map((w) => w.utilization)).toEqual([0, 40]);
  });

  test("leaves out a window with no number rather than drawing it empty", () => {
    const limits = liveLimits(
      [
        { label: "5h", utilization: null, resetsAt: null },
        { label: "7d", utilization: 3, resetsAt: inHours(96) },
      ],
      NOW,
    );
    expect(limits.map((w) => w.label)).toEqual(["7d"]);
  });

  test("has nothing to draw when the account reports no numbers at all", () => {
    expect(
      liveLimits(
        [
          { label: "5h", utilization: null, resetsAt: null },
          { label: "7d", utilization: null, resetsAt: null },
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  test("has nothing to draw for an empty list", () => {
    expect(liveLimits([], NOW)).toEqual([]);
  });
});

describe("claudeLimits", () => {
  test("flattens both windows and every per-model cap, marking the caps scoped", () => {
    expect(
      claudeLimits({
        fiveHour: { utilization: 4, resetsAt: inHours(3) },
        sevenDay: { utilization: 92, resetsAt: inHours(96) },
        scopedLimits: [
          { label: "Fable", utilization: 89, resetsAt: inHours(96) },
        ],
      }),
    ).toEqual([
      { label: "5h", utilization: 4, resetsAt: inHours(3) },
      { label: "7d", utilization: 92, resetsAt: inHours(96) },
      { label: "Fable", utilization: 89, resetsAt: inHours(96), scoped: true },
    ]);
  });

  test("keeps the windows an account omits, so they read as unknown not zero", () => {
    const limits = claudeLimits({ fiveHour: null, sevenDay: null });
    expect(limits.map((w) => w.label)).toEqual(["5h", "7d"]);
    expect(liveLimits(limits, NOW)).toEqual([]);
  });

  test("has nothing to show for an account with no usage", () => {
    expect(claudeLimits(null)).toEqual([]);
  });
});
