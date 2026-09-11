import { describe, expect, it } from "bun:test";
import { openChoiceEntryIds, parseChoices } from "./choices-block";

describe("parseChoices", () => {
  it("reads one reply per line and drops list markers", () => {
    expect(parseChoices("Merge it\n- Add a test\n* Explain\n2. Stop")).toEqual([
      "Merge it",
      "Add a test",
      "Explain",
      "Stop",
    ]);
  });

  it("ignores blank lines, surrounding space and repeats", () => {
    expect(parseChoices("\n  Yes  \n\nYes\nNo\n")).toEqual(["Yes", "No"]);
  });

  it("declines an empty fence, too many replies or a reply that is prose", () => {
    expect(parseChoices("")).toBeNull();
    expect(parseChoices("- \n-\n")).toBeNull();
    const many = Array.from({ length: 13 }, (_, i) => `Option ${i}`).join("\n");
    expect(parseChoices(many)).toBeNull();
    expect(parseChoices("x".repeat(201))).toBeNull();
  });
});

describe("openChoiceEntryIds", () => {
  const entries = [
    { id: "u1", type: "user" },
    { id: "a1", type: "assistant" },
    { id: "u2", type: "user" },
    { id: "t1", type: "tool_use" },
    { id: "a2", type: "assistant" },
  ];

  it("keeps only the entries after the last user message", () => {
    const open = openChoiceEntryIds(entries);
    expect([...open]).toEqual(["t1", "a2"]);
    expect(open.has("a1")).toBe(false);
  });

  it("keeps everything when nobody has replied yet", () => {
    expect([...openChoiceEntryIds(entries.slice(1, 2))]).toEqual(["a1"]);
    expect(openChoiceEntryIds([]).size).toBe(0);
  });
});
