import { describe, expect, test } from "bun:test";
import {
  newTailBlockKeys,
  shouldAnimateTranscriptEntryPosition,
  shouldAnimateTranscriptItemArrival,
  transcriptArrivalAliases,
  transcriptEntryMountKey,
  turnMountKey,
  turnScrollAnchor,
} from "./transcript-block-identity";

const entry = (id: string) => ({ id });

describe("transcript decorations", () => {
  test("keeps live and durable model switches out of position motion", () => {
    expect(
      shouldAnimateTranscriptEntryPosition(entry("model-switch-live-1")),
    ).toBe(false);
    expect(
      shouldAnimateTranscriptEntryPosition(
        entry("model-switch-2026-08-31T14:00:00Z"),
      ),
    ).toBe(false);
    expect(shouldAnimateTranscriptEntryPosition(entry("retry-notice"))).toBe(
      true,
    );
  });
});

describe("transcript turn identity", () => {
  test("keeps the mounted component when live steps append", () => {
    expect(turnMountKey([entry("first"), entry("second")])).toBe(
      turnMountKey([entry("first"), entry("second"), entry("third")]),
    );
  });

  test("keeps the scroll anchor when history entries prepend", () => {
    expect(turnScrollAnchor([entry("second"), entry("third")])).toBe(
      turnScrollAnchor([entry("first"), entry("second"), entry("third")]),
    );
  });

  test("keeps the mounted component when an indexed slice prepends steps", () => {
    expect(turnMountKey([entry("second"), entry("third")], "range:user")).toBe(
      turnMountKey(
        [entry("first"), entry("second"), entry("third")],
        "range:user",
      ),
    );
  });
});

describe("optimistic transcript identity", () => {
  test("keeps one mount key across the optimistic and durable row", () => {
    expect(
      transcriptEntryMountKey({ id: "outbox-client-prompt", type: "user" }),
    ).toBe("outbox-client-prompt");
    expect(transcriptEntryMountKey({ id: "client-prompt", type: "user" })).toBe(
      "outbox-client-prompt",
    );
    expect(
      transcriptEntryMountKey({
        id: "durable-batch",
        type: "user",
        sourceMessageIds: ["client-first", "client-second"],
      }),
    ).toBe("outbox-client-first");
    expect(
      transcriptEntryMountKey({ id: "assistant-answer", type: "assistant" }),
    ).toBe("assistant-answer");
  });

  test("carries every optimistic identity into a durable batched row", () => {
    expect(
      transcriptArrivalAliases([
        {
          id: "durable-batch",
          type: "user",
          sourceMessageIds: ["client-first", "client-second"],
        },
      ]),
    ).toEqual([
      "outbox-durable-batch",
      "outbox-client-first",
      "outbox-client-second",
    ]);
  });

  test("does not animate a durable block over its mounted optimistic alias", () => {
    const durable = {
      entryIds: ["durable-prompt"],
      arrivalAliases: ["outbox-client-prompt"],
    };
    expect(
      shouldAnimateTranscriptItemArrival(
        durable,
        new Set(["outbox-client-prompt"]),
      ),
    ).toBe(false);
    expect(
      shouldAnimateTranscriptItemArrival(durable, new Set(["older-entry"])),
    ).toBe(true);
  });

  test("does not animate a refreshed block that retains a painted entry", () => {
    const refreshed = {
      entryIds: ["worked-step", "retry-notice"],
    };
    expect(
      shouldAnimateTranscriptItemArrival(
        refreshed,
        new Set(["worked-step", "retry-notice"]),
      ),
    ).toBe(false);
    expect(
      shouldAnimateTranscriptItemArrival(refreshed, new Set(["older-entry"])),
    ).toBe(true);
  });

  test("does not animate a newly hydrated transcript slice", () => {
    expect(
      shouldAnimateTranscriptItemArrival(
        {
          entryIds: ["worked-step", "retry-notice"],
          animateArrival: false,
        },
        new Set(),
      ),
    ).toBe(false);
  });
});

describe("newTailBlockKeys", () => {
  const keys = (names: string[]) => names;

  test("first build seeds without animating", () => {
    expect(newTailBlockKeys(null, keys(["a", "b", "c", "d"]))).toEqual([]);
  });

  test("a new tail block arrives", () => {
    const previous = new Set(keys(["a", "b", "c"]));
    expect(newTailBlockKeys(previous, keys(["a", "b", "c", "d"]))).toEqual([
      "d",
    ]);
  });

  test("history prepending at the head never animates", () => {
    const previous = new Set(keys(["a", "b", "c"]));
    expect(newTailBlockKeys(previous, keys(["x", "y", "a", "b", "c"]))).toEqual(
      [],
    );
  });

  test("several tail blocks mounting in one build arrive together", () => {
    const previous = new Set(keys(["a", "b"]));
    expect(newTailBlockKeys(previous, keys(["a", "b", "c", "d", "e"]))).toEqual(
      ["c", "d", "e"],
    );
  });

  test("re-renders with unchanged keys do not re-animate", () => {
    const previous = new Set(keys(["a", "b", "c"]));
    expect(newTailBlockKeys(previous, keys(["a", "b", "c"]))).toEqual([]);
  });
});
