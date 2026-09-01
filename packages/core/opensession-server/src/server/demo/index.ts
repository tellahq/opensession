/**
 * Demo mode driver. Boot calls startDemo() (end of the boot block, gated on
 * OPENSESSION_DEMO=1); it must NEVER throw out — a broken demo must not take
 * a boot down, so every stage is try/caught and only logs.
 *
 * Three stages:
 *  1. Generator (disk, idempotent via the sessions-dir marker) — sessions,
 *     transcripts, git repo/worktree, PR caches, automations, audit,
 *     goal. See generate.ts.
 *  2. The in-memory bits disk can't fake (asks.ts pendingAsks is a
 *     restart-fresh globalThis map): a waiting-on-question card on the demo
 *     ask session, re-armed after each answer so the "waiting" lane stays
 *     populated for the whole demo.
 *  3. The replayer: one session streams a scripted transcript on a loop and
 *     reads as running. See replay.ts.
 */

import { generateDemoData } from "./generate";
import { startDemoReplayer } from "./replay";
import { offerAskCard, type AskQuestionInput } from "../asks";
import {
  appendTranscriptEntries,
  recordEngineSessionOwner,
  transcriptLineAssistantText,
  transcriptLineUser,
} from "../transcript-persistence";
import { touchNativeSession } from "../session-cache";
import {
  DEMO_ASK_ENGINE_SESSION_ID,
  DEMO_ASK_SESSION_ID,
  demoAskQuestions,
} from "./fixtures";

/** Answering retires the card; re-offer after this so the demo's "waiting on
 *  input" lane repopulates without a restart. */
const ASK_REARM_MS = 45_000;

interface DemoState {
  started: boolean;
  askRearmTimer: ReturnType<typeof setTimeout> | null;
}

const g = globalThis as { __osDemoState?: DemoState };

function offerDemoAsk(state: DemoState): void {
  const sessionId = DEMO_ASK_SESSION_ID;
  const questions = demoAskQuestions() as AskQuestionInput[];
  recordEngineSessionOwner(DEMO_ASK_ENGINE_SESSION_ID, sessionId);
  offerAskCard(sessionId, questions, async (answers) => {
    try {
      if (answers) {
        // Land the answer in the transcript through the real engine write
        // path (import-first gate pulls the seeded jsonl history in), so the
        // Answer flow visibly completes end-to-end.
        const picked = Object.values(answers).join("; ");
        await appendTranscriptEntries(DEMO_ASK_ENGINE_SESSION_ID, [
          transcriptLineUser(`[Demo viewer] ${picked}`),
          transcriptLineAssistantText(
            `Noted — going with **${picked}**. I'll draft the rollout plan on that basis. (Demo session: the card re-arms in a moment.)`,
          ),
        ]);
        touchNativeSession(sessionId, {});
      }
    } catch (e) {
      console.error("[demo] ask answer handling failed:", e);
    }
    if (state.askRearmTimer) clearTimeout(state.askRearmTimer);
    state.askRearmTimer = setTimeout(() => {
      state.askRearmTimer = null;
      try {
        offerDemoAsk(state);
      } catch (e) {
        console.error("[demo] ask re-arm failed:", e);
      }
    }, ASK_REARM_MS);
  });
}

/**
 * Boot hook (OPENSESSION_DEMO=1): generate-if-unseeded, register the ask
 * card, start the replayer. Idempotent per process; never throws.
 */
export async function startDemo(): Promise<void> {
  // Isolation precondition — refuse, don't trust the caller. Demo writes fan
  // out beyond the sessions dir (PR caches, automations, audit, goals via
  // stateDir(); pi maps/transcripts via their own resolvers), so the
  // strict OPENSESSION_STATE_DIR master knob is required — a sessions-dir-only
  // redirect would leak the stateDir() stores into the operator's live state.
  // The engine-transcripts dir must ALSO resolve inside the state root (it has
  // an independent default under ~/.claude): .agents/start.sh sets it;
  // a manual boot that forgot gets refused here instead of scribbling demo
  // JSONL next to real engine transcripts.
  const stateRoot = process.env.OPENSESSION_STATE_DIR;
  if (!stateRoot) {
    console.error(
      "[demo] refusing to start: OPENSESSION_DEMO=1 requires OPENSESSION_STATE_DIR " +
        "(demo data must never seed live state; boot via .agents/start.sh or set it explicitly)",
    );
    return;
  }
  const state: DemoState = (g.__osDemoState ??= {
    started: false,
    askRearmTimer: null,
  });
  if (state.started) return;
  state.started = true;

  try {
    const result = generateDemoData();
    console.log(
      result.created
        ? `[demo] dataset generated into ${result.sessionsDir} (${result.sessionIds.length} sessions)`
        : `[demo] dataset already present in ${result.sessionsDir} (marker found)`,
    );
  } catch (e) {
    console.error("[demo] dataset generation failed:", e);
  }

  // The PR snapshot caches are seeded on disk by the generator, but both
  // modules read their snapshot at module load — i.e. before this runs. Reseed
  // so the demo PR is actually in memory: without it the dataset's PR exists
  // on disk and nowhere else, and every PR surface (session PR panel, Home's
  // PR-worktree list) renders empty.
  try {
    const [{ loadPrCacheSnapshot }, { loadPrDetailsSnapshot, seedPrDiff }] =
      await Promise.all([import("../sessions"), import("../pr-info")]);
    loadPrCacheSnapshot();
    loadPrDetailsSnapshot();
    // The Review page's Files-changed tab renders GitHub's patch, which no
    // amount of local git can stand in for — pin the synthetic one.
    const { demoPrDiff, DEMO_BRANCH, DEMO_GH_REPO } =
      await import("./fixtures");
    seedPrDiff(DEMO_GH_REPO, DEMO_BRANCH, demoPrDiff(Date.now(), DEMO_GH_REPO));
  } catch (e) {
    console.error("[demo] PR cache reseed failed:", e);
  }

  try {
    offerDemoAsk(state);
  } catch (e) {
    console.error("[demo] ask-card registration failed:", e);
  }

  try {
    await startDemoReplayer();
  } catch (e) {
    console.error("[demo] replayer start failed:", e);
  }
}
