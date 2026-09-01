import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  applyConsolidationActions,
  applyCuratorActions,
  BENCH_STRATEGIES,
  foldFacts,
  formatTable,
  numberedNotebook,
  parseBenchConversation,
  parseConsolidationActions,
  parseCuratorActions,
  parseFacts,
  parseJudgeVerdict,
  renderJudgeInput,
  renderNotebook,
  summarize,
  type OneShot,
} from "./memory-bench";

describe("fixtures", () => {
  test("every checked-in conversation parses", () => {
    const dir = join(import.meta.dir, "../../../../../test/memory-bench");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) {
      const c = parseBenchConversation(
        JSON.parse(readFileSync(join(dir, f), "utf8")),
        f,
      );
      expect(c.turns.length).toBeGreaterThan(0);
    }
  });

  test("malformed conversations are rejected with the source name", () => {
    expect(() => parseBenchConversation({ id: "x" }, "broken.json")).toThrow(
      /broken\.json/,
    );
    expect(() =>
      parseBenchConversation(
        { id: "x", description: "d", turns: [{ input: "hi" }] },
        "b.json",
      ),
    ).toThrow(/malformed turn/);
  });
});

describe("parseFacts", () => {
  test("reads bullets, ignores prose, treats NONE as empty", () => {
    expect(parseFacts("- Prefers terse replies\n- Owns billing\n")).toEqual([
      "Prefers terse replies",
      "Owns billing",
    ]);
    expect(parseFacts("Here are the facts:\n- One fact")).toEqual(["One fact"]);
    expect(parseFacts("NONE")).toEqual([]);
    expect(parseFacts("  none  ")).toEqual([]);
    expect(parseFacts("")).toEqual([]);
  });
});

describe("foldFacts", () => {
  test("appends, dedupes case-insensitively, drops empties", () => {
    const n1 = foldFacts(
      [],
      ["Owns billing", "owns BILLING", "", "Prefers terse replies"],
    );
    expect(n1).toEqual(["Owns billing", "Prefers terse replies"]);
    const n2 = foldFacts(n1, ["Owns billing", "New fact"]);
    expect(n2).toEqual(["Owns billing", "Prefers terse replies", "New fact"]);
  });

  test("strips stray bullet prefixes and collapses whitespace", () => {
    expect(foldFacts([], ["- Uses  Zed   editor"])).toEqual([
      "Uses Zed editor",
    ]);
  });
});

describe("curator actions (agent-only strategy)", () => {
  test("parses REMEMBER/FORGET and ignores everything else", () => {
    expect(
      parseCuratorActions("REMEMBER: Uses Zed\nFORGET 2\nchatter\nNONE"),
    ).toEqual([
      { kind: "remember", text: "Uses Zed" },
      { kind: "forget", index: 2 },
    ]);
    expect(parseCuratorActions("NONE")).toEqual([]);
  });

  test("applies forgets by 1-based index, then remembers with dedup", () => {
    const notebook = ["In US Eastern time", "Owns billing"];
    const next = applyCuratorActions(notebook, [
      { kind: "forget", index: 1 },
      { kind: "remember", text: "In US Pacific time" },
      { kind: "remember", text: "owns billing" },
    ]);
    expect(next).toEqual(["Owns billing", "In US Pacific time"]);
  });
});

describe("consolidation actions", () => {
  test("parses UPDATE/DELETE/ADD case-insensitively", () => {
    expect(
      parseConsolidationActions(
        "UPDATE 2: Billing is named tabkeeper\ndelete 3\nADD: New fact\nNONE",
      ),
    ).toEqual([
      { kind: "update", index: 2, text: "Billing is named tabkeeper" },
      { kind: "delete", index: 3 },
      { kind: "add", text: "New fact" },
    ]);
  });

  test("applies against 1-based indices; adds dedupe against survivors", () => {
    const notebook = [
      "In Eastern time",
      "Service named ledgerd",
      "Sync Mondays 10am",
    ];
    const next = applyConsolidationActions(notebook, [
      { kind: "update", index: 2, text: "Service named tabkeeper" },
      { kind: "delete", index: 1 },
      { kind: "add", text: "In Pacific time" },
      { kind: "add", text: "service named TABKEEPER" },
    ]);
    expect(next).toEqual([
      "Service named tabkeeper",
      "Sync Mondays 10am",
      "In Pacific time",
    ]);
  });

  test("empty or NONE output leaves the notebook untouched", () => {
    const notebook = ["A fact"];
    expect(
      applyConsolidationActions(notebook, parseConsolidationActions("NONE")),
    ).toEqual(notebook);
  });
});

