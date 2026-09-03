import { useEffect, useState, useSyncExternalStore } from "react";
import { motion, useReducedMotion } from "motion/react";
import { duration, ease } from "../../ui/motion";
import { TranscriptSkeleton } from "../../ui/state";
import { PageLoader } from "../../ui/page-loader";
import { Spinner } from "../../ui/spinner";
import { PulseDot } from "../../ui/status";
import { cn } from "../../ui/cn";
import { TextShimmer } from "../../ui/text-shimmer";
import { busyActivityStatus } from "../../lib/busy-activity";
import {
  msgActivityShimmer,
  msgRow,
  msgSystemRow,
} from "../../lib/msg-classes";
import type { LiveTurnStore } from "../../lib/live-turn-store";
import { TranscriptLoadingStatus } from "../TranscriptLoadingStatus";

/** The chat canvas while a new session's worktree is being prepared. The
 * opening message stays visible in the composer queue until it can move into
 * the transcript. */
export function WorkspaceSetup() {
  return (
    <motion.div
      role="status"
      aria-live="polite"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ type: "tween", duration: duration.base, ease }}
      className="flex min-h-full w-full items-center justify-center px-6"
    >
      <div className="flex flex-col items-center text-center">
        <Spinner size="md" className="mb-3 text-faint" />
        <div className="text-item-title font-semibold text-fg">
          Setting up workspace
        </div>
        <div className="mt-1.5 text-label font-medium text-faint">
          Your message will send when it’s ready.
        </div>
      </div>
    </motion.div>
  );
}

// A pane that has nothing to show until the worktree exists (the terminal, the
// review side).
export function WorkspaceWaiting({ detail }: { detail: string }) {
  return (
    <div className="relative flex h-full min-h-[240px] flex-col items-center justify-center gap-1 px-6 text-center">
      <PageLoader className="mb-2 text-dim" />
      <div className="text-item-title font-semibold text-fg">
        Creating your workspace
      </div>
      <div className="max-w-[340px] text-label font-medium leading-relaxed text-dim">
        {detail}
      </div>
    </div>
  );
}

export function ConversationLoading() {
  // Held back for a beat: most transcripts arrive fast enough that a
  // placeholder would flash and go, which is more distracting than the empty
  // canvas it replaced. Only a load slow enough to notice gets stood in for.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 180);
    return () => clearTimeout(t);
  }, []);
  if (!visible) return <div className="min-h-full" />;
  // The fade sits on the wrapper, not on the skeleton: Motion writes inline
  // opacity, which the ghosts' own breathing animation would overwrite.
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ type: "tween", duration: duration.base, ease }}
    >
      <div className={msgSystemRow}>
        <TranscriptLoadingStatus />
      </div>
      <TranscriptSkeleton aria-hidden="true" />
    </motion.div>
  );
}

