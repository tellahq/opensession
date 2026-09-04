import { describe, expect, test } from "bun:test";
import {
  accountLimitsFromUsage,
  accountUsageSchema,
  lowestRemaining,
  remainingTone,
  weeklyRemainingRows,
} from "./account-limits";

const NOW = Date.parse("2026-09-03T20:40:00Z");
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

describe("accountLimitsFromUsage", () => {
  test("Claude: the 7-day window and each scoped weekly cap; not the 5h", () => {
    expect(
      accountLimitsFromUsage(
        "claude",
        accountUsageSchema.parse({
          fetchedAt: "x",
          fiveHour: { utilization: 60, resetsAt: inHours(2) },
          sevenDay: { utilization: 97, resetsAt: inHours(70) },
          scopedLimits: [
            { label: "Fable", utilization: 45, resetsAt: inHours(100) },
          ],
        }),
      ),
    ).toEqual([
      { utilization: 97, resetsAt: inHours(70), weekly: true },
      { scope: "Fable", utilization: 45, resetsAt: inHours(100), weekly: true },
    ]);
  });

  test("Codex: a week-long window is weekly, a 5h one is not", () => {
    expect(
      accountLimitsFromUsage(
        "codex",
        accountUsageSchema.parse({
          buckets: [
            {
              id: "codex",
              primary: {
                utilization: 20,
                resetsAt: inHours(3),
                windowDurationMins: 300,
              },
              secondary: {
                utilization: 98,
                resetsAt: inHours(120),
                windowDurationMins: 10_080,
              },
            },
          ],
        }),
      ),
    ).toEqual([
      {
        scope: undefined,
        utilization: 20,
        resetsAt: inHours(3),
        weekly: false,
      },
      {
        scope: undefined,
        utilization: 98,
        resetsAt: inHours(120),
        weekly: true,
      },
    ]);
  });

  test("Codex: a bucket with no 5h window still reports its week", () => {
    expect(
      accountLimitsFromUsage(
        "codex",
        accountUsageSchema.parse({
          buckets: [
            {
              id: "codex",
              primary: null,
              secondary: {
                utilization: 98,
                resetsAt: inHours(120),
                windowDurationMins: 10_080,
              },
            },
          ],
        }),
      ),
    ).toEqual([
      {
        scope: undefined,
        utilization: 98,
        resetsAt: inHours(120),
        weekly: true,
      },
    ]);
  });

  test("xAI: the credit period counts as the weekly budget", () => {
    expect(
      accountLimitsFromUsage(
        "xai",
        accountUsageSchema.parse({
          creditUsagePercent: 0,
          periodEnd: inHours(40),
        }),
      ),
    ).toEqual([{ utilization: 0, resetsAt: inHours(40), weekly: true }]);
  });

  test("missing, null, or unreadable usage yields nothing", () => {
    expect(accountLimitsFromUsage("claude", null)).toEqual([]);
    expect(accountLimitsFromUsage("claude", undefined)).toEqual([]);
    expect(
      accountLimitsFromUsage("codex", accountUsageSchema.parse("nope")),
    ).toEqual([]);
    expect(
      accountLimitsFromUsage(
        "claude",
        accountUsageSchema.parse({ sevenDay: { utilization: "97" } }),
      ),
    ).toEqual([]);
    expect(accountLimitsFromUsage("xai", {})).toEqual([]);
  });
});

describe("weeklyRemainingRows", () => {
  test("the viewer's own accounts first, then the pool, nobody else's", () => {
    const limits = [{ utilization: 50, resetsAt: inHours(70), weekly: true }];
    const rows = weeklyRemainingRows(
      [
        { id: "pool", name: "Pool", provider: "claude", limits },
        { id: "mine", name: "Mine", provider: "claude", owner: "Kent", limits },
        {
          id: "mine-long",
          name: "Mine long",
          provider: "codex",
          owner: "Kent de Bruin",
          limits,
        },
        {
          id: "theirs",
          name: "Theirs",
          provider: "claude",
          owner: "Michiel",
          limits,
        },
      ],
      "Kent",
      NOW,
    );
    expect(rows.map((r) => [r.accountId, r.owner])).toEqual([
      ["mine", "Kent"],
      ["mine-long", "Kent de Bruin"],
      ["pool", undefined],
    ]);
  });

  test("one line per weekly limit, with remaining percent and refill day", () => {
    const rows = weeklyRemainingRows(
      [
        {
          id: "a",
          name: "Work",
          provider: "claude",
          limits: [
            { utilization: 97, resetsAt: inHours(70), weekly: true },
            {
              scope: "Fable",
              utilization: 45,
              resetsAt: inHours(100),
              weekly: true,
            },
          ],
        },
        {
          id: "b",
          name: "Main",
          provider: "codex",
          limits: [
            { utilization: 20, resetsAt: inHours(3), weekly: false },
            { utilization: 100, resetsAt: inHours(120), weekly: true },
          ],
        },
        { id: "c", name: "No usage", provider: "claude" },
      ],
      "Kent",
      NOW,
    );
    expect(rows.map((r) => [r.label, r.remaining, r.tone])).toEqual([
      ["Work", 3, "low"],
      ["Work · Fable", 55, "ok"],
      ["Main", 0, "low"],
    ]);
    expect(rows[0].day).toBe(
      new Date(inHours(70)).toLocaleDateString([], { weekday: "short" }),
    );
    expect(rows[0].resetTitle).toMatch(/^Resets /);
  });

  test("a window whose reset already passed reads as full", () => {
    const rows = weeklyRemainingRows(
      [
        {
          id: "a",
          name: "Work",
          provider: "claude",
          limits: [{ utilization: 100, resetsAt: inHours(-1), weekly: true }],
        },
      ],
      "Kent",
      NOW,
    );
    expect(rows[0].remaining).toBe(100);
    expect(rows[0].day).toBe("now");
  });

  test("tones and the tightest row", () => {
    expect(remainingTone(0)).toBe("low");
    expect(remainingTone(10)).toBe("low");
    expect(remainingTone(30)).toBe("warn");
    expect(remainingTone(31)).toBe("ok");
    const rows = weeklyRemainingRows(
      [
        {
          id: "a",
          name: "A",
          provider: "claude",
          limits: [{ utilization: 40, resetsAt: null, weekly: true }],
        },
        {
          id: "b",
          name: "B",
          provider: "codex",
          limits: [{ utilization: 90, resetsAt: null, weekly: true }],
        },
      ],
      "Kent",
      NOW,
    );
    expect(lowestRemaining(rows)?.accountId).toBe("b");
    expect(lowestRemaining([])).toBeUndefined();
  });
});