describe("strategies (with a scripted fake model)", () => {
  const conversation = parseBenchConversation(
    {
      id: "scripted",
      description: "two turns",
      turns: [
        { input: "I'm in Eastern time", reply: "Noted" },
        { input: "moved — Pacific now", reply: "Updated" },
      ],
    },
    "inline",
  );

  test("per-turn accumulates extracted facts across turns with dedup", async () => {
    const outputs = [
      "- In Eastern time",
      "- In Pacific time\n- In Eastern time",
    ];
    const oneShot: OneShot = async () => outputs.shift() ?? "NONE";
    const strategy = BENCH_STRATEGIES.find((s) => s.name === "per-turn")!;
    expect(await strategy.run(conversation, oneShot)).toEqual([
      "In Eastern time",
      "In Pacific time",
    ]);
  });

  test("consolidated runs one maintenance pass at the end", async () => {
    const calls: string[] = [];
    const oneShot: OneShot = async (system) => {
      calls.push(system.slice(0, 20));
      if (calls.length <= 2)
        return calls.length === 1 ? "- In Eastern time" : "- In Pacific time";
      return "UPDATE 1: In Pacific time\nDELETE 2";
    };
    const strategy = BENCH_STRATEGIES.find((s) => s.name === "consolidated")!;
    expect(await strategy.run(conversation, oneShot)).toEqual([
      "In Pacific time",
    ]);
    expect(calls.length).toBe(3);
  });

  test("agent-only lets the curator forget stale facts", async () => {
    const outputs = [
      "REMEMBER: In Eastern time",
      "FORGET 1\nREMEMBER: In Pacific time",
    ];
    const oneShot: OneShot = async () => outputs.shift() ?? "NONE";
    const strategy = BENCH_STRATEGIES.find((s) => s.name === "agent-only")!;
    expect(await strategy.run(conversation, oneShot)).toEqual([
      "In Pacific time",
    ]);
  });

  test("a failed model call (null) is treated as no-op, not a crash", async () => {
    const oneShot: OneShot = async () => null;
    for (const strategy of BENCH_STRATEGIES) {
      expect(await strategy.run(conversation, oneShot)).toEqual([]);
    }
  });
});

describe("judge parsing and reporting", () => {
  test("parses the verdict object out of surrounding prose and clamps scores", () => {
    const v = parseJudgeVerdict(
      'Sure! {"signalToNoise": 12, "staleness": -2, "inferenceVsObservation": 7.6, "notes": "ok"}',
    );
    expect(v).toEqual({
      signalToNoise: 10,
      staleness: 0,
      inferenceVsObservation: 8,
      notes: "ok",
    });
    expect(() => parseJudgeVerdict("no json here")).toThrow(/no JSON object/);
  });

  test("summarize averages per strategy and sorts by overall", () => {
    const rows = summarize([
      {
        strategy: "a",
        conversationId: "c1",
        notebook: "",
        verdict: {
          signalToNoise: 8,
          staleness: 8,
          inferenceVsObservation: 8,
          notes: "",
        },
      },
      {
        strategy: "a",
        conversationId: "c2",
        notebook: "",
        verdict: {
          signalToNoise: 6,
          staleness: 6,
          inferenceVsObservation: 6,
          notes: "",
        },
      },
      {
        strategy: "b",
        conversationId: "c1",
        notebook: "",
        verdict: {
          signalToNoise: 9,
          staleness: 9,
          inferenceVsObservation: 9,
          notes: "",
        },
      },
    ]);
    expect(rows[0]!.strategy).toBe("b");
    expect(rows[1]).toMatchObject({
      strategy: "a",
      conversations: 2,
      overall: 7,
    });
  });

  test("renderers produce the shapes the prompts describe", () => {
    expect(renderNotebook(["A", "B"])).toBe("- A\n- B");
    expect(numberedNotebook(["A", "B"])).toBe("1. A\n2. B");
    const conversation = parseBenchConversation(
      { id: "x", description: "d", turns: [{ input: "hi", reply: "yo" }] },
      "inline",
    );
    expect(renderJudgeInput(conversation, "")).toContain("(empty)");
    expect(formatTable(summarize([]))).toContain("strategy");
  });
});
