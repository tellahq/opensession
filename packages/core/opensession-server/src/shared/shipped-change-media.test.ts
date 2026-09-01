import { describe, expect, test } from "bun:test";
import {
  latestFeaturedScreenshot,
  localScreenshotPath,
} from "./shipped-change-media";

describe("shipped change media", () => {
  test("resolves local media URLs", () => {
    expect(localScreenshotPath("/media?path=%2Ftmp%2Fafter.png")).toBe(
      "/tmp/after.png",
    );
    expect(
      localScreenshotPath("https://example.com/after.png"),
    ).toBeUndefined();
  });

  test("uses the latest explicitly featured screenshot", () => {
    expect(
      latestFeaturedScreenshot([
        { featuredMedia: ["/media?path=%2Ftmp%2Ffirst.png"] },
        { featuredMedia: ["/media?path=%2Ftmp%2Fdemo.mp4"] },
        { featuredMedia: ["/media?path=%2Ftmp%2Fafter.webp"] },
      ]),
    ).toBe("/tmp/after.webp");
  });
});
