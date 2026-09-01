import { describe, expect, test } from "bun:test";
import {
  SIDE_PANEL_OPEN_KEY,
  SIDE_PANEL_PAGE_KEY,
  sidePanelOpen,
  sidePanelPage,
  storeSidePanelOpen,
  storeSidePanelPage,
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
