import { expect, test } from "bun:test";
import { readFollowingLive } from "./transcript-anchor";

const [
  viewerSource,
  mainRegion,
  subscriptionHook,
  transcriptView,
  transcriptHook,
  constants,
  historyController,
  readerController,
] = await Promise.all([
  Bun.file(new URL("../SessionViewer.tsx", import.meta.url)).text(),
  Bun.file(new URL("./SessionViewerMainRegion.tsx", import.meta.url)).text(),
  Bun.file(
    new URL("../../hooks/useSessionViewerSubscription.ts", import.meta.url),
  ).text(),
  Bun.file(new URL("../session/TranscriptView.tsx", import.meta.url)).text(),
  Bun.file(new URL("../../hooks/useTranscript.ts", import.meta.url)).text(),
  Bun.file(
    new URL("../../lib/session-viewer-constants.ts", import.meta.url),
  ).text(),
  Bun.file(
    new URL("../../hooks/useTranscriptHistoryController.ts", import.meta.url),
  ).text(),
  Bun.file(
    new URL("../../hooks/useTranscriptReaderController.ts", import.meta.url),
  ).text(),
]);
const viewer = [viewerSource, mainRegion].join("\n");

test("fresh transcript ranges reaffirm a cached reader's live edge", () => {
  expect(transcriptHook).toContain("settledIndexRef.current = index");
  expect(transcriptHook).toContain(
    'if (readFollowingLive(followingLive)) scrollToLatest("auto")',
  );
  expect(readerController).toContain("settleVisibleRanges({");
});

test("index replacement preserves the bounded tail's scroll mapping", () => {
  const capture = transcriptHook.match(
    /const replaceIndex =[\s\S]*?const loadRanges =/,
  )?.[0];
  const restore = transcriptHook.match(
    /const restorePendingIndexPosition =[\s\S]*?const settleVisibleRanges =/,
  )?.[0];

  expect(capture).toContain(
    "container.scrollHeight -\n              container.scrollTop -\n              container.clientHeight",
  );
  expect(capture).toContain("anchorEid: anchor?.dataset.eid ?? null");
  expect(capture!.indexOf("pendingIndexPositionRef.current = {")).toBeLessThan(
    capture!.indexOf("setIndexState({ sessionId, entries: message.entries })"),
  );
  expect(restore).toContain(
    "container.scrollHeight - container.clientHeight - pending.bottomGap",
  );
  expect(restore).toContain("holdTranscriptAnchor(");
  expect(transcriptHook).toContain("const INDEX_ANCHOR_BRIDGE_MS = 0");
  expect(transcriptHook).not.toContain("INDEX_ANCHOR_SETTLE_MS");
  expect(readerController).toContain("useTranscriptIndexAnchor({");
});

test("setup and loading surfaces leave before transcript rows mount", () => {
  expect(viewer).toContain('<AnimatePresence initial={false} mode="wait">');
  expect(viewer).not.toContain(
    '<AnimatePresence initial={false} mode="popLayout">',
  );
});

test("indexed transcripts settle positively but cannot stay hidden forever", () => {
  expect(transcriptHook).toContain("if (!outlineReady) return");
  expect(readerController).toContain(
    "onSettled: () => setOpenSettlePending(false)",
  );
  expect(subscriptionHook).toContain("setIndexMode(v2)");
  expect(transcriptHook).toContain("setOutlineReady(!v2)");
  expect(transcriptHook).toContain("setOutlineReady(true)");
  expect(constants).toContain("export const LEGACY_OPEN_SETTLE_MAX_MS = 350");
  expect(constants).toContain(
    "export const INDEXED_OPEN_SETTLE_MAX_MS = 2_500",
  );
  expect(readerController).toContain("if (!transcriptRendered) return");
  expect(readerController).toContain("? INDEXED_OPEN_SETTLE_MAX_MS");
  expect(readerController).toContain(": LEGACY_OPEN_SETTLE_MAX_MS,");
  expect(transcriptView).toContain(
    '"w-full shrink-0 motion-safe:transition-opacity motion-safe:duration-150"',
  );
});

test("late action clearance keeps a following transcript at the bottom", () => {
  const clearanceEffect = viewer.match(
    /useLayoutEffect\(\(\) => \{\s*if \(readFollowingLive\(followingLive\)\) scrollToLatest\("auto"\);\s*\}, \[actionClearance, followingLive, scrollToLatest\]\);/,
  )?.[0];

  expect(clearanceEffect).toBeDefined();
  expect(viewer).toContain("actionClearance,");
});

test("a sent prompt scrolls again after its optimistic row commits", () => {
  expect(viewer).toContain("tailActionNeedsLayoutScrollRef.current = true");
  const contentLayoutEffect = readerController.match(
    /\/\/ After any content change:[\s\S]*?\}, \[\s*entries,[\s\S]*?scrollToLatest,?[\s\S]*?\]\);/,
  )?.[0];

  expect(contentLayoutEffect).toContain("relayout()");
  expect(contentLayoutEffect).toContain(
    "if (!tailActionRef.current.current) return",
  );
  expect(contentLayoutEffect).toContain('scrollToLatest("auto")');
});

test("answering an ask follows the response after the ask card disappears", () => {
  const askCard = viewer.match(
    /\{ask && \([\s\S]*?<AskCard[\s\S]*?\/>\s*\)\}/,
  )?.[0];
  const contentLayoutEffect = readerController.match(
    /\/\/ After any content change:[\s\S]*?\}, \[\s*entries,[\s\S]*?scrollToLatest,?[\s\S]*?\]\);/,
  )?.[0];

  expect(askCard).toContain("tailActionNeedsLayoutScrollRef.current = true");
  expect(askCard).toContain("cancelIndexAnchorHold()");
  expect(askCard).toContain('scrollToLatest("auto")');
  expect(contentLayoutEffect).toContain("pending, ask, relayout");
});

test("SessionViewer delegates transcript history ownership without moving callback wrappers", () => {
  const controllerCall = viewer.indexOf("useTranscriptHistoryController({");
  const transcriptCall = viewer.indexOf("useTranscript({");
  expect(controllerCall).toBeGreaterThanOrEqual(0);
  expect(controllerCall).toBeLessThan(transcriptCall);
  expect(viewer.match(/useTranscriptHistoryController\(/g)).toHaveLength(1);
  expect(historyController).toContain(
    "const transcriptReadySessionRef = useRef",
  );
  expect(historyController).toContain("const historyHoldRef = useRef");
  expect(historyController).toContain("const hiddenSnapRef = useRef");
  expect(historyController).toContain(
    "const historyGestureUntilRef = useRef(0)",
  );

  const scrollCallback = readerController.match(
    /const handleMessagesScroll = useCallback\([\s\S]*?\n  \]\);/,
  )?.[0];
  expect(scrollCallback).toContain("handleTranscriptHistoryScroll(");
  expect(historyController).toContain("shouldConsumeHistoryGesture({");
  expect(scrollCallback).toContain(
    "followingLive,\n    loadEarlierHistory,\n    messagesRef,",
  );
});

test("the stable callback reads current live-edge intent when it runs", () => {
  const following = { current: true };
  expect(readFollowingLive(following)).toBe(true);
  following.current = false;
  expect(readFollowingLive(following)).toBe(false);
});
