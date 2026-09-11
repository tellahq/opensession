import { describe, expect, test } from "bun:test";
import {
  LEDGER_MAX_REFS,
  VoiceReferenceLedger,
  linkSpokenReferences,
  spokenNumbers,
} from "./desk-voice-refs";

const REPOS = [
  { id: "tella-fusion", ghRepo: "tellahq/tella-fusion" },
  { id: "opensession", ghRepo: "tellahq/opensession" },
];

const SESSION_A = "bks-b72fa30b-31dd-7f7c-b4e2-bf83fdffe513";
const SESSION_B = "bks-91ec3036-d4e8-7a47-ace1-ad7d3ae8fcc9";

/** The real Desk row that motivated this module. */
const SPOKEN_LIST =
  "Here are the reviewed ones. Six four seven four. Six four seven five, six four seven seven, and six four seven eight. The newer one still being reviewed is six four eight five, plus an approved allow attribute change at six four seven nine.";

function ledgerWith(...prs: Array<[string, number]>) {
  const ledger = new VoiceReferenceLedger();
  ledger.collect(
    "list_current_work",
    {},
    {
      sessions: prs.map(([repo, number], i) => ({
        id: `bks-0190${String(i).padStart(4, "0")}-0000-7000-8000-000000000000`,
        title: `Work ${i}`,
        repo,
        prNumber: number,
      })),
    },
    REPOS,
  );
  return ledger;
}

describe("spoken numbers", () => {
  const values = (text: string) => spokenNumbers(text).map((n) => n.value);

  test("digit by digit, with or without commas", () => {
    expect(values("six four seven four")).toEqual([6474]);
    expect(values("six, four, seven, four")).toEqual([6474]);
    expect(values("six oh four")).toEqual([604]);
    expect(values("six zero four")).toEqual([604]);
  });

  test("tens and teens", () => {
    expect(values("sixty-four seventy-four")).toEqual([6474]);
    expect(values("sixty four seventy four")).toEqual([6474]);
    expect(values("ninety-two")).toEqual([92]);
    expect(values("fifteen twelve")).toEqual([1512]);
    expect(values("sixty-four hundred")).toEqual([6400]);
  });

  test("thousands and hundreds", () => {
    expect(values("six thousand four hundred seventy-four")).toEqual([6474]);
    expect(values("six thousand four hundred and seventy-four")).toEqual([
      6400, 74,
    ]);
    expect(values("one hundred twenty three")).toEqual([123]);
    expect(values("twelve thousand")).toEqual([12000]);
  });

  test("digits as typed or transcribed", () => {
    expect(values("PR 6474 and 6475")).toEqual([6474, 6475]);
    expect(values("64 74")).toEqual([6474]);
  });

  test("a list of digit-by-digit numbers splits at punctuation", () => {
    expect(values(SPOKEN_LIST)).toEqual([6474, 6475, 6477, 6478, 6485, 6479]);
  });

  test("ignores what is not a spoken PR number", () => {
    // Already qualified, an id, a decimal, a lone digit, a leading zero.
    expect(values("tella-fusion#6474 is merged")).toEqual([]);
    expect(values("tellahq/tella-fusion#6474 is merged")).toEqual([]);
    expect(values("#6474 is merged")).toEqual([6474]);
    expect(values(`session ${SESSION_B} is running`)).toEqual([]);
    expect(values("about 1.5 seconds")).toEqual([]);
    expect(values("three sessions are running")).toEqual([]);
    expect(values("oh six")).toEqual([]);
    expect(values("hundred thousand")).toEqual([]);
    expect(values("a 123456 digit run")).toEqual([]);
  });

  test("reports the span of each number", () => {
    const text = "Look at six four seven four, please.";
    const [n] = spokenNumbers(text);
    expect(text.slice(n.start, n.end)).toBe("six four seven four");
  });
});

