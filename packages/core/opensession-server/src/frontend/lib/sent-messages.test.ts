import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "./types";
import { collectSentMessages } from "./sent-messages";

function entry(
  patch: Partial<TranscriptEntry> & Pick<TranscriptEntry, "id">,
): TranscriptEntry {
  return {
    type: "user",
    content: "",
    timestamp: "2026-08-15T10:00:00.000Z",
    ...patch,
  };
}

type Presentation = NonNullable<TranscriptEntry["presentation"]>;

function tool(
  id: string,
  family: Presentation["family"],
  detail: Presentation["detail"],
  toolInput?: { command: string },
): TranscriptEntry {
  const transcriptEntry = entry({
    id,
    type: "tool_use",
    presentation: { canonical: "Tool", name: "Tool", family, detail },
  });
  if (toolInput) transcriptEntry.toolInput = toolInput;
  return transcriptEntry;
}

describe("collectSentMessages", () => {
  test("indexes user messages in order and nothing else", () => {
    const sent = collectSentMessages([
      entry({ id: "a", content: "Add a way to jump back" }),
      entry({ id: "b", type: "assistant", content: "On it" }),
      entry({ id: "c", type: "tool_use", content: "", toolName: "read" }),
      entry({ id: "d", content: "Make the ticks quieter" }),
    ]);
    expect(sent.map((m) => m.id)).toEqual(["a", "d"]);
    expect(sent[0].preview).toBe("Add a way to jump back");
  });

  test("skips entries the transcript renders as a notice", () => {
    // A GitHub-attributed line is an operational status, not something a
    // person typed. classifyEntry turns it into a notice row.
    const sent = collectSentMessages([
      entry({ id: "a", content: "[GitHub] PR #12 merged by kent" }),
      entry({ id: "b", content: "Ship it" }),
    ]);
    expect(sent.map((m) => m.id)).toEqual(["b"]);
  });

  test("credits a teammate's steer and drops the delivery prefix", () => {
    const [message] = collectSentMessages([
      entry({ id: "a", content: "[Kent] use the light theme" }),
    ]);
    expect(message.sender).toBe("Kent");
    expect(message.preview).toBe("use the light theme");
  });

  test("previews what you said, not the passage you quoted", () => {
    const [message] = collectSentMessages([
      entry({
        id: "a",
        content: "> the rail sits on the scrollbar\n> on macOS\n\nFix that",
      }),
    ]);
    expect(message.preview).toBe("Fix that");
  });

  test("keeps a quote-only message rather than dropping it", () => {
    const [message] = collectSentMessages([
      entry({ id: "a", content: "> this line here" }),
    ]);
    expect(message.preview).toContain("this line here");
  });

  test("flattens markdown into one line and clamps a long paste", () => {
    const [message] = collectSentMessages([
      entry({
        id: "a",
        content:
          "## Heading\n\n- **bold** item\n- `code` item\n\n```\nignored\n```",
      }),
    ]);
    expect(message.preview).toBe("Heading bold item code item");

    const [long] = collectSentMessages([
      entry({ id: "b", content: "word ".repeat(400) }),
    ]);
    expect(long.preview.length).toBeLessThanOrEqual(121);
    expect(long.preview.endsWith("…")).toBe(true);
  });

  test("names the attachment when a message has no words", () => {
    const sent = collectSentMessages([
      entry({ id: "a", images: ["/media?path=one.png"] }),
      entry({ id: "b", images: ["one.png", "two.png"] }),
      entry({
        id: "c",
        files: [{ name: "notes.pdf", path: "/tmp/notes.pdf" }],
      }),
    ]);
    expect(sent.map((m) => m.preview)).toEqual([
      "Image",
      "2 images",
      "notes.pdf",
    ]);
  });

  test("carries the agent's closing words for that turn", () => {
    const sent = collectSentMessages([
      entry({ id: "a", content: "Fix the rail" }),
      entry({ id: "a1", type: "assistant", content: "Let me look at it." }),
      entry({ id: "a2", type: "assistant", content: "**Fixed** the gutter." }),
      entry({ id: "b", content: "Now make it quieter" }),
      entry({ id: "b1", type: "assistant", content: "Done." }),
    ]);
    expect(sent.map((m) => m.reply)).toEqual(["Fixed the gutter.", "Done."]);
  });

  test("names what the turn produced, biggest thing first", () => {
    const sent = collectSentMessages([
      entry({ id: "a", content: "Commit it" }),
      tool("a1", "edit", { kind: "path", path: "src/one.ts" }),
      tool("a2", "run", { kind: "command", command: "git commit -m x" }),
      entry({ id: "b", content: "Open a PR too" }),
      tool("b1", "run", { kind: "command", command: "git commit -m y" }),
      tool("b2", "run", { kind: "command", command: "gh pr create --fill" }),
      entry({ id: "c", content: "Just edits" }),
      tool("c1", "edit", { kind: "path", path: "src/one.ts" }),
      tool("c2", "edit", { kind: "path", path: "src/two.ts" }),
      tool("c3", "edit", { kind: "path", path: "src/one.ts" }),
      entry({ id: "d", content: "What does this do?" }),
      tool("d1", "file", { kind: "path", path: "src/one.ts" }),
    ]);
    expect(sent.map((m) => m.outcome?.label)).toEqual([
      "Commit",
      "Pull request",
      "Edited 2 files",
      undefined,
    ]);
  });

  test("reads the whole command, not the truncated one its row shows", () => {
    const [message] = collectSentMessages([
      entry({ id: "a", content: "Land it" }),
      tool(
        "a1",
        "run",
        {
          kind: "command",
          command: "cd repo && set -e ⏎ BASE=$(git rev-parse HEAD)…",
        },
        {
          command:
            "cd repo\nBASE=$(git rev-parse HEAD)\ngit commit-tree $T -p $BASE -m x",
        },
      ),
    ]);
    expect(message.outcome?.label).toBe("Commit");
  });

  test("a mid-turn notice does not take the answer away from the question", () => {
    const sent = collectSentMessages([
      entry({ id: "a", content: "Keep going" }),
      entry({ id: "a1", content: "[GitHub] PR #12 merged by kent" }),
      entry({ id: "a2", type: "assistant", content: "Kept going." }),
    ]);
    expect(sent.map((m) => m.reply)).toEqual(["Kept going."]);
  });

  test("skips an entry the transcript draws nothing for", () => {
    // Delivery plumbing whose body was fenced context: MessageBubble renders
    // null, so there is no bubble to scroll to.
    expect(collectSentMessages([entry({ id: "a", content: "" })])).toEqual([]);
  });
});
