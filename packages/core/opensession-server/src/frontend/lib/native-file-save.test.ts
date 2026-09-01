import { describe, expect, test } from "bun:test";
import { shouldUseNativeIOSShare } from "./native-file-save";

const installedIPhone = {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
  platform: "iPhone",
  maxTouchPoints: 5,
  standalone: true,
  displayModeStandalone: true,
  hasShare: true,
};

describe("shouldUseNativeIOSShare", () => {
  test("uses the native share sheet in an installed iOS PWA", () => {
    expect(shouldUseNativeIOSShare(installedIPhone)).toBe(true);
  });

  test("keeps normal browser downloads in iOS Safari", () => {
    expect(
      shouldUseNativeIOSShare({
        ...installedIPhone,
        standalone: false,
        displayModeStandalone: false,
      }),
    ).toBe(false);
  });

  test("does not use the iOS workaround in desktop PWAs", () => {
    expect(
      shouldUseNativeIOSShare({
        ...installedIPhone,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        platform: "MacIntel",
        maxTouchPoints: 0,
      }),
    ).toBe(false);
  });
});
