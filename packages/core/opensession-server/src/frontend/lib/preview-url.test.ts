import { describe, expect, test } from "bun:test";
import { previewOpenable } from "./preview-url";

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
