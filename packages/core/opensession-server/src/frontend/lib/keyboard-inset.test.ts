import { expect, test } from "bun:test";

test("the phone palette rests on top of the keyboard instead of behind it", async () => {
  const sheet = await Bun.file(
    new URL("../components/NewSession.tsx", import.meta.url),
  ).text();

  // The sheet is bottom-anchored in a fixed viewport, so the keyboard's own
  // height is the only thing that keeps the composer on screen.
  expect(sheet).toContain("phone:pb-[var(--kb-inset,0px)]");
  expect(sheet).not.toContain("phone:pb-0 phone:pt-3");
  // And it may never grow past the strip the keyboard leaves.
  expect(sheet).toContain("phone:[body.kb-open_&]:max-h-[min(43dvh,100%)]");
});

test("the same focus that flags the keyboard measures it, for every surface", async () => {
  const app = await Bun.file(
    new URL("../hooks/useAppDocumentInteractions.ts", import.meta.url),
  ).text();
  const start = app.indexOf("// Track the on-screen keyboard via input focus");
  const effect = app.slice(start, app.indexOf("}, []);", start));

  expect(start).toBeGreaterThan(-1);
  // One owner, so the palette sheet and the session composer cannot disagree
  // about how tall the keyboard is.
  expect(effect).toContain(
    "if (releaseInset === null) releaseInset = trackKeyboardInset();",
  );
  expect(effect).toContain("releaseInset = null;");
});

test("the keyboard inset is measured against the fixed viewport, not the document", async () => {
  const source = await Bun.file(
    new URL("./keyboard-inset.ts", import.meta.url),
  ).text();

  // A document-height reading would report the standalone window's letterbox
  // as a keyboard; a fixed probe reports what `position: fixed` actually gets.
  expect(source).toContain("position:fixed;inset:0");
  expect(source).toContain("const frame = probe.clientHeight;");
  // visualViewport is authoritative when present: it is the only reading that
  // includes WebKit's focus pan, so innerHeight cannot count that pan again as
  // extra keyboard. innerHeight stays as the fallback for clients without it.
  expect(source).toContain("viewport.height + viewport.offsetTop");
  expect(source).toContain("window.innerHeight || frame");
  expect(source).not.toContain("const visible = Math.min(");
  // Nothing is left behind for the next surface to inherit.
  expect(source).toContain("write(0);");
});
