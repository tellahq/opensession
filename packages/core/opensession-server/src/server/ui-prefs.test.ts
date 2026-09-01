import { describe, expect, test } from "bun:test";
import {
  expectedUiPrefsMatch,
  maxValueLength,
  normalizedUiPrefValue,
} from "./ui-prefs";

describe("UI preference limits", () => {
  test("repository orders can hold a large configured repo list", () => {
    const order = JSON.stringify(
      Array.from(
        { length: 100 },
        (_, index) => `repository-${index}-${"x".repeat(40)}`,
      ),
    );
    expect(order.length).toBeGreaterThan(200);
    expect(order.length).toBeLessThanOrEqual(maxValueLength("repo-order"));
  });

  test("per-repository checkout choices can hold a large configured repo list", () => {
    const checkouts = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [
          `repository:${index}:${"x".repeat(30)}`,
          index % 2 ? "checkout" : "worktree",
        ]),
      ),
    );
    expect(checkouts.length).toBeGreaterThan(200);
    expect(checkouts.length).toBeLessThanOrEqual(
      maxValueLength("session-checkouts"),
    );
  });

  test("keyboard shortcut maps can hold account bindings", () => {
    const shortcuts = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 25 }, (_, index) => [
          `command-${index}`,
          [`mod+shift+f${(index % 24) + 1}`],
        ]),
      ),
    );
    expect(shortcuts.length).toBeGreaterThan(200);
    expect(shortcuts.length).toBeLessThanOrEqual(maxValueLength("shortcuts"));
  });

  test("ordinary scalar preferences remain tightly bounded", () => {
    expect(maxValueLength("turn-activity")).toBe(200);
  });

  test("retires automatic repository preferences", () => {
    expect(normalizedUiPrefValue("default-repo", "auto")).toBe("");
    expect(normalizedUiPrefValue("default-repo", "opensession")).toBe(
      "opensession",
    );
    expect(normalizedUiPrefValue("turn-activity", "auto")).toBe("auto");
  });

  test("conditional patches reject a stale legacy preference snapshot", () => {
    const current = { "turn-activity": "auto", "tool-calls": "open" };
    expect(
      expectedUiPrefsMatch(current, {
        "turn-activity": "auto",
        "tool-calls": null,
      }),
    ).toBeFalse();
    expect(
      expectedUiPrefsMatch(current, {
        "turn-activity": "auto",
        "tool-calls": "open",
      }),
    ).toBeTrue();
  });
});
