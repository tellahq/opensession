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

function transcript(store: LiveTurnStore) {
  return renderToStaticMarkup(
    <LiveRunStatusContext.Provider value={{ store }}>
      <TranscriptBlocks live entries={entries} />
    </LiveRunStatusContext.Provider>,
  );
}

describe("a live thought names itself", () => {
  test("shimmers its own label above its prose while the model thinks", () => {
    setTurnPrefs("open", "folded");
    const html = transcript(new LiveTurnStore());
    expect(html).toContain("Try curl next.");
    expect(html).toContain('data-text-shimmer=""');
    setTurnPrefs(null);
  });

  test("stops shimmering once the engine has moved on to a tool", () => {
    setTurnPrefs("open", "folded");
    const store = new LiveTurnStore();
    store.setActivity({ kind: "tool", toolName: "bash", count: 1 });
    const html = transcript(store);
    expect(html).not.toMatch(/data-text-shimmer[^>]*>Thinking/);
    setTurnPrefs(null);
  });
});
