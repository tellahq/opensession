import { expect, test } from "bun:test";

test("pinned work remains in its primary Active placement", async () => {
  const source = await Bun.file(
    new URL("./Sidebar.tsx", import.meta.url),
  ).text();
  const inboxStart = source.indexOf("// ── Inbox rows");
  const inboxEnd = source.indexOf("// ── PR rows", inboxStart);
  const inboxDerivation = source.slice(inboxStart, inboxEnd);

  expect(inboxDerivation).toContain(
    "const activeFocusWsRows = sortInboxByCreation(focusWsRows);",
  );
  expect(inboxDerivation).not.toContain("pinnedRowKeys");
});

test("feed polling depends on stable source state", async () => {
  const source = await Bun.file(
    new URL("../hooks/useSidebarSources.ts", import.meta.url),
  ).text();
  const pollStart = source.indexOf("// Items use the same gentle 60s cadence");
  const pollEnd = source.indexOf("\n  return {", pollStart);
  const pollEffect = source.slice(pollStart, pollEnd);

  expect(pollEffect).toContain("}, [feeds, hiddenFeeds]);");
  expect(pollEffect).not.toContain("}, [visibleFeeds]);");
});
