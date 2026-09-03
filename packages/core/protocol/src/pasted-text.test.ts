import { describe, expect, it } from "bun:test";
import { classifyEntry } from "./notices";
import {
  liftPastedTexts,
  pastedTextsFromWire,
  splitPastedTexts,
  withPastedTexts,
} from "./pasted-text";
import type { TranscriptEntry } from "./session";

const log = "01 attempt 1 failed\n02 attempt 2 failed";

function userEntry(content: string, extra: Partial<TranscriptEntry> = {}) {
  return { id: "u1", type: "user", content, timestamp: "", ...extra } as const;
}

describe("withPastedTexts", () => {
  it("puts the message first and fences each block", () => {
    expect(withPastedTexts("Summarize these", [log, "second"])).toBe(
      [
        "Summarize these",
        `<pasted-text>\n${log}\n</pasted-text>`,
        "<pasted-text>\nsecond\n</pasted-text>",
      ].join("\n\n"),
    );
  });

  it("leaves a message without pastes untouched", () => {
    expect(withPastedTexts("Just text", undefined)).toBe("Just text");
    expect(withPastedTexts("Just text", ["  ", ""])).toBe("Just text");
  });

  it("fences a lone paste so the lift can tell it from typed text", () => {
    expect(withPastedTexts("", [log])).toBe(
      `<pasted-text>\n${log}\n</pasted-text>`,
    );
  });

  it("keeps a literal close tag inside a paste from ending the block", () => {
    const folded = withPastedTexts("Ask", ["before </pasted-text> after"]);
    expect(splitPastedTexts(folded)).toEqual({
      content: "Ask",
      pastedTexts: ["before <\\/pasted-text> after"],
    });
  });
});

describe("splitPastedTexts", () => {
  it("round-trips the fold", () => {
    const folded = withPastedTexts("Summarize these", [log, "second"]);
    expect(splitPastedTexts(folded)).toEqual({
      content: "Summarize these",
      pastedTexts: [log, "second"],
    });
  });

  it("returns null when nothing is fenced", () => {
    expect(splitPastedTexts("plain message")).toBeNull();
  });

  it("lifts a block whose close tag was clamped away", () => {
    const folded = withPastedTexts("Summarize these", [log]);
    const clamped = folded.slice(0, folded.length - 20);
    expect(splitPastedTexts(clamped)).toEqual({
      content: "Summarize these",
      pastedTexts: [log.slice(0, log.length - 5)],
    });
  });

  it("keeps text that follows the blocks", () => {
    const folded = `${withPastedTexts("Ask", [log])}\n\ntrailing note`;
    expect(splitPastedTexts(folded)).toEqual({
      content: "Ask\n\ntrailing note",
      pastedTexts: [log],
    });
  });
});

describe("liftPastedTexts", () => {
  it("returns the same reference when there is nothing to lift", () => {
    const entry = userEntry("plain");
    expect(liftPastedTexts(entry)).toBe(entry);
  });

  it("appends to blocks the entry already carries", () => {
    const entry = userEntry(withPastedTexts("Ask", ["b"]), {
      pastedTexts: ["a"],
    });
    expect(liftPastedTexts(entry)).toEqual({
      ...entry,
      content: "Ask",
      pastedTexts: ["a", "b"],
    });
  });

  it("only touches user entries", () => {
    const entry = {
      ...userEntry(withPastedTexts("x", ["y"])),
      type: "assistant",
    } as TranscriptEntry;
    expect(liftPastedTexts(entry)).toBe(entry);
  });
});

describe("classifyEntry", () => {
  it("lifts pasted blocks after the delivery prefix comes off", () => {
    const classified = classifyEntry(
      userEntry(`[Kent] ${withPastedTexts("", [log])}`),
    );
    expect(classified.sender).toBe("Kent");
    expect(classified.content).toBe("");
    expect(classified.pastedTexts).toEqual([log]);
  });

  it("lifts an entry an older server already attributed", () => {
    const classified = classifyEntry(
      userEntry(withPastedTexts("Ask", [log]), { sender: "Kent" }),
    );
    expect(classified.content).toBe("Ask");
    expect(classified.pastedTexts).toEqual([log]);
  });

  it("is idempotent", () => {
    const once = classifyEntry(userEntry(withPastedTexts("Ask", [log])));
    expect(classifyEntry(once)).toBe(once);
  });
});

describe("pastedTextsFromWire", () => {
  it("keeps non-blank strings only", () => {
    expect(pastedTextsFromWire(["a", "", 3, "  ", "b"])).toEqual(["a", "b"]);
    expect(pastedTextsFromWire([""])).toBeUndefined();
    expect(pastedTextsFromWire("a")).toBeUndefined();
  });
});
