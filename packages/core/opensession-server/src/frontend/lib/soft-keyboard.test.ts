import { expect, test } from "bun:test";

test("every new-session palette opener primes the phone keyboard", async () => {
  const app = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
  const hook = await Bun.file(
    new URL("../hooks/useNewSessionPalette.ts", import.meta.url),
  ).text();
  const setterStart = hook.indexOf("const setPalette =");
  const setterEnd = hook.indexOf("const paletteOpenRef", setterStart);
  const setter = hook.slice(setterStart, setterEnd);

  expect(setterStart).toBeGreaterThan(-1);
  expect(setter).toContain("if (next.open) primeSoftKeyboard();");
  // Global, workspace, repo, MCP, and linked-prefill replacement opens all use
  // the keyboard-aware controller. Only hide and functional failure recovery
  // touch its state directly.
  const openStart = hook.indexOf("const openPalette =");
  const openEnd = hook.indexOf("const hidePalette =", openStart);
  const opens = hook.slice(openStart, openEnd);
  expect(opens.match(/setPalette\(\{/g)).toHaveLength(2);
  expect(opens).not.toContain("setPaletteState");
  expect(app).not.toContain("primeSoftKeyboard");
  expect(app).not.toContain("setPaletteState");

  // The repo-band opener moved off Sidebar's props and into App's navigation
  // actions object, so the assertion anchors on the App-side function that
  // context consumers call.
  const repoOpenStart = app.indexOf("const openNewSessionInRepo = (repo");
  const repoOpenEnd = app.indexOf("const openDraft", repoOpenStart);
  const repoOpen = app.slice(repoOpenStart, repoOpenEnd);
  expect(repoOpenStart).toBeGreaterThan(-1);
  expect(repoOpen).toContain("openPrefilledSession(");
  expect(repoOpen).not.toContain("setPalette");
});