describe("VoiceReferenceLedger", () => {
  test("collects PRs and sessions from list_current_work rows", () => {
    const ledger = ledgerWith(["tella-fusion", 6474], ["opensession", 92]);
    expect(ledger.prRefsFor(6474)).toEqual([
      { repo: "tella-fusion", number: 6474 },
    ]);
    expect(ledger.prRefsFor(92)).toEqual([{ repo: "opensession", number: 92 }]);
    expect(ledger.prRefsFor(1)).toEqual([]);
    expect(ledger.titledSessions()).toEqual([]); // "Work 0" is too short
  });

  test("reads PR numbers off result text that names one known repo", () => {
    const ledger = new VoiceReferenceLedger();
    ledger.collect(
      "opensession-search_search_history",
      { query: "allow attribute" },
      {
        content: [
          {
            type: "text",
            text: [
              "tella-fusion#6479 approved allow attribute change",
              "PR 6485 in tella-fusion is still under review",
              "https://github.com/tellahq/opensession/pull/92 shipped",
              "#77 mentioned with tella-fusion and opensession together",
              "#88 mentioned with no repo at all",
              "opensession-server#99 is not a repo name",
            ].join("\n"),
          },
        ],
      },
      REPOS,
    );
    expect(ledger.prRefsFor(6479)).toEqual([
      { repo: "tella-fusion", number: 6479 },
    ]);
    expect(ledger.prRefsFor(6485)).toEqual([
      { repo: "tella-fusion", number: 6485 },
    ]);
    expect(ledger.prRefsFor(92)).toEqual([{ repo: "opensession", number: 92 }]);
    expect(ledger.prRefsFor(77)).toEqual([]);
    expect(ledger.prRefsFor(88)).toEqual([]);
    expect(ledger.prRefsFor(99)).toEqual([]);
  });

  test("reads session ids and titles off any result", () => {
    const ledger = new VoiceReferenceLedger();
    ledger.collect(
      "list_sessions",
      {},
      {
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { id: SESSION_A, title: "Show the transcript live" },
            ]),
          },
        ],
      },
      REPOS,
    );
    // The JSON was flattened to text, so the title is not a sibling field;
    // the id is still known.
    expect(ledger.titledSessions()).toEqual([]);
    ledger.collect(
      "inspect_session",
      { session_id: SESSION_A },
      { id: SESSION_A, title: "Show the transcript live", repo: "opensession" },
      REPOS,
    );
    expect(ledger.titledSessions()).toEqual([
      { id: SESSION_A, title: "Show the transcript live" },
    ]);
  });

  test("keeps started and steered sessions pending until taken once", () => {
    const ledger = new VoiceReferenceLedger();
    ledger.collect(
      "start_session",
      { prompt: "x" },
      { id: SESSION_A, started: true, mode: "code" },
      REPOS,
    );
    ledger.collect(
      "steer_session",
      { session_id: SESSION_B, message: "y" },
      { status: "queued", message: "queued" },
      REPOS,
    );
    // A failed start or steer names no session.
    ledger.collect(
      "start_session",
      { prompt: "" },
      { error: "start_session needs a prompt" },
      REPOS,
    );
    ledger.collect(
      "steer_session",
      { session_id: "bks-01900000-0000-7000-8000-00000000dead", message: "z" },
      { status: "error", message: "no such session" },
      REPOS,
    );
    expect(ledger.takePending()).toEqual([SESSION_A, SESSION_B]);
    expect(ledger.takePending()).toEqual([]);
  });

  test("is bounded and idempotent", () => {
    const ledger = new VoiceReferenceLedger();
    for (let round = 0; round < 3; round++)
      for (let n = 1; n <= LEDGER_MAX_REFS + 50; n++)
        ledger.collect(
          "inspect_session",
          {},
          { id: SESSION_A, repo: "opensession", prNumber: n },
          REPOS,
        );
    expect(ledger.prRefsFor(1)).toEqual([]);
    expect(ledger.prRefsFor(LEDGER_MAX_REFS + 50)).toEqual([
      { repo: "opensession", number: LEDGER_MAX_REFS + 50 },
    ]);
    expect(ledger.prRefsFor(51)).toHaveLength(1);
  });
});

