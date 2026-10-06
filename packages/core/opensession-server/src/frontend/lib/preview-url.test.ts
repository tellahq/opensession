import { describe, expect, test } from "bun:test";
import { previewOpenable, stagingHref } from "./preview-url";

describe("previewOpenable", () => {
  test("a ready deploy opens", () => {
    expect(previewOpenable({ status: "Ready" })).toBe(true);
  });
  test("a first build with nothing serving stays closed", () => {
    expect(previewOpenable({ status: "Building" })).toBe(false);
    expect(previewOpenable({ status: "Building", live: false })).toBe(false);
  });
  test("a rebuild over a live previous deploy opens", () => {
    expect(previewOpenable({ status: "Building", live: true })).toBe(true);
  });
});

describe("stagingHref", () => {
  const base = "https://preview.example.test";
  test("the session's recorded route wins", () => {
    expect(
      stagingHref({ url: base, defaultPath: "/videos" }, "/settings?tab=a"),
    ).toBe(`${base}/settings?tab=a`);
  });
  test("falls back to the configured landing route", () => {
    expect(stagingHref({ url: `${base}/`, defaultPath: "/videos" })).toBe(
      `${base}/videos`,
    );
  });
  test("opens the root with neither", () => {
    expect(stagingHref({ url: base })).toBe(base);
  });
});
