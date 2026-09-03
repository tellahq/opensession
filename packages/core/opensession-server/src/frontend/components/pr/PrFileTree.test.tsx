import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { PrFileTree } from "./PrFileTree";

describe("PrFileTree", () => {
  test("shortens long file names from the center", () => {
    const entry = Bun.resolveSync("@pierre/trees", import.meta.dir);
    const source = readFileSync(
      join(dirname(entry), "render/FileTreeView.js"),
      "utf8",
    );

    expect(source).toContain('split: "center"');
    expect(source).not.toContain('split: "extension"');
  });

  test("renders an accessible resize separator", () => {
    const html = renderToStaticMarkup(
      <PrFileTree
        files={[{ path: "src/index.ts", additions: 3, deletions: 1 }]}
        mode="flat"
        showFileStats
        onOpenFile={() => {}}
      />,
    );

    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="Resize changed files"');
    expect(html).toContain('aria-orientation="vertical"');
  });

  test("uses the same surface as the workspace summary", () => {
    const html = renderToStaticMarkup(
      <PrFileTree
        files={[{ path: "src/index.ts", additions: 3, deletions: 1 }]}
        mode="flat"
        showFileStats
        onOpenFile={() => {}}
      />,
    );

    expect(html).toContain("bg-popup-glass");
    expect(html).toContain("smooth-shadow-ring-sm");
    expect(html).toContain("[border-radius:calc(18px*var(--rf))]!");
    expect(html).toContain("[corner-shape:squircle]");
    expect(html).not.toContain("rounded-lg");
    expect(html).not.toContain("shadow-[inset_0_-1px_0_var(--divider)]");
  });

  test("renders a flat file list with change counts", () => {
    const html = renderToStaticMarkup(
      <PrFileTree
        files={[{ path: "src/index.ts", additions: 3, deletions: 1 }]}
        mode="flat"
        showFileStats
        onOpenFile={() => {}}
      />,
    );

    expect(html).toContain("index.ts");
    expect(html).toContain("src/");
    expect(html).toContain("+3");
    expect(html).toContain("−1");
  });

  test("hides change counts when file stats are disabled", () => {
    const html = renderToStaticMarkup(
      <PrFileTree
        files={[{ path: "src/index.ts", additions: 3, deletions: 1 }]}
        mode="flat"
        showFileStats={false}
        onOpenFile={() => {}}
      />,
    );

    expect(html).not.toContain("+3");
    expect(html).not.toContain("−1");
  });
});