describe("linkSpokenReferences", () => {
  test("rewrites the real Desk row into qualified PR mentions", () => {
    const ledger = ledgerWith(
      ["tella-fusion", 6474],
      ["tella-fusion", 6475],
      ["tella-fusion", 6477],
      ["tella-fusion", 6478],
      ["tella-fusion", 6485],
      ["tella-fusion", 6479],
    );
    expect(linkSpokenReferences(SPOKEN_LIST, ledger)).toBe(
      "Here are the reviewed ones. tella-fusion#6474. tella-fusion#6475, tella-fusion#6477, and tella-fusion#6478. The newer one still being reviewed is tella-fusion#6485, plus an approved allow attribute change at tella-fusion#6479.",
    );
  });

  test("links only the numbers the ledger knows", () => {
    const ledger = ledgerWith(["tella-fusion", 6474]);
    expect(linkSpokenReferences(SPOKEN_LIST, ledger)).toBe(
      SPOKEN_LIST.replace("Six four seven four", "tella-fusion#6474"),
    );
    expect(linkSpokenReferences(SPOKEN_LIST, new VoiceReferenceLedger())).toBe(
      SPOKEN_LIST,
    );
  });

  test("handles every spoken shape and is idempotent", () => {
    const ledger = ledgerWith(["tella-fusion", 6474]);
    for (const spoken of [
      "sixty-four seventy-four",
      "six thousand four hundred seventy-four",
      "six, four, seven, four",
      "PR 6474",
      "PR #6474",
    ]) {
      const once = linkSpokenReferences(`Merged ${spoken} today.`, ledger);
      expect(once).toBe(
        spoken.startsWith("PR")
          ? "Merged PR tella-fusion#6474 today."
          : "Merged tella-fusion#6474 today.",
      );
      expect(linkSpokenReferences(once, ledger)).toBe(once);
    }
  });

  test("leaves a number that PRs in two repos share alone", () => {
    const ledger = ledgerWith(["tella-fusion", 92], ["opensession", 92]);
    expect(linkSpokenReferences("Ninety-two is approved.", ledger)).toBe(
      "Ninety-two is approved.",
    );
  });

  test("appends the started session once, to the next assistant row", () => {
    const ledger = new VoiceReferenceLedger();
    ledger.collect(
      "start_session",
      { prompt: "x", mode: "code" },
      { id: SESSION_A, started: true, mode: "code" },
      REPOS,
    );
    const first = linkSpokenReferences(
      "I've kicked off work to make the transcript show up as I'm speaking",
      ledger,
    );
    expect(first).toBe(
      `I've kicked off work to make the transcript show up as I'm speaking\n\nSession: ${SESSION_A}`,
    );
    expect(linkSpokenReferences("Anything else?", ledger)).toBe(
      "Anything else?",
    );
  });

  test("names a listed session whose title the row says", () => {
    const ledger = new VoiceReferenceLedger();
    ledger.collect(
      "list_current_work",
      {},
      {
        sessions: [
          {
            id: SESSION_A,
            title: "Fix the login redirect",
            repo: "opensession",
          },
          { id: SESSION_B, title: "Docs", repo: "opensession" },
        ],
      },
      REPOS,
    );
    expect(
      linkSpokenReferences(
        "Fix the Login Redirect is still running, and Docs is done.",
        ledger,
      ),
    ).toBe(
      `Fix the Login Redirect is still running, and Docs is done.\n\nSession: ${SESSION_A}`,
    );
    // Not repeated for an id the row already carries, and several sessions
    // share one trailer.
    ledger.collect(
      "start_session",
      { prompt: "y" },
      { id: SESSION_B, started: true, mode: "ask" },
      REPOS,
    );
    expect(
      linkSpokenReferences(`Fix the login redirect and ${SESSION_A}`, ledger),
    ).toBe(`Fix the login redirect and ${SESSION_A}\n\nSession: ${SESSION_B}`);
  });
});
