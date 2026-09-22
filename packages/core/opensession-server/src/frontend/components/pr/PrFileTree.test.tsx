import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PrFileTree } from "./PrFileTree";

describe("PrFileTree", () => {
  test("keeps long flat filenames intact in a horizontal scrollport", () => {
    const name = "Script__PreviewExternalRecordingConfiguration.ts";
    const html = renderToStaticMarkup(
      <PrFileTree
        files={[{ path: `src/${name}`, additions: 1, deletions: 0 }]}
        mode="flat"
        showFileStats={false}
        onOpenFile={() => {}}
      />,
    );
    expect(html).toContain(name);
    expect(html).toContain("overflow-auto");
    expect(html).toContain("w-max");
    expect(html).not.toContain("truncate font-medium text-fg");
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
  test("exposes search, unreviewed filtering, current file and review markers", () => {
    const html = renderToStaticMarkup(
      <PrFileTree
        files={[{ path: "src/index.ts", additions: 3, deletions: 1 }]}
        mode="flat"
        showFileStats={false}
        activeFile="src/index.ts"
        reviewedFiles={new Set(["src/index.ts"])}
        onOpenFile={() => {
          throw new Error("Rendering must not navigate");
        }}
      />,
    );
    expect(html).toContain('aria-label="Search filenames or paths"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Unreviewed");
    expect(html).toContain('aria-current="location"');
    expect(html).toContain('aria-label="Reviewed"');
  });

  test("sheet layout fills its parent and has no desktop resize handle", () => {
    const html = renderToStaticMarkup(
      <PrFileTree
        files={[]}
        mode="tree"
        showFileStats={false}
        layout="sheet"
        onOpenFile={() => {}}
      />,
    );
    expect(html).not.toContain('role="separator"');
    expect(html).not.toContain("max-width:");
    expect(html).toContain("h-full w-full");
    expect(html).toContain("No files to review");
    expect(html).toContain("phone:min-h-11");
  });
});
