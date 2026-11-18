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

function transcript(store: LiveTurnStore, stopping = false) {
  return renderToStaticMarkup(
    <LiveRunStatusContext.Provider value={{ store, stopping }}>
      <TranscriptBlocks live entries={entries} />
    </LiveRunStatusContext.Provider>,
  );
}

describe("a live thought hands its label to the row at the end", () => {
  test("the thought keeps its prose and drops the shimmering label", () => {
    setTurnPrefs("open", "folded");
    const html = transcript(new LiveTurnStore());
    expect(html).toContain("Try curl next.");
    expect(html).not.toContain('data-text-shimmer=""');
    setTurnPrefs(null);
  });

  test("a pending stop leaves the thought its own label", () => {
    setTurnPrefs("open", "folded");
    const html = transcript(new LiveTurnStore(), true);
    expect(html).toMatch(/>Thinking<\/span>/);
    setTurnPrefs(null);
  });
});

describe("LiveTurnStore trailing thought claims", () => {
  test("counts overlapping claims and ignores a double release", () => {
    const store = new LiveTurnStore();
    let emits = 0;
    store.subscribe(() => emits++);
    const a = store.claimTrailingThought();
    const b = store.claimTrailingThought();
    expect(store.hasTrailingThought()).toBe(true);
    a();
    a();
    expect(store.hasTrailingThought()).toBe(true);
    b();
    expect(store.hasTrailingThought()).toBe(false);
    expect(emits).toBe(2);
  });
});
