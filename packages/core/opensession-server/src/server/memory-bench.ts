/**
 * Memory bench — the measuring stick for memory-strategy changes, ported from
 * yc-software/qm (MIT), src/memory/bench.ts + the per-turn/consolidation
 * strategy prompts.
 *
 * Until now a change to how the agent remembers things could only be judged by
 * vibes: edit the tool description or the prompt guidance, watch the stores
 * for a week, argue. This module makes it a number. Canned conversations
 * (test/memory-bench/*.json) are replayed through each candidate strategy,
 * the notebook each one produces is scored by an LLM judge on three axes
 * (0-10, higher better):
 *
 *   signalToNoise          — durable, reusable facts vs trivia/duplicates
 *   staleness              — when a fact changed mid-conversation, does the
 *                            notebook hold the LATEST state?
 *   inferenceVsObservation — recorded facts were actually stated, not the
 *                            model's speculation dressed up as fact
 *
 * Three strategies are benched (scripts/memory-bench.ts is the runner —
 * `bun run bench:memory`; real model calls, so it is a script, never a test):
 *
 *   agent-only    — what we ship today: nothing is saved unless the agent
 *                   calls store_memory / forget_memory itself. Simulated
 *                   per-turn: the model sees the exchange plus its current
 *                   notebook and emits REMEMBER/FORGET ops.
 *   per-turn      — qm's default: after every exchange an extractor model
 *                   pulls facts into the notebook (append + dedup, no
 *                   curation).
 *   consolidated  — per-turn plus one consolidation pass at the end
 *                   (UPDATE/DELETE/ADD over the numbered notebook).
 *
 * Everything in THIS module is pure (parsers, folding, scoring, rendering) so
 * it unit-tests without a model; the runner script owns the model calls.
 */

export interface BenchConversation {
  id: string;
  description: string;
  turns: Array<{ input: string; reply: string }>;
}

export interface JudgeVerdict {
  signalToNoise: number;
  staleness: number;
  inferenceVsObservation: number;
  notes: string;
}

export interface BenchResult {
  strategy: string;
  conversationId: string;
  notebook: string;
  verdict: JudgeVerdict;
}

export interface BenchSummaryRow {
  strategy: string;
  conversations: number;
  signalToNoise: number;
  staleness: number;
  inferenceVsObservation: number;
  overall: number;
}

/** A strategy is a fold over turns; the runner owns the model calls. */
export type OneShot = (
  system: string,
  prompt: string,
) => Promise<string | null>;

export function parseBenchConversation(
  raw: unknown,
  source: string,
): BenchConversation {
  const o = raw as Partial<BenchConversation> | null;
  if (
    !o ||
    typeof o.id !== "string" ||
    typeof o.description !== "string" ||
    !Array.isArray(o.turns)
  ) {
    throw new Error(`malformed bench conversation in ${source}`);
  }
  for (const t of o.turns) {
    if (typeof t?.input !== "string" || typeof t?.reply !== "string") {
      throw new Error(`malformed turn in ${source} (${o.id})`);
    }
  }
  return { id: o.id, description: o.description, turns: o.turns };
}

// ── Notebook: an ordered list of fact strings ────────────────────────────────

function normalizeFact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function factKey(text: string): string {
  return normalizeFact(text).toLowerCase();
}

