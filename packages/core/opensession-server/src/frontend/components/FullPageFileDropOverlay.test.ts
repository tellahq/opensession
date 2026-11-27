import { expect, test } from "bun:test";

test("the foreground composer drop fade covers the whole page", async () => {
  const source = await Bun.file(
    new URL("./FullPageFileDropOverlay.tsx", import.meta.url),
  ).text();

  expect(source).toContain("createPortal(");
  expect(source).toContain("fixed inset-0 z-drop-target");
  expect(source).toContain("[backdrop-filter:blur(8px)]");
  expect(source).toContain("Drop anywhere to attach them to your message.");
});
