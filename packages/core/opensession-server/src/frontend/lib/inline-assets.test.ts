import { describe, expect, test } from "bun:test";
import { inlineAssetPaths } from "./inline-assets";

describe("inlineAssetPaths", () => {
  test("shows written assets first, then named ones", () => {
    expect(
      inlineAssetPaths(
        ["report.html"],
        "See `mock.html` and shots/before.png.",
        ["mock.html", "report.html", "shots/before.png", "data.bin"],
      ),
    ).toEqual(["report.html", "mock.html", "shots/before.png"]);
  });

  test("skips files with no preview and caps the count", () => {
    expect(
      inlineAssetPaths(
        ["a.bin", "b.mp3", "c.md", "d.md", "e.md", "f.md"],
        "",
        [],
      ),
    ).toEqual(["c.md", "d.md", "e.md"]);
  });

  test("ignores ambiguous names and partial matches", () => {
    expect(
      inlineAssetPaths([], "Open before.png or mock.html.bak", [
        "a/before.png",
        "b/before.png",
        "mock.html",
      ]),
    ).toEqual([]);
  });

  test("a sentence-ending period still names the file", () => {
    expect(inlineAssetPaths([], "Open mock.html.", ["mock.html"])).toEqual([
      "mock.html",
    ]);
  });
});
