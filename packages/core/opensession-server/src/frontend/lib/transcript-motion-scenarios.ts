import { stripBasePath } from "./base";
import type { TranscriptIndexEntry } from "@tellahq/opensession-protocol/session";
import type { TranscriptEntry } from "./types";
import type { OptimisticTranscriptEntry } from "./transcript-state";
import {
  makeSessionFixture,
  makeStreamDeltas,
} from "./session-performance-fixtures";

export type TranscriptMotionScenarioState = {
  entries: TranscriptEntry[];
  optimisticEntries: OptimisticTranscriptEntry[];
  transcriptIndex?: TranscriptIndexEntry[];
  busy: boolean;
};

export type TranscriptMotionScenarioEvent =
  | { atMs: number; kind: "begin-turn"; entry: OptimisticTranscriptEntry }
  | { atMs: number; kind: "reconcile-turn"; entry: TranscriptEntry }
  | { atMs: number; kind: "append-entry"; entry: TranscriptEntry }
  | { atMs: number; kind: "hydrate-entries"; entries: TranscriptEntry[] }
  | {
      atMs: number;
      kind: "update-entry";
      id: string;
      content: string;
      changeSeq: number;
    }
  | { atMs: number; kind: "set-busy"; busy: boolean }
  | { atMs: number; kind: "stream-start" }
  | { atMs: number; kind: "stream-append"; text: string; blockId: string }
  | { atMs: number; kind: "stream-land"; id: string; content: string }
  | { atMs: number; kind: "stream-finish" };

type WithoutAt<T> = T extends unknown ? Omit<T, "atMs"> : never;

export type TranscriptMotionScenario = {
  seed: number;
  initial: TranscriptMotionScenarioState;
  events: TranscriptMotionScenarioEvent[];
  durationMs: number;
};

const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");

function timestamp(sequence: number): string {
  return new Date(BASE_TIME + sequence * 1_000).toISOString();
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0 || 1;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0x1_0000_0000;
  };
}

function initialEntries(seed: number): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (let turn = 0; turn < 6; turn++) {
    entries.push({
      id: `seed-${seed}-history-${turn}-user`,
      type: "user",
      content: `Fixture request ${turn + 1}: keep this transcript stable while it changes.`,
      timestamp: timestamp(turn * 2),
      seq: turn * 2 + 1,
      changeSeq: turn * 2 + 1,
    });
    entries.push({
      id: `seed-${seed}-history-${turn}-assistant`,
      type: "assistant",
      content:
        turn % 2 === 0
          ? `Fixture response ${turn + 1}.\n\n\`\`\`ts\nconst stable = ${turn + 1};\n\`\`\``
          : `Fixture response ${turn + 1} with a wrapped path: packages/core/opensession-server/src/frontend/components/TranscriptBlocks.tsx.`,
      timestamp: timestamp(turn * 2 + 1),
      seq: turn * 2 + 2,
      changeSeq: turn * 2 + 2,
    });
  }
  return entries;
}

function growingResult(label: string, lines: number): string {
  return Array.from(
    { length: lines },
    (_, index) =>
      `${label} ${index + 1}: ${"measured output ".repeat((index % 3) + 1)}`,
  ).join("\n");
}