/** Append new facts, dropping empties and (case-insensitive) duplicates. */
export function foldFacts(notebook: string[], facts: string[]): string[] {
  const seen = new Set(notebook.map(factKey));
  const out = [...notebook];
  for (const raw of facts) {
    const fact = normalizeFact(raw).replace(/^[-*]\s+/, "");
    const key = factKey(fact);
    if (!fact || seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out;
}

export function renderNotebook(notebook: string[]): string {
  return notebook.map((f) => `- ${f}`).join("\n");
}

// ── Extraction (qm's per-turn strategy prompt) ───────────────────────────────

export const MEMORY_EXTRACTION_PROMPT = [
  "You extract durable facts worth remembering about the user across FUTURE conversations.",
  "Given one or more consecutive exchanges (user message + assistant reply), output ONLY a markdown bullet list",
  "(`- fact`), one concise standalone fact per line, written in the third person",
  "(e.g. `- Prefers terse replies`, `- Owns the billing service`, `- Working on the Q3 launch`).",
  "Include preferences, identifiers, ongoing projects, and how they like to work.",
  "PROVENANCE: a preference, intent, or instruction is a valid fact ONLY when the user's own",
  "message in these exchanges states it. Never derive one from the assistant's reply — an",
  'assistant saying "per X\'s preference" or describing its own strategy ("queued silently to',
  'avoid spam") is NOT evidence that anyone holds that preference. Likewise EXCLUDE second-hand',
  "claims about a person who did not speak in these exchanges.",
  "EXCLUDE secrets/credentials, one-off trivia, and anything already obvious.",
  "EXCLUDE system mechanics you can look up when needed: API endpoints/headers, credential or",
  "broker plumbing, state-file paths, tool invocation details, schemas. For a standing system",
  "the user relies on (a cron, a watcher, an integration), record its EXISTENCE and purpose as",
  'one fact — not its internals. A user-stated convention ("always via the broker, never raw',
  'tokens") is a preference and belongs in memory; how the broker works does not.',
  "If nothing is worth remembering, output exactly: NONE",
].join("\n");

export function parseFacts(out: string): string[] {
  const trimmed = out.trim();
  if (!trimmed || /^none$/i.test(trimmed)) return [];
  return trimmed
    .split("\n")
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);
}

// ── Agent-only simulation (what we ship today) ───────────────────────────────

/**
 * Approximates a live session's store_memory/forget_memory behavior (the
 * memory-tools.ts wording) as a per-turn decision over a numbered notebook.
 * An approximation — a real session decides mid-reply with full context —
 * but it preserves the property that matters for the comparison: nothing is
 * saved unless the agent decides to save it, and stale facts persist unless
 * the agent actively forgets them.
 */
export const AGENT_CURATOR_PROMPT = [
  "You are an assistant with a durable memory across sessions, deciding — during a live",
  "conversation — what to store. You see your current memory notebook (numbered) and the",
  "latest exchange. Store only durable, non-obvious facts — never conversation state, never",
  "things already recorded. When a stored fact is contradicted by newer information, forget it",
  "(and store the replacement if durable).",
  "Output ONLY actions, one per line, in these exact forms:",
  "REMEMBER: <fact — one self-contained sentence or two>",
  "FORGET <n>",
  "If nothing should change, output exactly: NONE",
].join("\n");

export type CuratorAction =
  | { kind: "remember"; text: string }
  | { kind: "forget"; index: number };

export function parseCuratorActions(out: string): CuratorAction[] {
  const actions: CuratorAction[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line || /^none$/i.test(line)) continue;
    let m = /^REMEMBER\s*:\s*(.+)$/i.exec(line);
    if (m) {
      actions.push({ kind: "remember", text: m[1]!.trim() });
      continue;
    }
    m = /^FORGET\s+(\d+)\s*$/i.exec(line);
    if (m) actions.push({ kind: "forget", index: Number(m[1]) });
  }
  return actions;
}

export function applyCuratorActions(
  notebook: string[],
  actions: CuratorAction[],
): string[] {
  const drop = new Set(
    actions
      .filter((a) => a.kind === "forget")
      .map((a) => (a as { index: number }).index),
  );
  const kept = notebook.filter((_, i) => !drop.has(i + 1));
  return foldFacts(
    kept,
    actions.flatMap((a) => (a.kind === "remember" ? [a.text] : [])),
  );
}

// ── Consolidation (qm's maintenance pass) ────────────────────────────────────

