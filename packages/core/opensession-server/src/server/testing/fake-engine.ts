/**
 * Deterministic fake engine for token-free tests.
 *
 * Implements the INNER engine contract that `runOnModel` dispatches to (see
 * agent-runner.ts `EngineRunner`): emit `init` → text/tool events → exactly
 * one terminal `done`/`error`, then return. Installed via
 * `__setEngineForTest(fake.engine)` so the whole consumer stack — runAgent's
 * fallback walk, runSessionPrompt's event loop, queue drain, run-state
 * transitions — runs for real with zero model spend and no live engine.
 *
 * Each engine invocation consumes the next scripted turn; running past the
 * script yields a loud terminal error rather than hanging or silently
 * succeeding. Calls are recorded on `calls` for assertions.
 *
 * Journal fidelity: like the real runPi, a turn with
 * `opts.journal.osSessionId` registers in the run journal for its duration
 * (journalSet → run_registered → journalClear), so FSM/busy/journal consumers
 * see the same lifecycle a real run produces. Point the journal at a temp file
 * first (`__setActiveRunsPathForTest`) in tests that use this.
 *
 * Transcript fidelity (`persistTranscript`): writing the turn's assistant text
 * and tool calls into the owned transcript store is the ENGINE ADAPTER's job,
 * not run-session's; the consumer loop only broadcasts those events. So a
 * fake engine that doesn't write leaves a session whose transcript is just its
 * user lines. With the option on, the fake persists through the same
 * production path the pi adapter uses (recordEngineSessionOwner +
 * transcriptLine* builders + appendTranscriptEntries), which is what lets the
 * snapshot harness assert real stored entries. Redirect the store and the
 * engine→unified map at temp paths first.
 */
import type { EngineRunner, RunAgentOpts } from "../agent-runner";
import type { StreamEvent, TurnUsage } from "../run-events";
import { journalClear, journalSet } from "../run-journal";
import {
  appendTranscriptEntries,
  recordEngineSessionOwner,
  transcriptLineAssistantText,
  transcriptLineToolResult,
  transcriptLineToolUse,
} from "../transcript-persistence";

/** Which backend a scripted turn claims to be: the `provider` on its
 *  init/done events, which is what a session records as its last engine. */
export type FakeProvider = "claude" | "codex" | "pi";

export type FakeTurn =
  | {
      kind: "clean";
      /** init.sessionId — defaults to a stable per-call fake id. */
      engineSessionId?: string;
      /** init/done `provider`: what engine the session records as its last.
       *  Defaults to "pi"; set it to model a run on another engine
       *  (a cross-engine handoff needs the two turns to disagree). */
      provider?: FakeProvider;
      /** One text_chunk per element. */
      text?: string[];
      tools?: Array<{
        name: string;
        input?: Record<string, unknown>;
        result?: string;
      }>;
      usage?: Partial<TurnUsage>;
      /** Awaited before the terminal done — lets a test hold the turn open
       *  (session busy) while it enqueues follow-ups or asserts mid-run state. */
      gate?: Promise<void>;
    }
  | {
      kind: "error";
      content: string;
      usageLimitExhausted?: boolean;
      /** Skip the init event — models a failure before the engine session
       *  exists (e.g. account pool dry at pick time). */
      noInit?: boolean;
      engineSessionId?: string;
      provider?: FakeProvider;
    }
  | {
      /** A `done` with usageLimitExhausted:true — what a pool-drained clean
       *  stop looks like; drives runAgent's fallback walk. */
      kind: "usage_exhausted";
      engineSessionId?: string;
      provider?: FakeProvider;
    }
  | {
      /** Fully scripted event list, yielded verbatim. */
      kind: "events";
      events: StreamEvent[];
    };

export interface FakeCall {
  prompt: string;
  model: string;
  sessionId?: string;
  journalKind?: string;
  firstJournaledAt?: string;
  seedEntries?: number;
  /** Everything the pipeline handed the engine for this invocation: the
   *  adapter seam the snapshot harness records (system/context payloads, MCP
   *  scope, tool denials, repos+memory note). Held by reference; runAgent
   *  builds a fresh opts object per attempt, so it is never mutated after. */
  opts: RunAgentOpts;
}

export interface FakeEngine {
  engine: EngineRunner;
  /** One entry per engine invocation, in order. */
  calls: FakeCall[];
}

