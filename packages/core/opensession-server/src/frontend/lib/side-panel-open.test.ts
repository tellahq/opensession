import { describe, expect, test } from "bun:test";
import {
  SIDE_PANEL_PAGE_KEY,
  SIDE_PANEL_TABS_KEY,
  sidePanelDock,
  sidePanelViewFor,
  sidePanelViews,
  storeSidePanelViews,
  sidePanelPage,
  sidePanelTabs,
  storeSidePanelDock,
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
  test("a session starts closed, on the summary card", () => {
    expect(sidePanelViewFor(undefined, false, "changes")).toEqual({
      open: false,
      page: "changes",
    });
  });

  test("a session with a browser attached starts open on it", () => {
    expect(sidePanelViewFor(undefined, true, "changes")).toEqual({
      open: true,
      page: "browser",
    });
    expect(sidePanelViewFor({ open: false }, true, "changes").open).toBe(false);
  });

  test("each session keeps its own open state and page", () => {
    const storage = memoryStorage();
    storeSidePanelViews(
      { a: { open: true, page: "review" }, b: { open: false } },
      storage,
    );
    const views = sidePanelViews(storage);
    expect(sidePanelViewFor(views.a, false, "changes")).toEqual({
      open: true,
      page: "review",
    });
    expect(sidePanelViewFor(views.b, false, "agents")).toEqual({
      open: false,
      page: "agents",
    });
  });

  test("defaults to Changes and remembers the selected tool", () => {
    const storage = memoryStorage();
    expect(sidePanelPage(storage)).toBe("changes");

    storeSidePanelPage("portals", storage);
    expect(sidePanelPage(storage)).toBe("portals");
  });

  test("ignores an unknown stored tool", () => {
    const storage = memoryStorage({ [SIDE_PANEL_PAGE_KEY]: "unknown" });
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
