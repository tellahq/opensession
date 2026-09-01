import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
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
import { msgActivityShimmer, msgRow } from "../../lib/msg-classes";
import type { LiveTurnStore } from "../../lib/live-turn-store";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  minHFull: {
    minHeight: "100%",
  },
  wFull: {
    width: "100%",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  px6: {
    paddingInline: "calc(4px * 6)",
  },
  flexCol: {
    flexDirection: "column",
  },
  textCenter: {
    textAlign: "center",
  },
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt15: {
    marginTop: "calc(4px * 1.5)",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  relative: {
    position: "relative",
  },
  hFull: {
    height: "100%",
  },
  minH240px: {
    minHeight: "240px",
  },
  gap1: {
    gap: "4px",
  },
  mb2: {
    marginBottom: "calc(4px * 2)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  maxW340px: {
    maxWidth: "340px",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  inlineFlex: {
    display: "inline-flex",
  },
  fontNormal: {
    fontWeight: "var(--font-weight-normal)",
  },
  opacity70: {
    opacity: "70%",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  Ml2: {
    marginLeft: "calc(4px * -2)",
  },
  grid: {
    display: "grid",
  },
  size5: {
    width: "calc(4px * 5)",
    height: "calc(4px * 5)",
  },
  shrink0: {
    flexShrink: "0",
  },
  placeItemsCenter: {
    placeItems: "center",
  },
});

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
      {...stylex.props(
        sx.flex,
        sx.minHFull,
        sx.wFull,
        sx.itemsCenter,
        sx.justifyCenter,
        sx.px6,
      )}
    >
      <div
        {...stylex.props(sx.flex, sx.flexCol, sx.itemsCenter, sx.textCenter)}
      >
        <Spinner
          size="md"
          className={mergeStylexOverrideClassName("", sx.mb3, sx.textFaint)}
        />
        <div
          {...stylex.props(sx.fontSemibold, sx.textFg, typography.itemTitle)}
        >
          Setting up workspace
        </div>
        <div
          {...stylex.props(
            sx.mt15,
            sx.fontMedium,
            sx.textFaint,
            typography.label,
          )}
        >
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
    <div
      {...stylex.props(
        sx.relative,
        sx.flex,
        sx.hFull,
        sx.minH240px,
        sx.flexCol,
        sx.itemsCenter,
        sx.justifyCenter,
        sx.gap1,
        sx.px6,
        sx.textCenter,
      )}
    >
      <PageLoader
        className={mergeStylexOverrideClassName("", sx.mb2, sx.textDim)}
      />
      <div {...stylex.props(sx.fontSemibold, sx.textFg, typography.itemTitle)}>
        Creating your workspace
      </div>
      <div
        {...stylex.props(
          sx.maxW340px,
          sx.fontMedium,
          sx.leadingRelaxed,
          sx.textDim,
          typography.label,
        )}
      >
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
  if (!visible) return <div {...stylex.props(sx.minHFull)} />;
  // The fade sits on the wrapper, not on the skeleton: Motion writes inline
  // opacity, which the ghosts' own breathing animation would overwrite.
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ type: "tween", duration: duration.base, ease }}
    >
      <TranscriptSkeleton />
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
      <span role="status" aria-live="polite" {...stylex.props(sx.inlineFlex)}>
        <TextShimmer
          className={cn(
            utilityClassName("text-meta font-medium"),
            msgActivityShimmer,
          )}
        >
          {status.label}
        </TextShimmer>
      </span>
      {status.elapsed && (
        <span
          aria-hidden="true"
          {...mergeStylexProps("tabular-nums", sx.textFaint, typography.meta)}
        >
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
  return (
    <span {...mergeStylexProps("tabular-nums", sx.fontNormal, sx.opacity70)}>
      {label}
    </span>
  );
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
    <span {...stylex.props(sx.textFaint, typography.meta)}>
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
      {...stylex.props(sx.overflowHidden)}
    >
      <div
        className={cn(
          msgRow,
          utilityClassName(
            "mt-0.5 flex-row items-center gap-2 px-1 py-1.25 text-dim",
          ),
        )}
      >
        {/* The 8px pull hangs off the DOT, not off the row: msgRow centres
				    itself in the reading column with `mx-auto`, and a `-ml-2` on the
				    row overrides that auto (Tailwind emits `margin-left` after
				    `margin-inline`), leaving `margin-right: auto` to shove the whole
				    row against the scroller's left gutter. Here it lands the dot's
				    centre on the work fold's chevron, which hangs out by the same
				    8px from a box that stays centred. */}
        <span
          {...stylex.props(
            sx.Ml2,
            sx.grid,
            sx.size5,
            sx.shrink0,
            sx.placeItemsCenter,
          )}
        >
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
