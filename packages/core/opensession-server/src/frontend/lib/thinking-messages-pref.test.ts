import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "./types";

const store = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
  window: {
    addEventListener(type: string, handler: () => void) {
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(handler);
      listeners.set(type, handlers);
    },
    removeEventListener(type: string, handler: () => void) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event: { type: string }) {
      for (const handler of listeners.get(event.type) ?? []) handler();
    },
  },
  Event: class {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  },
  fetch: () => Promise.reject(new Error("offline in tests")),
});

let pref: typeof import("./thinking-messages-pref");

beforeAll(async () => {
  pref = await import("./thinking-messages-pref");
});

beforeEach(() => store.clear());

describe("Thinking messages preference", () => {
  test("defaults to the latest thinking message", () => {
    expect(pref.getThinkingMessagesPref()).toBe("latest");
  });

  test("stores an explicit mode and notifies mounted transcripts", () => {
    let changed = 0;
    const unsubscribe = pref.onThinkingMessagesChanged(() => changed++);
    pref.setThinkingMessagesPref("all");
    unsubscribe();

    expect(pref.getThinkingMessagesPref()).toBe("all");
    expect(store.get("opensession-thinking-messages")).toBe("all");
    expect(changed).toBe(1);
  });
});

function entry(
  id: string,
  type: TranscriptEntry["type"],
  content: string,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    id,
    type,
    content,
    timestamp: "2026-08-28T08:00:00Z",
    ...extra,
  };
}

const think1 = entry("think-1", "assistant", "Look at the router first.", {
  isReasoning: true,
});
const tool1 = entry("tool-1", "tool_use", "Read");
const legacy = entry("legacy", "assistant", "**Checking the tests**");
const tool2 = entry("tool-2", "tool_use", "Bash");
const note = entry("note", "assistant", "The router is fine.");
const think2 = entry("think-2", "assistant", "Now the tests.", {
  isReasoning: true,
});
const tool3 = entry("tool-3", "tool_use", "Edit");
const work = [think1, tool1, legacy, tool2, note, think2, tool3];
const ids = (entries: TranscriptEntry[]) => entries.map((e) => e.id);

describe("arrangeThinkingMessages", () => {
  test("treats provider reasoning and legacy headings as thinking", () => {
    expect(ids(work.filter((e) => pref.isThinkingEntry(e)))).toEqual([
      "think-1",
      "legacy",
      "think-2",
    ]);
    expect(pref.isThinkingEntry(tool1)).toBe(false);
    expect(pref.isThinkingEntry(note)).toBe(false);
  });

  test("none drops every thought", () => {
    expect(ids(pref.arrangeThinkingMessages(work, "none", true))).toEqual([
      "tool-1",
      "tool-2",
      "note",
      "tool-3",
    ]);
  });

  test("latest pins the newest thought after the last live step", () => {
    expect(ids(pref.arrangeThinkingMessages(work, "latest", true))).toEqual([
      "tool-1",
      "tool-2",
      "note",
      "tool-3",
      "think-2",
    ]);
  });

  test("latest shows nothing once the turn has settled", () => {
    expect(ids(pref.arrangeThinkingMessages(work, "latest", false))).toEqual([
      "tool-1",
      "tool-2",
      "note",
      "tool-3",
    ]);
  });

  test("latest leaves a rail without thoughts alone", () => {
    expect(
      ids(pref.arrangeThinkingMessages([tool1, tool2], "latest", true)),
    ).toEqual(["tool-1", "tool-2"]);
  });

  test("all keeps the trace in transcript order", () => {
    expect(pref.arrangeThinkingMessages(work, "all", false)).toBe(work);
  });
});
