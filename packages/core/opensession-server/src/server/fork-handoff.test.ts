import { describe, expect, it } from "bun:test";
import {
  buildForkHandoffNote,
  buildEngineSwitchHandoffNote,
  buildSessionContextNote,
} from "./fork-handoff";
import type { TranscriptEntry } from "./types";

function entry(
  id: string,
  type: TranscriptEntry["type"],
  content: string,
): TranscriptEntry {
  return {
    id,
    type,
    content,
    timestamp: "2026-07-02T00:00:00.000Z",
  };
}

describe("buildForkHandoffNote", () => {
  it("summarizes recent user/assistant/system transcript entries for a new engine fork", () => {
    const note = buildForkHandoffNote({
      sourceId: "bks-source",
      sourceTitle: "Investigate Codex support",
      sourceModel: "gpt-5.5",
      entries: [
        entry("u1", "user", "Please inspect this."),
        entry("t1", "tool_use", "Using Bash"),
        entry("a1", "assistant", "I found the issue."),
      ],
    });

    expect(note).toContain("bks-source");
    expect(note).toContain("Investigate Codex support");
    expect(note).toContain("gpt-5.5");
    expect(note).toContain("- User: Please inspect this.");
    expect(note).toContain("- Assistant: I found the issue.");
    expect(note).not.toContain("Using Bash");
  });

  it("cuts the transcript at the requested fork message when present", () => {
    const note = buildForkHandoffNote({
      sourceId: "bks-source",
      messageId: "a1",
      entries: [
        entry("u1", "user", "before"),
        entry("a1", "assistant", "fork here"),
        entry("u2", "user", "after"),
      ],
    });

    expect(note).toContain("message a1");
    expect(note).toContain("before");
    expect(note).toContain("fork here");
    expect(note).not.toContain("after");
  });
});

describe("buildSessionContextNote", () => {
  it("sections each attached session with its id, title, model and conversational turns", () => {
    const note = buildSessionContextNote([
      {
        id: "bks-one",
        title: "Lighten tab background",
        model: "gpt-5.5",
        entries: [
          entry("u1", "user", "Make the active tab lighter."),
          entry("t1", "tool_use", "Using Edit"),
          entry("a1", "assistant", "Done — bumped the token."),
        ],
      },
      {
        id: "bks-two",
        title: null,
        entries: [],
      },
    ]);

    expect(note).toContain("## Attached session transcripts");
    expect(note).toContain(
      "### Lighten tab background — @session:bks-one (gpt-5.5)",
    );
    expect(note).toContain("- User: Make the active tab lighter.");
    expect(note).toContain("- Assistant: Done — bumped the token.");
    expect(note).not.toContain("Using Edit");
    // A session with no transcript still gets a section, marked empty.
    expect(note).toContain("### Untitled session — @session:bks-two");
    expect(note).toContain("(no transcript yet)");
    // Points at the tool that fetches the full history beyond the excerpt.
    expect(note).toContain("get_session");
  });

  it("keeps only the newest entries per session", () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      entry(`u${i}`, "user", `turn ${i}`),
    );
    const note = buildSessionContextNote(
      [{ id: "bks-long", title: "Long session", entries }],
      5,
    );
    expect(note).toContain("turn 39");
    expect(note).toContain("turn 35");
    expect(note).not.toContain("turn 34");
  });
});

describe("buildEngineSwitchHandoffNote", () => {
  it("bridges the conversation when a fresh target engine takes over", () => {
    const note = buildEngineSwitchHandoffNote({
      fromModel: "claude-fable-5-1",
      fromProvider: "claude",
      toProvider: "codex",
      targetResuming: false,
      entries: [
        entry("u1", "user", "Implement the parser."),
        entry("t1", "tool_use", "Using Edit"),
        entry("a1", "assistant", "Here is the plan."),
      ],
    });

    expect(note).toContain("Engine handoff");
    expect(note).toContain(
      "switched mid-conversation from claude-fable-5-1 (claude)",
    );
    expect(note).toContain("continuing the *same* session");
    expect(note).toContain("- User: Implement the parser.");
    expect(note).toContain("- Assistant: Here is the plan.");
    // Tool calls are omitted — only conversational turns bridge.
    expect(note).not.toContain("Using Edit");
    // Fresh target gets the full-conversation framing, not the resume framing.
    expect(note).toContain(
      "treat the transcript below as the conversation so far",
    );
  });

  it("uses resume framing when the target remembers its own earlier turns", () => {
    const note = buildEngineSwitchHandoffNote({
      fromProvider: "codex",
      toProvider: "claude",
      targetResuming: true,
      entries: [entry("a1", "assistant", "Codex did the migration.")],
    });

    expect(note).toContain("switched mid-conversation from codex to you");
    expect(note).toContain("you remember the conversation up to the switch");
    expect(note).toContain("- Assistant: Codex did the migration.");
  });

  it("includes tool activity when a fresh session replaces the same engine", () => {
    const note = buildEngineSwitchHandoffNote({
      fromProvider: "pi",
      toProvider: "pi",
      sameEngineRestart: true,
      entries: [
        entry("u1", "user", "Inspect the failing build."),
        entry("t1", "tool_use", "Running the test suite"),
        entry("r1", "tool_result", "3 tests failed in session-transfer"),
      ],
    });

    expect(note).toContain("- Tool: Running the test suite");
    expect(note).toContain("- Tool result: 3 tests failed in session-transfer");
  });

  it("degrades gracefully with no transcript entries", () => {
    const note = buildEngineSwitchHandoffNote({
      fromProvider: "claude",
      toProvider: "codex",
      entries: [],
    });
    expect(note).toContain("No prior transcript entries were available.");
  });

  it("keeps instructions older than the previous 14-entry handoff window", () => {
    const entries = [
      entry("u0", "user", "Keep the report links pointed at Plain."),
    ];
    for (let i = 1; i <= 20; i++) {
      entries.push(entry(`a${i}`, "assistant", `Progress update ${i}.`));
    }

    const note = buildEngineSwitchHandoffNote({
      fromProvider: "claude",
      toProvider: "codex",
      targetResuming: false,
      entries,
    });

    expect(note).toContain("Keep the report links pointed at Plain.");
    expect(note).toContain("Progress update 20.");
  });

  it("drops only the oldest turns when the handoff reaches its character budget", () => {
    const note = buildEngineSwitchHandoffNote({
      fromProvider: "claude",
      toProvider: "codex",
      entries: [
        entry("u1", "user", "old instruction"),
        entry("a1", "assistant", "new instruction"),
      ],
      maxChars: 40,
    });

    expect(note).toContain("Earlier conversation omitted");
    expect(note).not.toContain("old instruction");
    expect(note).toContain("new instruction");
  });
});
