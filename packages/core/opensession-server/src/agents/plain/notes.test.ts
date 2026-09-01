import { describe, expect, it } from "bun:test";
import { PLAIN_NOTE_MAX_CHARS, splitNoteText } from "./notes";

/** Body text with the "(1/3)" marker stripped back off. */
function body(part: string): string {
  return part.replace(/\n\n\(\d+\/\d+\)$/, "");
}

describe("splitNoteText", () => {
  it("leaves a note that fits alone, with no part marker", () => {
    expect(splitNoteText("short note")).toEqual(["short note"]);
    const exact = "x".repeat(PLAIN_NOTE_MAX_CHARS);
    expect(splitNoteText(exact)).toEqual([exact]);
  });

  it("splits a long note into parts Plain accepts", () => {
    const parts = splitNoteText("y".repeat(PLAIN_NOTE_MAX_CHARS * 2 + 500));
    expect(parts.length).toBe(3);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(PLAIN_NOTE_MAX_CHARS);
    }
    expect(parts[0]).toEndWith("(1/3)");
    expect(parts[2]).toEndWith("(3/3)");
  });

  it("keeps every character of the original", () => {
    const paragraphs = Array.from(
      { length: 400 },
      (_, i) => `Paragraph ${i} with a bit of detail about the ticket.`,
    ).join("\n\n");
    const rejoined = splitNoteText(paragraphs).map(body).join("\n\n");
    expect(rejoined).toBe(paragraphs);
  });

  it("cuts at a paragraph boundary when there is one", () => {
    const para = `${"a".repeat(8000)}\n\n${"b".repeat(5000)}`;
    const parts = splitNoteText(para);
    expect(parts.length).toBe(2);
    expect(body(parts[0] ?? "")).toBe("a".repeat(8000));
    expect(body(parts[1] ?? "")).toBe("b".repeat(5000));
  });

  it("balances a code fence the cut lands inside", () => {
    const log = Array.from({ length: 1500 }, (_, i) => `line ${i} of log`).join(
      "\n",
    );
    const parts = splitNoteText(`Here is the log:\n\n\`\`\`\n${log}\n\`\`\``);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      const fences = part.split("\n").filter((l) => l.startsWith("```")).length;
      expect(fences % 2).toBe(0);
      expect(part.length).toBeLessThanOrEqual(PLAIN_NOTE_MAX_CHARS);
    }
  });

  it("hard-cuts text with no boundary to cut at", () => {
    const parts = splitNoteText("z".repeat(25_000));
    expect(parts.length).toBe(3);
    expect(parts.map(body).join("")).toBe("z".repeat(25_000));
  });
});