export const MEMORY_CONSOLIDATION_PROMPT = [
  "You consolidate an agent's long-term memory notebook. The input is a numbered list",
  "of remembered facts.",
  "Output ONLY actions, one per line, in these exact forms:",
  "UPDATE <n>: <revised fact>",
  "DELETE <n>",
  "ADD: <new fact>",
  "If nothing needs changing, output exactly: NONE",
  "",
  "Rules:",
  "- Prefer UPDATE over DELETE+ADD when a fact has evolved or two facts should merge",
  "  (UPDATE one, DELETE the other).",
  "- Keep facts atomic: one standalone fact per line. Split a compound fact with an",
  "  UPDATE plus ADDs.",
  "- DELETE facts that are stale, contradicted by newer facts, exact or near",
  "  duplicates, or trivially derivable from other facts.",
  "- DELETE pure system mechanics that can be looked up when needed (API endpoints/headers,",
  "  credential/broker plumbing, state-file paths, tool invocation details) — but KEEP",
  "  user-stated conventions about them, and keep one existence-level fact for a standing",
  "  system the user relies on (a cron, a watcher, an integration).",
  "- NEVER delete or weaken a fact the user explicitly asked to remember.",
  "- Do not reword facts that are already fine. When in doubt, leave a fact alone.",
].join("\n");

export type ConsolidationAction =
  | { kind: "update"; index: number; text: string }
  | { kind: "delete"; index: number }
  | { kind: "add"; text: string };

export function parseConsolidationActions(out: string): ConsolidationAction[] {
  const actions: ConsolidationAction[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line || /^none$/i.test(line)) continue;
    let m = /^UPDATE\s+(\d+)\s*:\s*(.+)$/i.exec(line);
    if (m) {
      actions.push({ kind: "update", index: Number(m[1]), text: m[2]!.trim() });
      continue;
    }
    m = /^DELETE\s+(\d+)\s*$/i.exec(line);
    if (m) {
      actions.push({ kind: "delete", index: Number(m[1]) });
      continue;
    }
    m = /^ADD\s*:\s*(.+)$/i.exec(line);
    if (m) actions.push({ kind: "add", text: m[1]!.trim() });
  }
  return actions;
}

export function applyConsolidationActions(
  notebook: string[],
  actions: ConsolidationAction[],
): string[] {
  const updates = new Map<number, string>();
  const deletes = new Set<number>();
  const adds: string[] = [];
  for (const a of actions) {
    if (a.kind === "update") updates.set(a.index, a.text);
    else if (a.kind === "delete") deletes.add(a.index);
    else adds.push(a.text);
  }
  const out: string[] = [];
  notebook.forEach((fact, i) => {
    const n = i + 1;
    if (deletes.has(n)) return;
    out.push(updates.get(n) ?? fact);
  });
  return foldFacts(out, adds);
}

export function numberedNotebook(notebook: string[]): string {
  return notebook.map((f, i) => `${i + 1}. ${f}`).join("\n");
}

// ── Strategies (folds over turns; oneShot injected by the runner) ────────────

export interface BenchStrategy {
  name: string;
  run(conversation: BenchConversation, oneShot: OneShot): Promise<string[]>;
}

export const BENCH_STRATEGIES: BenchStrategy[] = [
  {
    name: "agent-only",
    async run(conversation, oneShot) {
      let notebook: string[] = [];
      for (const turn of conversation.turns) {
        const prompt = [
          "Current memory notebook:",
          notebook.length ? numberedNotebook(notebook) : "(empty)",
          "",
          `User said:\n${turn.input}`,
          "",
          `You replied:\n${turn.reply}`,
        ].join("\n");
        const out = await oneShot(AGENT_CURATOR_PROMPT, prompt);
        notebook = applyCuratorActions(
          notebook,
          parseCuratorActions(out ?? ""),
        );
      }
      return notebook;
    },
  },
  {
    name: "per-turn",
    async run(conversation, oneShot) {
      let notebook: string[] = [];
      for (const turn of conversation.turns) {
        const transcript = `User said:\n${turn.input}\n\nAssistant replied:\n${turn.reply}`;
        const out = await oneShot(MEMORY_EXTRACTION_PROMPT, transcript);
        notebook = foldFacts(notebook, parseFacts(out ?? ""));
      }
      return notebook;
    },
  },
  {
    name: "consolidated",
    async run(conversation, oneShot) {
      let notebook: string[] = [];
      for (const turn of conversation.turns) {
        const transcript = `User said:\n${turn.input}\n\nAssistant replied:\n${turn.reply}`;
        const out = await oneShot(MEMORY_EXTRACTION_PROMPT, transcript);
        notebook = foldFacts(notebook, parseFacts(out ?? ""));
      }
      if (notebook.length) {
        const out = await oneShot(
          MEMORY_CONSOLIDATION_PROMPT,
          numberedNotebook(notebook),
        );
        notebook = applyConsolidationActions(
          notebook,
          parseConsolidationActions(out ?? ""),
        );
      }
      return notebook;
    },
  },
];

