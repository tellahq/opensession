import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "../../lib/types";
import { LiveTurnStore } from "../../lib/live-turn-store";
import { setTurnPrefs } from "../TranscriptBlocks.test-setup";
import { LiveRunStatusContext } from "./live-run-status";

const { TranscriptBlocks } = await import("../TranscriptBlocks");

const entries: TranscriptEntry[] = [
  {
    id: "prompt",
    type: "user",
    content: "Check the portal",
    timestamp: "2026-08-28T09:00:00Z",
  },
  {
    id: "tool",
    type: "tool_use",
    toolUseId: "tool-call",
    toolName: "bash",
    content: "Using bash",
    timestamp: "2026-08-28T09:00:01Z",
  },
  {
    id: "reasoning",
    type: "assistant",
    content: "The portal still isn't responding. Try curl next.",
    isReasoning: true,
    timestamp: "2026-08-28T09:00:02Z",
  },
];

function render(store: LiveTurnStore, stopping = false) {
  return renderToStaticMarkup(
    <LiveRunStatusContext.Provider
      value={{ store, since: Date.now() - 15 * 60_000, stopping }}
    >
      <TranscriptBlocks live entries={entries} />
    </LiveRunStatusContext.Provider>,
  );
}

describe("a live thought as the run's status", () => {
  test("the Thinking header carries the elapsed time", () => {
    setTurnPrefs("open", "folded");
    const html = render(new LiveTurnStore());
    expect(html).toContain('role="status"');
    expect(html).toMatch(/>Thinking<\/span>/);
    expect(html).toContain("· 15m");
    setTurnPrefs(null);
  });

  test("a running tool takes the status back from the thought", () => {
    setTurnPrefs("open", "folded");
    const store = new LiveTurnStore();
    store.setActivity({ kind: "tool", toolName: "bash", count: 1 });
    const html = render(store);
    expect(html).not.toContain('data-text-shimmer=""');
    expect(html).not.toContain("· 15m");
    setTurnPrefs(null);
  });

  test("a pending stop leaves the elapsed time to the row below", () => {
    setTurnPrefs("open", "folded");
    const html = render(new LiveTurnStore(), true);
    expect(html).toContain('data-text-shimmer=""');
    expect(html).not.toContain("· 15m");
    setTurnPrefs(null);
  });
});

describe("LiveTurnStore inline status claims", () => {
  test("counts overlapping claims and ignores a double release", () => {
    const store = new LiveTurnStore();
    let emits = 0;
    store.subscribe(() => emits++);
    const a = store.claimInlineStatus();
    const b = store.claimInlineStatus();
    expect(store.hasInlineStatus()).toBe(true);
    a();
    a();
    expect(store.hasInlineStatus()).toBe(true);
    b();
    expect(store.hasInlineStatus()).toBe(false);
    expect(emits).toBe(2);
  });
});
