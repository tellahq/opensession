import { describe, expect, it } from "bun:test";
import {
  MAX_SUGGESTIONS,
  endsOnAQuestion,
  parseSuggestions,
  sanitizeSuggestion,
} from "./reply-suggestions";

const assistant = (content: string) => ({ type: "assistant", content });

describe("endsOnAQuestion", () => {
  it("passes a turn that closes on a question to the human", () => {
    expect(
      endsOnAQuestion([
        assistant(
          "I found two issues.\n\nWant me to fix both, or just the first?",
        ),
      ]),
    ).toBe(true);
  });

  it("rejects a turn that just reports, however obvious the next step", () => {
    expect(
      endsOnAQuestion([assistant("Fixed both, pushed, tests pass.")]),
    ).toBe(false);
    expect(endsOnAQuestion([])).toBe(false);
    expect(endsOnAQuestion([{ type: "tool_result", content: "ok?" }])).toBe(
      false,
    );
  });

  it("ignores a question mark that belongs to code or a URL", () => {
    // A glob, a ternary and a query string are not the agent asking anything.
    expect(endsOnAQuestion([assistant("Ran `ls *.?s` and it worked.")])).toBe(
      false,
    );
    expect(
      endsOnAQuestion([assistant("Done.\n\n```ts\nconst x = a ? b : c;\n```")]),
    ).toBe(false);
    expect(
      endsOnAQuestion([
        assistant("Opened https://x.dev/pr?tab=files for review."),
      ]),
    ).toBe(false);
  });

  it("ignores a question buried mid-report rather than asked at the end", () => {
    expect(
      endsOnAQuestion([
        assistant(
          "You asked whether the cache was stale?\n\nIt was.\n\nFixed it and pushed.",
        ),
      ]),
    ).toBe(false);
  });

  it("reads the last assistant message, not an older one", () => {
    expect(
      endsOnAQuestion([
        assistant("Should I keep going?"),
        { type: "user", content: "yes" },
        assistant("Done."),
      ]),
    ).toBe(false);
  });
});

describe("sanitizeSuggestion", () => {
  it("keeps a well-formed chip", () => {
    expect(
      sanitizeSuggestion({
        label: "Fix both",
        text: "Fix both the queue race and the stale cache read, then run bun test.",
      }),
    ).toEqual({
      label: "Fix both",
      text: "Fix both the queue race and the stale cache read, then run bun test.",
    });
  });

  it("strips quoting, trailing punctuation and collapsed whitespace", () => {
    expect(
      sanitizeSuggestion({ label: '"Ship it."', text: "  Ship  it now.  " }),
    ).toEqual({ label: "Ship it", text: "Ship it now." });
  });

  it("replaces an em dash in a label rather than keeping one", () => {
    // The house rule bans them, and a chip is UI copy like any other.
    expect(
      sanitizeSuggestion({ label: "Fix—both", text: "Fix both." })?.label,
    ).toBe("Fix both");
  });

  it("rejects a label that is really a sentence", () => {
    expect(
      sanitizeSuggestion({
        label: "Fix both of the issues you found",
        text: "Fix both.",
      }),
    ).toBeNull();
    expect(
      sanitizeSuggestion({
        label: "Reconsider the whole approach",
        text: "Go on.",
      }),
    ).toBeNull();
  });

  it("rejects filler that answers nothing", () => {
    // A lone "Continue" is what the model offers when the turn never asked.
    expect(
      sanitizeSuggestion({ label: "Continue", text: "Please continue." }),
    ).toBeNull();
    expect(
      sanitizeSuggestion({ label: "looks good", text: "Looks good to me." }),
    ).toBeNull();
    expect(
      sanitizeSuggestion({ label: "Tell me more", text: "Tell me more." }),
    ).toBeNull();
  });

  it("rejects a chip with no label or no instruction behind it", () => {
    expect(sanitizeSuggestion({ label: "", text: "Fix both." })).toBeNull();
    expect(sanitizeSuggestion({ label: "Fix", text: "" })).toBeNull();
    expect(sanitizeSuggestion({ label: "Fix", text: "ok" })).toBeNull();
    expect(sanitizeSuggestion("Fix both")).toBeNull();
    expect(sanitizeSuggestion(null)).toBeNull();
  });
});

describe("parseSuggestions", () => {
  const two = [
    {
      label: "Fix both",
      text: "Fix both issues you listed, then re-run the tests.",
    },
    { label: "Only step 1", text: "Only fix step 1 for now and stop there." },
  ];

  it("parses a clean JSON array", () => {
    expect(parseSuggestions(JSON.stringify(two))).toEqual(two);
  });

  it("tolerates a markdown fence and surrounding narration", () => {
    expect(
      parseSuggestions("```json\n" + JSON.stringify(two) + "\n```"),
    ).toEqual(two);
    expect(
      parseSuggestions(
        `Here are the chips:\n${JSON.stringify(two)}\nHope that helps.`,
      ),
    ).toEqual(two);
  });

  it("returns nothing for the empty answer, which is the common one", () => {
    expect(parseSuggestions("[]")).toEqual([]);
    expect(parseSuggestions(null)).toEqual([]);
    expect(parseSuggestions("I don't think there is a decision here.")).toEqual(
      [],
    );
    expect(parseSuggestions("{ not an array }")).toEqual([]);
  });

  it("keeps a lone chip: most questions have one likely answer", () => {
    expect(parseSuggestions(JSON.stringify([two[0]]))).toEqual([two[0]]);
    // ...including when the second chip was the one that failed validation.
    expect(
      parseSuggestions(
        JSON.stringify([
          two[0],
          { label: "A whole sentence of a label here", text: "Go" },
        ]),
      ),
    ).toEqual([two[0]]);
  });

  it("collapses chips that read the same and caps the row", () => {
    expect(
      parseSuggestions(
        JSON.stringify([
          two[0],
          { label: "fix both", text: "Different text." },
          two[1],
        ]),
      ),
    ).toEqual(two);
    const many = Array.from({ length: 8 }, (_, i) => ({
      label: `Option ${i}`,
      text: `Take option ${i}, please.`,
    }));
    expect(parseSuggestions(JSON.stringify(many))).toHaveLength(
      MAX_SUGGESTIONS,
    );
    expect(MAX_SUGGESTIONS).toBe(2);
  });
});
