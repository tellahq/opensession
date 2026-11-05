import { describe, expect, test } from "bun:test";
import {
  SIDE_PANEL_OPEN_KEY,
  SIDE_PANEL_PAGE_KEY,
  SIDE_PANEL_TABS_KEY,
  sidePanelDock,
  sidePanelOpen,
  sidePanelPage,
  sidePanelTabs,
  storeSidePanelDock,
  storeSidePanelOpen,
  storeSidePanelPage,
  withSidePanelTab,
  withoutSidePanelTab,
} from "./side-panel-open";

function memoryStorage(initial?: Record<string, string>) {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("workspace side panel preference", () => {
  test("defaults to the summary card", () => {
    expect(sidePanelOpen(memoryStorage())).toBe(false);
  });

  test("remembers an explicitly opened or closed panel", () => {
    const storage = memoryStorage();
    storeSidePanelOpen(true, storage);
    expect(sidePanelOpen(storage)).toBe(true);
    storeSidePanelOpen(false, storage);
    expect(sidePanelOpen(storage)).toBe(false);
  });

  test("defaults to Changes and remembers the selected tool", () => {
    const storage = memoryStorage();
    expect(sidePanelPage(storage)).toBe("changes");

    storeSidePanelPage("portals", storage);
    expect(sidePanelPage(storage)).toBe("portals");
  });

  test("ignores an unknown stored tool", () => {
    const storage = memoryStorage({
      [SIDE_PANEL_OPEN_KEY]: "true",
      [SIDE_PANEL_PAGE_KEY]: "unknown",
    });
    expect(sidePanelOpen(storage)).toBe(true);
    expect(sidePanelPage(storage)).toBe("changes");
  });
});

describe("side panel tabs", () => {
  test("start on Changes plus the tool a browser last had selected", () => {
    expect(sidePanelTabs(memoryStorage())).toEqual(["changes"]);
    expect(
      sidePanelTabs(memoryStorage({ [SIDE_PANEL_PAGE_KEY]: "agents" })),
    ).toEqual(["changes", "agents"]);
  });

  test("drop unknown and repeated stored tabs", () => {
    const storage = memoryStorage({
      [SIDE_PANEL_TABS_KEY]: JSON.stringify([
        "review",
        "x",
        "review",
        "browser",
      ]),
    });
    expect(sidePanelTabs(storage)).toEqual(["review", "browser"]);
  });

  test("closing the selected tab selects its neighbour, then the new-tab page", () => {
    expect(
      withoutSidePanelTab(["changes", "review", "browser"], "review", "review"),
    ).toEqual({ tabs: ["changes", "browser"], page: "browser" });
    expect(
      withoutSidePanelTab(["changes", "review"], "review", "review"),
    ).toEqual({ tabs: ["changes"], page: "changes" });
    expect(withoutSidePanelTab(["review"], "review", "review")).toEqual({
      tabs: [],
      page: "new",
    });
    expect(
      withoutSidePanelTab(["changes", "review"], "changes", "review"),
    ).toEqual({ tabs: ["changes"], page: "changes" });
    expect(withSidePanelTab(["changes"], "changes")).toEqual(["changes"]);
    expect(withSidePanelTab(["changes"], "review")).toEqual([
      "changes",
      "review",
    ]);
  });

  test("Review and Browser open in the panel until moved", () => {
    const storage = memoryStorage();
    expect(sidePanelDock(storage)).toEqual({
      review: "panel",
      browser: "panel",
    });
    storeSidePanelDock({ review: "main", browser: "panel" }, storage);
    expect(sidePanelDock(storage)).toEqual({
      review: "main",
      browser: "panel",
    });
  });
});
