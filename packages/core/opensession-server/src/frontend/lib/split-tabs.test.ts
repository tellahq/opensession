import { beforeEach, describe, expect, test } from "bun:test";
import {
  clampSplitRatio,
  clearTabSplit,
  getTabSplit,
  resolveSplit,
  saveTabSplit,
  shouldShowTabStrip,
} from "./split-tabs";

class StorageStub {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: new StorageStub(),
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: {
      dispatchEvent() {},
      addEventListener() {},
      removeEventListener() {},
    },
    configurable: true,
  });
});

describe("split tabs", () => {
  test("hides any lone unsplit tab, including Review", () => {
    expect(shouldShowTabStrip(1)).toBe(false);
    expect(shouldShowTabStrip(2)).toBe(true);
    expect(shouldShowTabStrip(1, true)).toBe(true);
    expect(shouldShowTabStrip(2, false, true)).toBe(false);
  });

  test("persists a clamped split per workspace", () => {
    saveTabSplit("workspace", { right: ["b"], ratio: 0.95 });
    expect(getTabSplit("workspace")).toEqual({ right: ["b"], ratio: 0.8 });
  });

  test("clears only the requested workspace", () => {
    saveTabSplit("one", { right: ["b"], ratio: 0.5 });
    saveTabSplit("two", { right: ["d"], ratio: 0.5 });
    clearTabSplit("one");
    expect(getTabSplit("one")).toBeNull();
    expect(getTabSplit("two")?.right).toEqual(["d"]);
  });

  test("migrates a legacy two-tab split into groups", () => {
    localStorage.setItem(
      "opensession-tab-splits",
      JSON.stringify({ ws: { leftId: "a", rightId: "b", ratio: 0.5 } }),
    );
    expect(getTabSplit("ws")).toEqual({
      right: ["b"],
      leftActive: "a",
      rightActive: "b",
      ratio: 0.5,
    });
  });

  test("clamps divider ratios", () => {
    expect(clampSplitRatio(-1)).toBe(0.2);
    expect(clampSplitRatio(0.46)).toBe(0.46);
    expect(clampSplitRatio(2)).toBe(0.8);
  });
});

describe("resolveSplit", () => {
  const split = { right: ["b"], ratio: 0.5 };

  test("splits live tabs into two bars, left in strip order", () => {
    expect(resolveSplit(split, ["a", "b", "c"])).toEqual({
      left: ["a", "c"],
      right: ["b"],
      leftActive: "a",
      rightActive: "b",
      ratio: 0.5,
    });
  });

  test("collapses when a bar has no live tabs left", () => {
    // The right bar's only tab closed.
    expect(resolveSplit(split, ["a", "c"])).toBeNull();
    // Everything moved to the right bar.
    expect(
      resolveSplit({ right: ["a", "b"], ratio: 0.5 }, ["a", "b"]),
    ).toBeNull();
    expect(resolveSplit(null, ["a", "b"])).toBeNull();
  });

  test("falls back to a bar's first tab when its active tab is gone", () => {
    const stale = {
      right: ["b", "d"],
      leftActive: "gone",
      rightActive: "d",
      ratio: 0.5,
    };
    const resolved = resolveSplit(stale, ["a", "b", "c", "d"]);
    expect(resolved?.leftActive).toBe("a");
    expect(resolved?.rightActive).toBe("d");
  });

  test("drops ids that are no longer live", () => {
    const resolved = resolveSplit({ right: ["b", "gone"], ratio: 0.5 }, [
      "a",
      "b",
    ]);
    expect(resolved?.right).toEqual(["b"]);
  });
});
