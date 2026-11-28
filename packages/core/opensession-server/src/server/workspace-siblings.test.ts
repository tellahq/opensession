import { describe, expect, it } from "bun:test";
import type { TranscriptEntry } from "./types";
import { buildWorkspaceSiblingsNote, lastExchange } from "./workspace-siblings";

function entry(
  type: TranscriptEntry["type"],
  content: string,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    id: `${type}-${content.slice(0, 8)}`,
    type,
    content,
    timestamp: "2026-11-28T10:00:00.000Z",
    ...extra,
  } as TranscriptEntry;
}

describe("lastExchange", () => {
  it("takes the last ask and the answer that followed it", () => {
    expect(
      lastExchange([
        entry("user", "First ask"),
        entry("assistant", "First answer"),
        entry("user", "Fix the header"),
        entry("tool_use", "Bash"),
        entry("assistant", "Fixed\nand pushed."),
      ]),
    ).toEqual({ lastAsk: "Fix the header", lastAnswer: "Fixed and pushed." });
  });

  it("leaves the outcome out while the last ask has no answer yet", () => {
    expect(
      lastExchange([
        entry("user", "Old"),
        entry("assistant", "Old answer"),
        entry("user", "Still running"),
      ]),
    ).toEqual({ lastAsk: "Still running", lastAnswer: undefined });
  });

  it("drops fenced harness context from the ask", () => {
    expect(
      lastExchange([
        entry(
          "user",
          '<opensession:context source="memory">\nsecret notes\n</opensession:context>\n\nShip it',
        ),
      ]).lastAsk,
    ).toBe("Ship it");
  });
});

describe("buildWorkspaceSiblingsNote", () => {
  const now = Date.parse("2026-11-28T12:00:00.000Z");

  it("is null without siblings", () => {
    expect(buildWorkspaceSiblingsNote({ siblings: [], more: 0, now })).toBe(
      null,
    );
  });

  it("lists each sibling with its state, PR and last exchange", () => {
    const note = buildWorkspaceSiblingsNote({
      workspaceName: "Header polish",
      now,
      more: 2,
      siblings: [
        {
          id: "os-a",
          title: "Tighten header spacing",
          isRunning: false,
          lastActivity: "2026-11-28T10:00:00.000Z",
          branch: "header-polish",
          prNumber: 42,
          prState: "MERGED",
          lastAsk: "Make the gap smaller",
          lastAnswer: "Merged #42.",
        },
        {
          id: "os-b",
          title: "Dark mode check",
          isRunning: true,
          lastActivity: "2026-11-28T11:59:00.000Z",
        },
      ],
    });
    expect(note).toContain(
      '## Other sessions in the workspace "Header polish"',
    );
    expect(note).toContain(
      "- Tighten header spacing · @session:os-a · idle · 2h ago · branch header-polish · PR #42 merged",
    );
    expect(note).toContain("  Last ask: Make the gap smaller");
    expect(note).toContain("  Outcome: Merged #42.");
    expect(note).toContain("- Dark mode check · @session:os-b · running");
    expect(note).toContain("2 older sessions not listed.");
  });
});
