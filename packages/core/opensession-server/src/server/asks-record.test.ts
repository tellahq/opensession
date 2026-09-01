import { afterEach, describe, expect, test } from "bun:test";
import { classifyEntry } from "@tellahq/opensession-protocol/notices";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import {
  answeredAskData,
  askRecordEntryContent,
  recordAskAnswer,
} from "./asks";
import { setTranscriptForwarder } from "./transcript-forward";

const QUESTION = {
  header: "Choice",
  question: "Which option?",
  options: [{ label: "One" }, { label: "Two" }, { label: "Three" }],
};

function askEntry(content: string): TranscriptEntry {
  return {
    id: "e1",
    type: "system",
    content,
    timestamp: new Date().toISOString(),
    noticeKind: "ask",
  };
}

describe("answered-ask record", () => {
  afterEach(() => setTranscriptForwarder(undefined));

  test("persists directly under the Open Session id", () => {
    const batches: Array<{
      sessionId: string;
      lines: Record<string, unknown>[];
    }> = [];
    setTranscriptForwarder((sessionId, lines) => {
      batches.push({ sessionId, lines });
    });

    recordAskAnswer("os-session", [QUESTION], { "Which option?": "Two" });

    expect(batches).toHaveLength(1);
    expect(batches[0].sessionId).toBe("os-session");
    expect(JSON.stringify(batches[0].lines[0])).toContain(
      "<ask-record>Answered: Two",
    );
    expect(batches[0].lines[0].ask).toEqual(
      answeredAskData([QUESTION], { "Which option?": "Two" }),
    );
  });

  test("preserves descriptions and selection semantics in structured data", () => {
    const questions = [
      {
        ...QUESTION,
        multiSelect: true,
        options: [
          { label: "One", description: "First choice" },
          { label: "Two" },
        ],
      },
    ];
    expect(answeredAskData(questions, { "Which option?": "One, Two" })).toEqual(
      {
        version: 1,
        questions: [
          {
            header: "Choice",
            question: "Which option?",
            multiSelect: true,
            options: [
              { label: "One", description: "First choice" },
              { label: "Two" },
            ],
            answer: "One, Two",
          },
        ],
      },
    );
  });

  test("titles with the pick and bolds it among the options", () => {
    const content = askRecordEntryContent([QUESTION], {
      "Which option?": "Two",
    });
    const [title, ...rest] = content.split("\n");
    expect(title).toBe("Answered: Two");
    const body = rest.join("\n");
    expect(body).toContain("**Choice: Which option?**");
    expect(body).toContain("- A. One");
    expect(body).toContain("- **B. Two**");
    expect(body).toContain("- C. Three");
  });

  test("marks every pick of a multi-select answer", () => {
    const content = askRecordEntryContent([QUESTION], {
      "Which option?": "One, Three",
    });
    expect(content).toContain("- **A. One**");
    expect(content).toContain("- B. Two");
    expect(content).toContain("- **C. Three**");
  });

  test("records a typed answer that was not on offer", () => {
    const content = askRecordEntryContent([QUESTION], {
      "Which option?": "Something else entirely",
    });
    expect(content.split("\n")[0]).toBe("Answered: Something else entirely");
    expect(content).toContain("- **Something else entirely** (typed)");
  });

  test("a long answer stays one line in the title", () => {
    const answer = `${"x".repeat(200)}\nsecond line`;
    const title = askRecordEntryContent([QUESTION], {
      "Which option?": answer,
    }).split("\n")[0];
    expect(title.length).toBeLessThanOrEqual(84);
    expect(title.endsWith("…")).toBe(true);
  });

  test("counts several questions in the title and keeps each section", () => {
    const second = {
      question: "Ship it?",
      options: [{ label: "Yes" }, { label: "No" }],
    };
    const content = askRecordEntryContent([QUESTION, second], {
      "Which option?": "One",
      "Ship it?": "No",
    });
    expect(content.split("\n")[0]).toBe("Answered 2 questions");
    expect(content).toContain("- **A. One**");
    expect(content).toContain("- **B. No**");
  });

  test("classifies as a collapsed notice whose title is the pick", () => {
    const entry = classifyEntry(
      askEntry(askRecordEntryContent([QUESTION], { "Which option?": "Two" })),
    );
    expect(entry.notice).toMatchObject({
      kind: "ask",
      title: "Answered: Two",
      tone: "info",
      body: "collapsed",
    });
    // The title is lifted out of the body a client renders.
    expect(entry.content.startsWith("**Choice:")).toBe(true);
  });

  test("a title-only record renders without a show toggle", () => {
    const entry = classifyEntry(askEntry("Answered: Two"));
    expect(entry.notice?.title).toBe("Answered: Two");
    expect(entry.notice?.body).toBeUndefined();
    expect(entry.content).toBe("");
  });
});
