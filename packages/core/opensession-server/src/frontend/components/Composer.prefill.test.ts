import { expect, test } from "bun:test";

test("a restored message reaches the draft store before React state", async () => {
  const source = await Bun.file(
    new URL("./Composer.tsx", import.meta.url),
  ).text();
  const effectStart = source.indexOf("// One-shot prefill");
  const effectEnd = source.indexOf("// Fire a send handler", effectStart);
  const effect = source.slice(effectStart, effectEnd);
  const persist = effect.indexOf(
    "saveDraft(draftKey, { text: next, pastedTexts: nextPasted })",
  );
  const update = effect.indexOf("setText(next)");

  expect(effectStart).toBeGreaterThan(-1);
  expect(persist).toBeGreaterThan(-1);
  expect(update).toBeGreaterThan(persist);
});