export function makeTranscriptMotionScenario(
  rawSeed: number,
): TranscriptMotionScenario {
  const seed = Number.isFinite(rawSeed) ? Math.max(1, Math.floor(rawSeed)) : 1;
  const random = seededRandom(seed);
  const entries = initialEntries(seed);
  const events: TranscriptMotionScenarioEvent[] = [];
  let atMs = 120;
  let sequence = entries.length + 1;
  const nextDelay = (minimum: number, spread: number) =>
    minimum + Math.floor(random() * spread);
  const push = (
    event: WithoutAt<TranscriptMotionScenarioEvent>,
    delay = nextDelay(35, 100),
  ) => {
    atMs += delay;
    events.push({ ...event, atMs } as TranscriptMotionScenarioEvent);
  };

  const optimisticId = `seed-${seed}-optimistic`;
  const prompt = `Fuzz turn ${seed}: run several tools, stream an answer, and preserve the reader’s place.`;
  push(
    {
      kind: "begin-turn",
      entry: {
        id: optimisticId,
        type: "user",
        content: prompt,
        timestamp: timestamp(sequence++),
        optimisticAfterEntryId: entries.at(-1)?.id ?? null,
      },
    },
    40,
  );
  push({ kind: "set-busy", busy: true }, 20);
  push(
    {
      kind: "reconcile-turn",
      entry: {
        id: `seed-${seed}-prompt`,
        type: "user",
        content: prompt,
        timestamp: timestamp(sequence++),
        seq: sequence,
        changeSeq: sequence,
        sourceMessageIds: [optimisticId],
      },
    },
    nextDelay(25, 80),
  );
  push({ kind: "stream-start" }, nextDelay(20, 80));
  const streamedParts = [
    "I’ll exercise several changing transcript shapes before settling.",
  ];
  push(
    {
      kind: "stream-append",
      text: streamedParts[0] ?? "",
      blockId: `seed-${seed}-stream-intro`,
    },
    nextDelay(20, 80),
  );

  const toolCount = 2 + Math.floor(random() * 5);
  for (let tool = 0; tool < toolCount; tool++) {
    const toolUseId = `seed-${seed}-tool-${tool}`;
    const resultId = `seed-${seed}-result-${tool}`;
    const label = tool % 2 === 0 ? "bash" : "read";
    push({
      kind: "append-entry",
      entry: {
        id: `seed-${seed}-narration-${tool}`,
        type: "assistant",
        content: `Checking deterministic case ${tool + 1}.`,
        timestamp: timestamp(sequence++),
        seq: sequence,
        changeSeq: sequence,
        isReasoning: tool % 3 === 0,
      },
    });
    push({
      kind: "append-entry",
      entry: {
        id: toolUseId,
        type: "tool_use",
        content: `Using ${label}`,
        toolName: label,
        toolUseId,
        toolInput:
          label === "bash"
            ? { command: `printf fixture-${seed}-${tool}` }
            : { file_path: `src/fixture-${seed}-${tool}.ts` },
        timestamp: timestamp(sequence++),
        seq: sequence,
        changeSeq: sequence,
      },
    });
    push({
      kind: "append-entry",
      entry: {
        id: resultId,
        type: "tool_result",
        content: growingResult(`fixture-${seed}-${tool}`, 1),
        toolUseId,
        timestamp: timestamp(sequence++),
        seq: sequence,
        changeSeq: 1,
      },
    });
    const revisions = 1 + Math.floor(random() * 4);
    for (let revision = 2; revision <= revisions + 1; revision++) {
      push(
        {
          kind: "update-entry",
          id: resultId,
          content: growingResult(`fixture-${seed}-${tool}`, revision * 2),
          changeSeq: revision,
        },
        nextDelay(16, 150),
      );
    }
    if (tool % 2 === 0) {
      const update = `\n\nTool ${tool + 1} has settled without replacing the live bubble.`;
      streamedParts.push(update);
      push(
        {
          kind: "stream-append",
          text: update,
          blockId: `seed-${seed}-stream-${tool}`,
        },
        nextDelay(16, 100),
      );
    }
  }

  const answerId = `seed-${seed}-answer`;
  const completion = `\n\nScenario ${seed} completed ${toolCount} tool steps. The durable answer replaces the live tail without a jump.`;
  streamedParts.push(completion);
  push(
    {
      kind: "stream-append",
      text: completion,
      blockId: `seed-${seed}-stream-final`,
    },
    nextDelay(16, 100),
  );
  const answer = streamedParts.join("");
  push(
    {
      kind: "append-entry",
      entry: {
        id: answerId,
        type: "assistant",
        content: answer,
        timestamp: timestamp(sequence++),
        seq: sequence,
        changeSeq: sequence,
      },
    },
    nextDelay(30, 120),
  );
  push({ kind: "stream-land", id: answerId, content: answer }, 10);
  push({ kind: "stream-finish" }, 20);
  push({ kind: "set-busy", busy: false }, nextDelay(20, 90));

  return {
    seed,
    initial: { entries, optimisticEntries: [], busy: false },
    events,
    durationMs: atMs,
  };
}

export const HYDRATION_TALL_TURN = 9;

/** Grow a loaded entry by a few measured lines, bumping its change sequence
 * the way a late revision would. Unloaded or unknown entries are unchanged. */
export function growTranscriptMotionEntry(
  state: TranscriptMotionScenarioState,
  entryId: string,
): TranscriptMotionScenarioState {
  const entry = state.entries.find((candidate) => candidate.id === entryId);
  if (!entry) return state;
  const changeSeq = (entry.changeSeq ?? entry.seq ?? 0) + 1;
  return applyTranscriptMotionEvent(state, {
    atMs: 0,
    kind: "update-entry",
    id: entryId,
    content: `${entry.content}\n${growingResult(`growth-${changeSeq}`, 8)}`,
    changeSeq,
  });
}

