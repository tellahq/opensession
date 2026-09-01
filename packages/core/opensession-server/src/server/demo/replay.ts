/**
 * Demo transcript replayer — makes DEMO_LIVE_SESSION_ID look like a session
 * mid-run: the sidebar shows it running and watchers see the transcript
 * stream in live, on a loop.
 *
 * How "running" and "streaming" are faked with the real machinery:
 *  - markSessionStarting() (agent-runner pendingStarts) is what makes
 *    isAgentSessionBusy → UnifiedSession.isRunning true, and the paired
 *    run-state transitions keep the FSM in `running` so the session-cache
 *    wedge detector never sees an FSM/engine divergence.
 *  - Entries go through recordEngineSessionOwner + appendTranscriptEntries — the
 *    exact write path a live pi run uses — so they land in
 *    transcripts.db and fan out to v2 watchers over the transcript bus with
 *    zero demo-specific serve code. Each loop restarts with
 *    replaceTranscriptEvents (an authoritative reset frame), keeping the
 *    stored transcript bounded.
 *  - touchNativeSession bumps lastActivity once per step so list pollers
 *    (and clients without a live WS) keep sorting the session to the top.
 *
 * In-memory only, parked on globalThis: never persisted, restart-fresh, safe
 * across hot reloads. Never started unless startDemo() runs (OPENSESSION_DEMO=1).
 */

import { markSessionStarting } from "../agent-runner";
import { transitionRunState } from "../run-state";
import {
  appendTranscriptEntries,
  recordEngineSessionOwner,
} from "../transcript-persistence";
import { parseJsonlLines } from "../jsonl-parser";
import {
  importLegacyTranscript,
  replaceTranscriptEvents,
  transcript,
} from "../actor-transcript";
import { touchNativeSession } from "../session-cache";
import {
  DEMO_LIVE_ENGINE_SESSION_ID,
  DEMO_LIVE_SESSION_ID,
  demoReplayScript,
} from "./fixtures";

/** ~9s per step × 14 steps ≈ 2 minutes per loop, plus the idle beat below. */
const STEP_MS = 9_000;
/** Pause on the finished transcript before the next loop resets it. */
const LOOP_REST_MS = 20_000;

interface DemoReplayState {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
}

const g = globalThis as { __osDemoReplay?: DemoReplayState };

export async function startDemoReplayer(): Promise<void> {
  const state: DemoReplayState = (g.__osDemoReplay ??= {
    timer: null,
    running: false,
  });
  if (state.running) return;
  state.running = true;

  const sessionId = DEMO_LIVE_SESSION_ID;
  const ocId = DEMO_LIVE_ENGINE_SESSION_ID;

  // Fresh session: skip the legacy-import gate up front so the first append
  // never tries to merge nonexistent history.
  recordEngineSessionOwner(ocId, sessionId);
  if (await transcript.needsImport(sessionId)) {
    await importLegacyTranscript(sessionId, [], "live-only", null);
  }

  // Busy-mark + FSM: prompt → starting, run_registered → running.
  await markSessionStarting(sessionId);
  await transitionRunState(sessionId, "run_registered", { demo: true });

  const script = demoReplayScript();
  let step = 0;

  const tick = async () => {
    if (!state.running) return;
    try {
      if (step >= script.length) {
        step = 0;
        state.timer = setTimeout(() => void tick(), LOOP_REST_MS);
        return;
      }
      const lines = script[step]();
      if (step === 0) {
        // Loop restart: authoritatively replace (reset:true on the bus) so
        // watchers drop the previous loop instead of merging into it.
        await replaceTranscriptEvents(
          sessionId,
          parseJsonlLines(lines.map((l) => JSON.stringify(l))),
        );
      } else {
        await appendTranscriptEntries(ocId, lines);
      }
      touchNativeSession(sessionId, {});
      step++;
    } catch (e) {
      console.error("[demo] replay step failed:", e);
    }
    state.timer = setTimeout(() => void tick(), STEP_MS);
  };
  void tick();
}