// ── Judge ────────────────────────────────────────────────────────────────────

export const JUDGE_PROMPT = [
  "You judge the quality of an agent's long-term memory notebook produced from a conversation.",
  "You are given the full conversation (user/assistant turns) and the notebook the memory",
  "strategy wrote. Score the NOTEBOOK on three axes, each an integer 0-10 (10 = best):",
  "- signalToNoise: durable, reusable facts (preferences, identifiers, ongoing projects)",
  "  vs one-off trivia, filler, duplicates, or secrets that should never be stored.",
  "- staleness: when a fact changed during the conversation, does the notebook reflect",
  "  the LATEST state (or clearly supersede the old one) rather than the stale version?",
  "- inferenceVsObservation: entries are things actually stated or observed, not the",
  "  model's speculation dressed up as fact.",
  "An EMPTY notebook is not automatically bad: score signalToNoise low only if the",
  "conversation clearly contained durable facts worth keeping.",
  'Reply with ONLY a JSON object: {"signalToNoise": n, "staleness": n,',
  '"inferenceVsObservation": n, "notes": "<one or two sentences>"}',
].join("\n");

export function renderJudgeInput(
  conversation: BenchConversation,
  notebook: string,
): string {
  const transcript = conversation.turns
    .map((t) => `USER: ${t.input}\nASSISTANT: ${t.reply}`)
    .join("\n\n");
  return [
    `Conversation (${conversation.id}: ${conversation.description}):`,
    transcript,
    "",
    "Notebook produced by the memory strategy:",
    notebook.trim() ? notebook : "(empty)",
  ].join("\n");
}

function clampScore(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.min(10, Math.max(0, Math.round(v)));
}

export function parseJudgeVerdict(out: string): JudgeVerdict {
  const match = /\{[\s\S]*\}/.exec(out);
  if (!match)
    throw new Error(`judge output had no JSON object: ${out.slice(0, 200)}`);
  const o = JSON.parse(match[0]) as Partial<JudgeVerdict>;
  return {
    signalToNoise: clampScore(o.signalToNoise),
    staleness: clampScore(o.staleness),
    inferenceVsObservation: clampScore(o.inferenceVsObservation),
    notes: typeof o.notes === "string" ? o.notes : "",
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function summarize(results: BenchResult[]): BenchSummaryRow[] {
  const byStrategy = new Map<string, BenchResult[]>();
  for (const r of results) {
    const list = byStrategy.get(r.strategy) ?? [];
    list.push(r);
    byStrategy.set(r.strategy, list);
  }
  const rows: BenchSummaryRow[] = [];
  for (const [strategy, list] of byStrategy) {
    const avg = (pick: (v: JudgeVerdict) => number) =>
      Math.round(
        (list.reduce((s, r) => s + pick(r.verdict), 0) / list.length) * 10,
      ) / 10;
    const signalToNoise = avg((v) => v.signalToNoise);
    const staleness = avg((v) => v.staleness);
    const inferenceVsObservation = avg((v) => v.inferenceVsObservation);
    rows.push({
      strategy,
      conversations: list.length,
      signalToNoise,
      staleness,
      inferenceVsObservation,
      overall:
        Math.round(
          ((signalToNoise + staleness + inferenceVsObservation) / 3) * 10,
        ) / 10,
    });
  }
  return rows.sort((a, b) => b.overall - a.overall);
}

export function formatTable(rows: BenchSummaryRow[]): string {
  const header = [
    "strategy",
    "convs",
    "signal/noise",
    "staleness",
    "infer-vs-obs",
    "overall",
  ];
  const data = rows.map((r) => [
    r.strategy,
    String(r.conversations),
    r.signalToNoise.toFixed(1),
    r.staleness.toFixed(1),
    r.inferenceVsObservation.toFixed(1),
    r.overall.toFixed(1),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i]!.length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...data.map(line),
  ].join("\n");
}