// Persistent turn-level fallback for providers that emit no visible reasoning
// or tool event for a while. It only claims what the client knows: the request
// is active. The 1Hz ticker stays inside this tiny node instead of re-rendering
// the transcript, and the elapsed value is hidden from assistive tech so it is
// not announced every second.
function BusyWorking({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  const status = busyActivityStatus(since == null ? 0 : now - since);
  return (
    <>
      <span role="status" aria-live="polite" className="inline-flex">
        <TextShimmer
          className={cn("text-meta font-medium", msgActivityShimmer)}
        >
          {status.label}
        </TextShimmer>
      </span>
      {status.elapsed && (
        <span aria-hidden="true" className="text-meta text-faint tabular-nums">
          · {status.elapsed}
        </span>
      )}
    </>
  );
}

// How long a steer may wait before the chip starts showing how long it has
// waited. Under this, the counter would be noise on a fold-in that is about to
// land anyway; over it, the silence is what reads as a hang.
const STEER_SLOW_MS = 5000;

/**
 * A steer the run has accepted but not yet read. Pi injects it after the
 * current tool or assistant message reaches its boundary, so this wait is the
 * remainder of whatever the agent is doing right now: usually seconds, but a
 * `bun test` or a subagent can hold it for minutes.
 *
 * The counter appears only once the wait is long enough to worry about, and it
 * counts up rather than predicting a landing time, because nothing here knows
 * how long the running tool will take. A still chip saying "Steered" was the
 * bug: it claimed delivery during the only window in which delivery had not
 * happened, since the receipt is reconciled away as soon as it has.
 */
export function SteerWaiting({ since }: { since?: number }) {
  const [waited, setWaited] = useState(() => (since ? Date.now() - since : 0));
  useEffect(() => {
    if (!since) return;
    setWaited(Date.now() - since);
    const t = setInterval(() => setWaited(Date.now() - since), 1000);
    return () => clearInterval(t);
  }, [since]);
  // An old receipt restored across a restart has no stamp; showing nothing is
  // better than showing a made-up zero.
  if (!since || waited < STEER_SLOW_MS) return null;
  const s = Math.floor(waited / 1000);
  const label =
    s < 60
      ? `${s}s`
      : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return <span className="font-normal tabular-nums opacity-70">{label}</span>;
}

// How long a stop may sit there before the label stops sounding confident.
const STOP_SLOW_MS = 5000;

/**
 * The stop has been asked for, the turn has not settled yet. This deliberately
 * counts nothing: freezing the work timer at click time would be a small lie
 * (the engine really is still unwinding its current tool call), and letting it
 * run is the complaint we are fixing. After STOP_SLOW_MS the wording admits
 * the abort has not landed rather than sitting on a hopeful "Stopping…"
 * forever — the one thing this row must never do is claim the agent has
 * stopped while it is still editing files.
 */
function BusyStopping({ since }: { since: number }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const waited = Date.now() - since;
    setSlow(waited >= STOP_SLOW_MS);
    if (waited >= STOP_SLOW_MS) return;
    const t = setTimeout(() => setSlow(true), STOP_SLOW_MS - waited);
    return () => clearTimeout(t);
  }, [since]);
  return (
    <span className="text-meta text-faint">
      {slow ? "Still stopping…" : "Stopping…"}
    </span>
  );
}

const getFalse = () => false;

export function BusyInline({
  since,
  stoppingSince,
  liveTurnStore,
  onLayout,
}: {
  since: number | null;
  stoppingSince: number | null;
  liveTurnStore: LiveTurnStore;
  onLayout?: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const hasPaintedText = useSyncExternalStore(
    liveTurnStore.subscribe,
    liveTurnStore.hasPaintedText,
    getFalse,
  );
  // Once words are visible, the stream itself and its caret are the progress
  // indicator. Keeping a second status row under a growing answer makes every
  // line wrap relocate that row, and under reduced motion those relocations are
  // intentionally instant. Collapse it once instead; stopping always remains
  // explicit even when streamed text is still present.
  const shown = !hasPaintedText || stoppingSince != null;
  return (
    <motion.div
      initial={reducedMotion ? false : { height: 0, opacity: 0 }}
      animate={{ height: shown ? "auto" : 0, opacity: shown ? 1 : 0 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{
        type: "tween",
        duration: reducedMotion ? 0 : duration.base,
        ease,
      }}
      onUpdate={onLayout}
      className="overflow-hidden"
    >
      <div
        className={cn(
          msgRow,
          "mt-0.5 flex-row items-center gap-2 px-1 py-1.25 text-dim",
        )}
      >
        {/* The 8px pull hangs off the DOT, not off the row: msgRow centres
				    itself in the reading column with `mx-auto`, and a `-ml-2` on the
				    row overrides that auto (Tailwind emits `margin-left` after
				    `margin-inline`), leaving `margin-right: auto` to shove the whole
				    row against the scroller's left gutter. Here it lands the dot's
				    centre on the work fold's chevron, which hangs out by the same
				    8px from a box that stays centred. */}
        <span className="-ml-2 grid size-5 shrink-0 place-items-center">
          <PulseDot size={7} />
        </span>
        {stoppingSince != null ? (
          <BusyStopping since={stoppingSince} />
        ) : (
          <BusyWorking since={since} />
        )}
      </div>
    </motion.div>
  );
}