export function makeTranscriptHydrationScenario(): TranscriptMotionScenario {
  const allEntries: TranscriptEntry[] = [];
  for (let turn = 0; turn < 18; turn++) {
    const userSeq = turn * 2 + 1;
    const assistantSeq = userSeq + 1;
    allEntries.push(
      {
        id: `hydration-user-${turn}`,
        type: "user",
        content: `Incremental request ${turn + 1}`,
        timestamp: timestamp(userSeq),
        seq: userSeq,
        changeSeq: userSeq,
      },
      {
        id: `hydration-assistant-${turn}`,
        type: "assistant",
        // One reply taller than a phone viewport: its first measurement
        // misses the estimate by a screen, the shape behind residual jumps
        // after a keyed prepend.
        content: growingResult(
          `incremental-${turn + 1}`,
          turn === HYDRATION_TALL_TURN ? 60 : 3 + (turn % 5) * 3,
        ),
        timestamp: timestamp(assistantSeq),
        seq: assistantSeq,
        changeSeq: assistantSeq,
      },
    );
  }
  const transcriptIndex: TranscriptIndexEntry[] = allEntries.map((entry) => ({
    id: entry.id,
    seq: entry.seq ?? 0,
    changeSeq: entry.changeSeq ?? entry.seq ?? 0,
    timestampMs: Date.parse(entry.timestamp),
    role: entry.type === "user" ? "user" : "assistant",
    contentLength: entry.content.length,
  }));
  const initial = allEntries.slice(-5);
  const events: TranscriptMotionScenarioEvent[] = [];
  // First complete the partial opening range by inserting its missing user at
  // the start of the existing keyed row. Later steps prepend whole keyed rows.
  const openingPrefix = allEntries[allEntries.length - 6];
  if (!openingPrefix)
    throw new Error("hydration fixture has no opening prefix");
  events.push({
    atMs: 1,
    kind: "hydrate-entries",
    entries: [openingPrefix],
  });
  for (let end = allEntries.length - 6; end > 0; end -= 4) {
    events.push({
      atMs: events.length + 1,
      kind: "hydrate-entries",
      entries: allEntries.slice(Math.max(0, end - 4), end),
    });
  }
  const tail = allEntries.at(-1);
  if (!tail) throw new Error("hydration fixture has no tail");
  events.push({
    atMs: events.length + 1,
    kind: "update-entry",
    id: tail.id,
    content: `${tail.content}\n${growingResult("late-tail-growth", 24)}`,
    changeSeq: (tail.changeSeq ?? 0) + 1,
  });
  return {
    seed: 0,
    initial: {
      entries: initial,
      optimisticEntries: [],
      transcriptIndex,
      busy: false,
    },
    events,
    durationMs: events.length,
  };
}

export function makeTranscriptStreamPerformanceScenario(): TranscriptMotionScenario {
  const entries = makeSessionFixture(10_000);
  const deltas = makeStreamDeltas(100, 1);
  return {
    seed: 0,
    initial: { entries, optimisticEntries: [], busy: true },
    events: [
      { atMs: 50, kind: "stream-start" },
      ...deltas.map((delta): TranscriptMotionScenarioEvent => ({
        atMs: 100 + delta.atMs,
        kind: "stream-append",
        text: delta.text,
        blockId: "stream-performance-block",
      })),
      { atMs: 1_100, kind: "stream-finish" },
    ],
    durationMs: 1_100,
  };
}

export function applyTranscriptMotionEvent(
  state: TranscriptMotionScenarioState,
  event: TranscriptMotionScenarioEvent,
): TranscriptMotionScenarioState {
  switch (event.kind) {
    case "begin-turn":
      return {
        ...state,
        optimisticEntries: [...state.optimisticEntries, event.entry],
      };
    case "reconcile-turn":
      return {
        ...state,
        entries: [...state.entries, event.entry],
        optimisticEntries: state.optimisticEntries.filter(
          (entry) => !event.entry.sourceMessageIds?.includes(entry.id),
        ),
      };
    case "append-entry":
      return { ...state, entries: [...state.entries, event.entry] };
    case "hydrate-entries": {
      const byId = new Map(state.entries.map((entry) => [entry.id, entry]));
      for (const entry of event.entries) byId.set(entry.id, entry);
      return {
        ...state,
        entries: [...byId.values()].sort(
          (left, right) => (left.seq ?? 0) - (right.seq ?? 0),
        ),
      };
    }
    case "update-entry":
      return {
        ...state,
        entries: state.entries.map((entry) =>
          entry.id === event.id
            ? { ...entry, content: event.content, changeSeq: event.changeSeq }
            : entry,
        ),
      };
    case "set-busy":
      return { ...state, busy: event.busy };
    case "stream-start":
    case "stream-append":
    case "stream-land":
    case "stream-finish":
      return state;
  }
}

export function transcriptMotionFixtureOptions(
  pathname: string,
  search: string,
): {
  seed: number;
  speed: number;
  profile: "motion" | "stream" | "hydration";
} | null {
  if (stripBasePath(pathname) !== "/__fixtures/transcript-motion") return null;
  const params = new URLSearchParams(search);
  const seed = Number(params.get("seed") ?? 1);
  const speed = Number(params.get("speed") ?? 1);
  return {
    seed: Number.isFinite(seed) ? Math.max(1, Math.floor(seed)) : 1,
    speed: Number.isFinite(speed) ? Math.min(20, Math.max(0.1, speed)) : 1,
    profile:
      params.get("profile") === "stream"
        ? "stream"
        : params.get("profile") === "hydration"
          ? "hydration"
          : "motion",
  };
}
