/**
 * Synthetic engine for control-plane load runs.
 *
 * Stands in for Pi on every turn so an isolated instance can drive thousands
 * of sessions through the real consumer stack (run-session's event loop, the
 * run journal, transcript persistence, WebSocket fan-out, list rows) with no
 * model spend and no external process. Each turn emits `init`, a paced run
 * of text chunks, a few tool call/result pairs and one `done`, persisting the
 * assistant lines the way a real adapter does, so the store sees production
 * write patterns.
 *
 * Dev only. `agent-runner` dispatches here when both are set:
 *   OPENSESSION_DEV=1  OPENSESSION_SYNTHETIC_ENGINE=1
 * Tunables (per turn): OPENSESSION_SYNTHETIC_CHUNKS (default 40),
 * OPENSESSION_SYNTHETIC_TOOLS (default 4), OPENSESSION_SYNTHETIC_CHUNK_MS
 * (default 25). See scripts/load-control-plane.ts, the harness that uses it.
 */
import type { RunAgentOpts } from "../agent-runner";
import type { StreamEvent, TurnUsage } from "../run-events";
import { journalClear, journalSet } from "../run-journal";
import {
  appendTranscriptEntries,
  recordEngineSessionOwner,
  transcriptLineAssistantText,
  transcriptLineToolResult,
  transcriptLineToolUse,
} from "../transcript-persistence";

export function syntheticEngineRequested(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.OPENSESSION_SYNTHETIC_ENGINE === "1" && env.OPENSESSION_DEV === "1"
  );
}

function tunable(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const USAGE: TurnUsage = {
  costUsd: 0,
  inputTokens: 1_200,
  outputTokens: 300,
  cacheReadTokens: 900,
  cacheCreationTokens: 0,
  contextTokens: 1_500,
};

let entrySeq = 0;
const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : undefined;

export async function* syntheticEngine(
  opts: RunAgentOpts,
  model: string,
): AsyncGenerator<StreamEvent> {
  const chunks = tunable("OPENSESSION_SYNTHETIC_CHUNKS", 40);
  const tools = tunable("OPENSESSION_SYNTHETIC_TOOLS", 4);
  const chunkMs = tunable("OPENSESSION_SYNTHETIC_CHUNK_MS", 25);
  const provider = "pi" as const;
  const bks = opts.journal?.osSessionId;
  const engineSessionId =
    opts.sessionId || `synthetic-${bks || opts.transcriptSessionId || "run"}`;
  const unifiedId = bks || opts.transcriptSessionId;
  // Like a real adapter, claim the engine→unified mapping before the first
  // event so every store write resolves the owning session through it.
  if (unifiedId) recordEngineSessionOwner(engineSessionId, unifiedId);
  const runKey = bks ? opts.startToken || `synthetic-${bks}` : null;
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
    yield { type: "init", sessionId: engineSessionId, provider, model };
    for (let index = 0; index < chunks; index++) {
      const text = `synthetic chunk ${index + 1}/${chunks} for "${opts.prompt.slice(0, 40)}". `;
      yield { type: "text_chunk", text };
      await appendTranscriptEntries(engineSessionId, [
        transcriptLineAssistantText(
          text,
          `synthetic-text-${++entrySeq}`,
          undefined,
          model,
        ),
      ]);
      await sleep(chunkMs);
    }
    for (let index = 0; index < tools; index++) {
      const toolUseId = `synthetic-tool-${++entrySeq}`;
      const toolName = index % 2 === 0 ? "read" : "bash";
      const toolInput =
        index % 2 === 0
          ? { path: `src/file-${index}.ts` }
          : { command: `echo tool ${index}` };
      const result = `(synthetic result ${index + 1})`;
      yield { type: "tool_use", toolName, toolInput, toolUseId };
      yield { type: "tool_result", content: result, toolUseId };
      await appendTranscriptEntries(engineSessionId, [
        transcriptLineToolUse(toolUseId, toolName, toolInput),
        transcriptLineToolResult(toolUseId, result),
      ]);
      await sleep(chunkMs);
    }
    yield {
      type: "done",
      sessionId: engineSessionId,
      provider,
      model,
      usage: USAGE,
    };
  } finally {
    if (runKey) journalClear(runKey);
  }
}
