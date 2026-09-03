import { beforeEach, describe, expect, test } from "bun:test";
import {
  normalizeHiddenSidebarTools,
  mergeSidebarToolOrder,
  normalizeSidebarToolOrder,
  replaceVisibleSidebarToolOrder,
  readHiddenSidebarTools,
  toolFitsViewport,
  SIDEBAR_TOOL_IDS,
} from "./sidebar-tools";

const store = new Map<string, string>();
// Enough of the Storage surface for the read path.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  } satisfies Pick<Storage, "getItem" | "setItem" | "removeItem">,
});

// No user is stored, so `getCurrentUser()` is "Anonymous" and the per-user key
// is the one below.
const KEY = "opensession-sidebar-hidden-tools:anonymous";
const LEGACY_KEY = "opensession-sidebar-hidden-tools";

beforeEach(() => store.clear());

describe("readHiddenSidebarTools", () => {
  // A tool added to SIDEBAR_TOOL_IDS must not switch itself on for everyone
  // who has never touched the setting. Support is deliberately one of the
  // default destinations.
  test("a new account sees Feed, Pull requests, Support and Catch up", () => {
    const hidden = readHiddenSidebarTools();
    expect([...SIDEBAR_TOOL_IDS].filter((id) => !hidden.has(id))).toEqual([
      "feed",
      "prs",
      "plain",
      "catchup",
    ]);
  });

  // Both tools were renamed on 2026-08-14. Someone who had hidden one then
  // must still have it hidden now, or the rename un-hides a tool they
  // deliberately turned off.
  test("hidden ids survive the renames", () => {
    store.set(KEY, JSON.stringify(["home", "people"]));
    expect([...readHiddenSidebarTools()].sort()).toEqual(["feed", "prs"]);
  });

  test("an explicit empty list means the person showed everything", () => {
    store.set(KEY, "[]");
    expect(readHiddenSidebarTools().size).toBe(0);
  });

  test("stored ids that are no longer tools are dropped", () => {
    store.set(KEY, JSON.stringify(["analytics", "retired-tool"]));
    expect([...readHiddenSidebarTools()]).toEqual(["analytics"]);
  });

  test("unreadable storage falls back to the new-account default", () => {
    store.set(KEY, "{not json");
    expect(readHiddenSidebarTools().has("analytics")).toBe(true);
  });

  // The pref moved from one browser-wide key to a per-user one on
  // 2026-08-15. A sidebar someone had already arranged has to survive that,
  // or the move reads as every hidden tool coming back at once.
  describe("the browser-wide key it replaced", () => {
    test("is adopted by the person reading it", () => {
      store.set(LEGACY_KEY, JSON.stringify(["reports", "analytics"]));
      expect([...readHiddenSidebarTools()].sort()).toEqual([
        "analytics",
        "reports",
      ]);
    });

    test("is retired once adopted, so it can't outvote a later change", () => {
      store.set(LEGACY_KEY, JSON.stringify(["reports"]));
      readHiddenSidebarTools();
      expect(store.get(LEGACY_KEY)).toBeUndefined();
      expect(store.get(KEY)).toBe(JSON.stringify(["reports"]));
    });

    test("loses to a value this person already has", () => {
      store.set(KEY, JSON.stringify(["tasks"]));
      store.set(LEGACY_KEY, JSON.stringify(["reports"]));
      expect([...readHiddenSidebarTools()]).toEqual(["tasks"]);
    });
  });
});

describe("sidebar tool order", () => {
  test("normalizes ids, applies renames and drops duplicates", () => {
    expect(
      normalizeSidebarToolOrder(["reports", "home", "prs", "nope"]),
    ).toEqual(["reports", "prs"]);
  });

  test("appends tools missing from a saved order", () => {
    expect(mergeSidebarToolOrder(["reports", "feed"]).slice(0, 3)).toEqual([
      "reports",
      "feed",
      "prs",
    ]);
  });

  test("reorders visible tools without moving viewport-only tools", () => {
    expect(
      replaceVisibleSidebarToolOrder(
        [
          "feed",
          "catchup",
          "prs",
          "tasks",
          "supporttinder",
          "reports",
          "plain",
          "analytics",
        ],
        ["reports", "feed", "prs", "tasks", "plain", "analytics"],
      ),
    ).toEqual([
      "reports",
      "catchup",
      "feed",
      "prs",
      "supporttinder",
      "tasks",
      "plain",
      "analytics",
    ]);
  });
});

describe("normalizeHiddenSidebarTools", () => {
  test("keeps tool ids, drops everything else", () => {
    expect(normalizeHiddenSidebarTools(["reports", "nope", 7, null])).toEqual([
      "reports",
    ]);
  });

  test("applies the renames and de-duplicates what they collide with", () => {
    expect(normalizeHiddenSidebarTools(["home", "prs", "people"])).toEqual([
      "prs",
      "feed",
    ]);
  });

  test("anything that is not a list reads as nothing hidden", () => {
    expect(normalizeHiddenSidebarTools("reports")).toEqual([]);
    expect(normalizeHiddenSidebarTools(null)).toEqual([]);
  });
});

describe("toolFitsViewport", () => {
  test("the swipe decks are offered on phones only", () => {
    for (const deck of ["catchup", "supporttinder"] as const) {
      expect(toolFitsViewport(deck, true)).toBe(true);
      expect(toolFitsViewport(deck, false)).toBe(false);
    }
  });

  test("Pull requests is the phone's root list, not one of its tools", () => {
    expect(toolFitsViewport("prs", false)).toBe(true);
    expect(toolFitsViewport("prs", true)).toBe(false);
  });

  test("every other tool is offered at both widths", () => {
    for (const id of SIDEBAR_TOOL_IDS) {
      if (id === "prs" || id === "catchup" || id === "supporttinder") continue;
      expect(toolFitsViewport(id, true)).toBe(true);
      expect(toolFitsViewport(id, false)).toBe(true);
    }
  });
});
