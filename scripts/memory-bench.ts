/**
 * Memory-strategy benchmark runner — `bun run bench:memory`.
 *
 * Replays the canned conversations in test/memory-bench/*.json through each
 * strategy in src/server/memory-bench.ts and has an LLM judge score every
 * resulting notebook. Real model calls through Pi (the same oneShot path titles and
 * classifiers use), so this is a SCRIPT, run
 * deliberately — never part of bun test.
 *
 * Env:
 *   MEMORY_BENCH_STRATEGIES  comma list to run (default: all)
 *   MEMORY_BENCH_FIXTURES    comma list of conversation ids (default: all)
 *   MEMORY_BENCH_MODEL       extraction/curation model (default: oneshot default, haiku)
 *   MEMORY_BENCH_JUDGE_MODEL judge model (default: claude-sonnet-5 — judge quality
 *                            bounds the whole bench, don't skimp it)
 *   MEMORY_BENCH_OUT         path for a JSON report of rows + full notebooks
 *
 * Read the notebooks in the report, not just the table — a judge can be
 * fooled, and the per-conversation notebooks are small enough to eyeball.
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { oneShot } from "../packages/core/opensession-server/src/server/one-shot";
import {
  BENCH_STRATEGIES,
  formatTable,
  JUDGE_PROMPT,
  parseBenchConversation,
  parseJudgeVerdict,
  renderJudgeInput,
  renderNotebook,
  summarize,
  type BenchResult,
  type OneShot,
} from "../packages/core/opensession-server/src/server/memory-bench";

const requested = (process.env.MEMORY_BENCH_STRATEGIES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const strategies = requested.length
  ? BENCH_STRATEGIES.filter((s) => requested.includes(s.name))
  : BENCH_STRATEGIES;
if (requested.length && strategies.length !== requested.length) {
  const known = BENCH_STRATEGIES.map((s) => s.name).join(", ");
  console.error(
    `unknown strategy in MEMORY_BENCH_STRATEGIES (known: ${known})`,
  );
  process.exit(1);
}

const fixtureDir = new URL("../test/memory-bench/", import.meta.url).pathname;
const wantedFixtures = (process.env.MEMORY_BENCH_FIXTURES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const conversations = readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) =>
    parseBenchConversation(
      JSON.parse(readFileSync(join(fixtureDir, f), "utf8")),
      f,
    ),
  )
  .filter((c) => !wantedFixtures.length || wantedFixtures.includes(c.id));
if (!conversations.length) {
  console.error("no conversations selected — check MEMORY_BENCH_FIXTURES");
  process.exit(1);
}

const DEFAULT_JUDGE_MODEL = "claude-sonnet-5";

const strategyOneShot: OneShot = (system, prompt) =>
  oneShot(prompt, {
    system,
    label: "memory-bench",
    ...(process.env.MEMORY_BENCH_MODEL
      ? { model: process.env.MEMORY_BENCH_MODEL }
      : {}),
  });

const judgeOneShot: OneShot = (system, prompt) =>
  oneShot(prompt, {
    system,
    label: "memory-bench-judge",
    model: process.env.MEMORY_BENCH_JUDGE_MODEL || DEFAULT_JUDGE_MODEL,
  });

const results: BenchResult[] = [];
for (const strategy of strategies) {
  for (const conversation of conversations) {
    const facts = await strategy.run(conversation, strategyOneShot);
    const notebook = renderNotebook(facts);
    const judgeOut = await judgeOneShot(
      JUDGE_PROMPT,
      renderJudgeInput(conversation, notebook),
    );
    if (!judgeOut) {
      console.error(
        `[${strategy.name}] ${conversation.id}: judge call failed (engine down or no usable account) — aborting`,
      );
      process.exit(1);
    }
    const verdict = parseJudgeVerdict(judgeOut);
    results.push({
      strategy: strategy.name,
      conversationId: conversation.id,
      notebook,
      verdict,
    });
    console.log(
      `[${strategy.name}] ${conversation.id}: s/n=${verdict.signalToNoise} stale=${verdict.staleness} ` +
        `infer=${verdict.inferenceVsObservation} — ${verdict.notes}`,
    );
  }
}

const rows = summarize(results);
console.log(`\n${formatTable(rows)}\n`);

const outPath = process.env.MEMORY_BENCH_OUT;
if (outPath) {
  writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), rows, results },
      null,
      2,
    ),
  );
  console.log(`report written to ${outPath}`);
}
