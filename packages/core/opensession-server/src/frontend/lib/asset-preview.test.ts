import { describe, expect, test } from "bun:test";
import {
  adjacentAssetPath,
  assetFileFor,
  assetPathForMediaSrc,
  assetPreviewKind,
  formatAssetSize,
  isVisualAsset,
  resolvedAssetPath,
} from "./asset-preview";

describe("asset previews", () => {
  test("classifies files by the renderer they need", () => {
    expect(assetPreviewKind("report.html")).toBe("html");
    expect(assetPreviewKind("chart.svg")).toBe("html");
    expect(assetPreviewKind("notes.md")).toBe("markdown");
    expect(assetPreviewKind("data.json")).toBe("text");
    expect(assetPreviewKind("archive.zip")).toBe("binary");
  });

  test("shows pictures and recordings, lists everything else", () => {
    // The Info panel frames these, because a name and a byte count say
    // nothing about them.
    expect(isVisualAsset("shots/before.png")).toBe(true);
    expect(isVisualAsset("options/1-push.mp4")).toBe(true);
    expect(isVisualAsset("loop.gif")).toBe(true);
    // These keep their row, where the name and the description are the
    // content — a thumbnail of one is a grey rectangle.
    expect(isVisualAsset("report.html")).toBe(false);
    expect(isVisualAsset("diagram.svg")).toBe(false);
    expect(isVisualAsset("data.json")).toBe(false);
    expect(isVisualAsset("notes.md")).toBe(false);
  });

  test("keeps a chip openable before the listing catches up", () => {
    expect(assetFileFor("report.html", [])).toEqual({
      path: "report.html",
      size: 0,
      mtime: "",
    });
  });

  test("formats file sizes for the actions row", () => {
    expect(formatAssetSize(512)).toBe("512 B");
    expect(formatAssetSize(1536)).toBe("1.5 KB");
  });

  test("keeps tree navigation and overlay promotion on one selection", () => {
    const paths = ["chart.png", "demo/index.html", "index.html"];
    expect(resolvedAssetPath(paths, "chart.png")).toBe("chart.png");
    expect(resolvedAssetPath(paths, "missing.html")).toBe("index.html");
  });

  test("moves between assets and wraps at both ends", () => {
    const paths = ["chart.png", "demo.html", "notes.md"];
    expect(adjacentAssetPath(paths, "demo.html", -1)).toBe("chart.png");
    expect(adjacentAssetPath(paths, "demo.html", 1)).toBe("notes.md");
    expect(adjacentAssetPath(paths, "chart.png", -1)).toBe("notes.md");
    expect(adjacentAssetPath(paths, "notes.md", 1)).toBe("chart.png");
    expect(adjacentAssetPath(paths, "missing.txt", 1)).toBeNull();
    expect(adjacentAssetPath(["only.txt"], "only.txt", 1)).toBeNull();
  });

  test("recognises an inline player's source as a scratch asset", () => {
    const paths = ["demo/capture.mp4", "chart.png"];
    const media = (path: string) => `/media?path=${encodeURIComponent(path)}`;
    expect(
      assetPathForMediaSrc(
        media("/home/ubuntu/.opensession/assets/os-1/demo/capture.mp4"),
        paths,
      ),
    ).toBe("demo/capture.mp4");
    // A historical session id owns its own folder; the listing merges them.
    expect(
      assetPathForMediaSrc(
        media("/home/ubuntu/.opensession-assets/os-old/demo/capture.mp4"),
        paths,
      ),
    ).toBe("demo/capture.mp4");
    // An absolute URL from the DOM, with the poster-frame fragment.
    expect(
      assetPathForMediaSrc(
        `http://localhost:3850${media("/home/ubuntu/.opensession/assets/os-1/chart.png")}#t=0.1`,
        paths,
      ),
    ).toBe("chart.png");
  });

  test("never opens an asset for a path that only looks like one", () => {
    const paths = ["demo/capture.mp4"];
    expect(
      assetPathForMediaSrc(
        `/media?path=${encodeURIComponent("/tmp/rec/demo/capture.mp4")}`,
        paths,
      ),
    ).toBeNull();
    expect(
      assetPathForMediaSrc(
        `/media?path=${encodeURIComponent(
          "/home/ubuntu/.opensession-assets/os-1/demo/other.mp4",
        )}`,
        paths,
      ),
    ).toBeNull();
    expect(assetPathForMediaSrc("", paths)).toBeNull();
    expect(assetPathForMediaSrc("blob:whatever", paths)).toBeNull();
  });
});
