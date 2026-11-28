import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSidePanelTab,
  getSidePanelState,
  openSidePanelOverview,
  openSidePanelTab,
  resetSidePanelStateForTest,
  selectSidePanelPage,
  setSidePanelBrowser,
  setSidePanelOpen,
  setSidePanelWindowWide,
  sidePanelBrowserOf,
  sidePanelDockOf,
  sidePanelViewOf,
} from "./side-panel-store";

describe("closeSidePanelTab", () => {
  beforeEach(() => resetSidePanelStateForTest());

  test("keeps the panel open while other tabs remain", () => {
    openSidePanelTab("changes", "s1");
    openSidePanelTab("agents", "s1");
    closeSidePanelTab("s1", "agents");
    expect(sidePanelViewOf(getSidePanelState(), "s1")).toEqual({
      open: true,
      page: "changes",
    });
  });

  test("never closes Changes, the overview", () => {
    openSidePanelTab("changes", "s1");
    closeSidePanelTab("s1", "changes");
    expect(getSidePanelState().tabs).toContain("changes");
    expect(sidePanelViewOf(getSidePanelState(), "s1")).toEqual({
      open: true,
      page: "changes",
    });
  });
});

describe("openSidePanelOverview", () => {
  beforeEach(() => resetSidePanelStateForTest());

  test("opens on Changes whatever page the panel closed on", () => {
    openSidePanelTab("agents", "s1");
    setSidePanelOpen("s1", false);
    openSidePanelOverview("s1");
    expect(sidePanelViewOf(getSidePanelState(), "s1")).toEqual({
      open: true,
      page: "changes",
    });
  });

  test("opens from the new-tab page on Changes", () => {
    selectSidePanelPage("s1", "new");
    openSidePanelOverview("s1");
    expect(sidePanelViewOf(getSidePanelState(), "s1").page).toBe("changes");
  });

  test("keeps a coordinator on its Threads tab", () => {
    openSidePanelTab("threads", "s1");
    setSidePanelOpen("s1", false);
    openSidePanelOverview("s1");
    expect(sidePanelViewOf(getSidePanelState(), "s1")).toEqual({
      open: true,
      page: "threads",
    });
  });
});

describe("window-wide panel (new layout)", () => {
  beforeEach(() => {
    resetSidePanelStateForTest();
    setSidePanelWindowWide(() => true);
  });
  afterEach(() => resetSidePanelStateForTest());

  test("switching sessions keeps the panel as it is", () => {
    openSidePanelTab("agents", "s1");
    expect(sidePanelViewOf(getSidePanelState(), "s2")).toEqual({
      open: true,
      page: "agents",
    });
    setSidePanelOpen("s2", false);
    expect(sidePanelViewOf(getSidePanelState(), "s1").open).toBe(false);
  });

  test("a page moved to the panel stays across sessions", () => {
    setSidePanelBrowser("s1", { kind: "url", url: "https://example.test" });
    expect(sidePanelBrowserOf(getSidePanelState(), "s2")).toEqual({
      kind: "url",
      url: "https://example.test",
    });
  });

  test("Browser and Review open in the main tabs", () => {
    expect(sidePanelDockOf("browser")).toBe("main");
    expect(sidePanelDockOf("review")).toBe("main");
  });
});
