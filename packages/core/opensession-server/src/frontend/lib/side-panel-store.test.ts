import { beforeEach, describe, expect, test } from "bun:test";
import {
  closeSidePanelTab,
  getSidePanelState,
  openSidePanelTab,
  resetSidePanelStateForTest,
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

  test("closes the panel with its last tab", () => {
    openSidePanelTab("changes", "s1");
    closeSidePanelTab("s1", "changes");
    expect(getSidePanelState().tabs).toEqual([]);
    expect(sidePanelViewOf(getSidePanelState(), "s1").open).toBe(false);
  });
});
