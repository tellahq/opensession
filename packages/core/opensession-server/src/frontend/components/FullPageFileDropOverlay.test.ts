import { expect, test } from "bun:test";

test("the foreground composer drop fade covers the whole page", async () => {
  const source = await Bun.file(
    new URL("./FullPageFileDropOverlay.tsx", import.meta.url),
  ).text();

  expect(source).toContain("createPortal(");
  expect(source).toContain('position: "fixed"');
  expect(source).toContain('zIndex: "12000"');
  expect(source).toContain('backdropFilter: "blur(8px)"');
  expect(source).toContain("Drop anywhere to attach them to your message.");
});
