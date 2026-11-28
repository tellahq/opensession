import { expect, test } from "bun:test";

test("the file drop fade covers the whole page", async () => {
  const source = await Bun.file(
    new URL("./FullPageFileDropOverlay.tsx", import.meta.url),
  ).text();

  expect(source).toContain("createPortal(");
  expect(source).toContain('position: "fixed"');
  expect(source).toContain("zIndex: layer.dropTarget");
  expect(source).toContain("backdropFilter: blur.dropWash");
  expect(source).toContain("Drop anywhere to attach them to your message.");
});

test("every composer that takes a drop uses this one overlay", async () => {
  for (const path of [
    "./session-viewer/SessionViewerMainRegion.tsx",
    "./WorkspacePane.tsx",
  ]) {
    const source = await Bun.file(new URL(path, import.meta.url)).text();
    expect(source).toContain("<FullPageFileDropOverlay");
    expect(source).not.toContain("Add files");
  }
});