export interface FakeEngineOptions {
  /** Persist the scripted assistant text and tool calls into the owned
   *  transcript store, the way a real engine adapter does. See the header. */
  persistTranscript?: boolean;
}

const DEFAULT_USAGE: TurnUsage = {
  costUsd: 0,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  contextTokens: 150,
};

/** Entry ids the persisted lines carry must be unique across every fake turn
 *  in the process, not per fake engine: two turns of one scenario are two
 *  makeFakeEngine instances, and the store upserts by (session, uuid), so reusing
 *  `fake-text-1-1` made turn two silently REWRITE turn one's row in place. The
 *  ids never appear in a snapshot (transcriptEntryView drops them), so a
 *  process-wide counter costs nothing in fixture stability. */
let fakeEntrySeq = 0;

export function makeFakeEngine(
  turns: FakeTurn[],
  options: FakeEngineOptions = {},
): FakeEngine {
  const calls: FakeCall[] = [];

  async function* engine(
    opts: RunAgentOpts,
    model: string,
  ): AsyncGenerator<StreamEvent> {
    const callIndex = calls.length;
    calls.push({
      prompt: opts.prompt,
      model,
      sessionId: opts.sessionId,
      journalKind: opts.journal?.kind,
      firstJournaledAt: opts.journal?.firstJournaledAt,
      seedEntries: opts.seedTranscriptEntries?.length,
      opts,
    });
    const turn = turns[callIndex];
    if (!turn) {
      yield {
        type: "error",
        content: `fake engine script exhausted (call ${callIndex + 1} of ${turns.length})`,
      };
      return;
    }
    if (turn.kind === "events") {
      yield* turn.events;
      return;
    }

    const engineSessionId =
      turn.engineSessionId || opts.sessionId || `fake-ses-${callIndex + 1}`;
    const provider = turn.provider || "pi";
    const bks = opts.journal?.osSessionId;
    // Like a real adapter, claim the engine→unified mapping BEFORE the first
    // event: every later store write resolves the owning session through it.
    const unifiedId = bks || opts.transcriptSessionId;
    if (options.persistTranscript && unifiedId)
      recordEngineSessionOwner(engineSessionId, unifiedId);
    const runKey = bks ? opts.startToken || `fake-${bks}` : null;
    if (runKey) {
      await journalSet({
        runKey,
        osSessionId: bks,
        claudeSessionId: engineSessionId,
        cwd: opts.cwd,
        kind: opts.journal?.kind,
        model,
        selectedModel: opts.selectedModel,
        transientFallback: opts.transientFallback,
        startedAt: new Date().toISOString(),
      });
    }
    try {
      if (turn.kind === "error") {
        if (!turn.noInit) {
          yield { type: "init", sessionId: engineSessionId, provider, model };
        }
        yield {
          type: "error",
          content: turn.content,
          usageLimitExhausted: turn.usageLimitExhausted,
        };
        return;
      }

      yield { type: "init", sessionId: engineSessionId, provider, model };
      if (turn.kind === "usage_exhausted") {
        yield {
          type: "done",
          sessionId: engineSessionId,
          provider,
          model,
          usage: DEFAULT_USAGE,
          usageLimitExhausted: true,
        };
        return;
      }

      for (const text of turn.text ?? []) {
        yield { type: "text_chunk", text };
        if (options.persistTranscript)
          await appendTranscriptEntries(engineSessionId, [
            transcriptLineAssistantText(
              text,
              `fake-text-${++fakeEntrySeq}`,
              undefined,
              model,
            ),
          ]);
      }
      for (const tool of turn.tools ?? []) {
        const toolUseId = `fake-tool-${++fakeEntrySeq}`;
        yield {
          type: "tool_use",
          toolName: tool.name,
          toolInput: tool.input ?? {},
          toolUseId,
        };
        yield {
          type: "tool_result",
          content: tool.result ?? "(ok)",
          toolUseId,
        };
        if (options.persistTranscript)
          await appendTranscriptEntries(engineSessionId, [
            transcriptLineToolUse(toolUseId, tool.name, tool.input ?? {}),
            transcriptLineToolResult(toolUseId, tool.result ?? "(ok)"),
          ]);
      }
      if (turn.gate) await turn.gate;
      yield {
        type: "done",
        sessionId: engineSessionId,
        provider,
        model,
        usage: { ...DEFAULT_USAGE, ...turn.usage },
      };
    } finally {
      if (runKey) journalClear(runKey);
    }
  }

  return { engine, calls };
}
