import { describe, expect, test } from "bun:test";
import { getDeskOverlayForTest, setDeskOverlay } from "./desk-overlay-store";

describe("desk overlay store", () => {
  test("starts closed and takes values or updaters like a state setter", () => {
    expect(getDeskOverlayForTest()).toEqual({
      open: false,
      origin: "bottom-right",
    });
    setDeskOverlay({ open: true, origin: "center" });
    expect(getDeskOverlayForTest()).toEqual({ open: true, origin: "center" });
    setDeskOverlay((desk) => ({ ...desk, open: false }));
    expect(getDeskOverlayForTest()).toEqual({ open: false, origin: "center" });
  });

  test("an equal value keeps the current state", () => {
    const before = getDeskOverlayForTest();
    setDeskOverlay((desk) => ({ ...desk }));
    expect(getDeskOverlayForTest()).toBe(before);
  });

  test("the app shell reads only the call flag, not the open state", async () => {
    const app = await Bun.file(
      new URL("../AppContent.tsx", import.meta.url),
    ).text();
    expect(app).toContain("useActiveWhileDeskClosed(deskCallActive)");
    expect(app).not.toMatch(/\buseDeskOverlay\(/);
  });
});
