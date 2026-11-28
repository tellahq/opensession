import { useEffect, useState, useSyncExternalStore } from "react";
import { motion, useReducedMotion } from "motion/react";
import { duration, ease } from "../../ui/motion";
import { TranscriptSkeleton } from "../../ui/state";
import { PageLoader } from "../../ui/page-loader";
import { Spinner } from "../../ui/spinner";
import { PulseDot } from "../../ui/status";
import * as stylex from "@stylexjs/stylex";
import { sx } from "../../ui/sx";
import {
  color,
  geometry,
  space,
  text,
  weight,
  leading,
  opacity,
} from "../../ui/tokens.stylex";
import { TextShimmer } from "../../ui/text-shimmer";
import { busyActivityStatus } from "../../lib/busy-activity";
import type { RunActivity } from "@tellahq/opensession-protocol/events";
import { msgActivityShimmer } from "../../lib/msg-classes";
import { TRANSCRIPT_SYNC_SPOT } from "../../lib/session-viewer-classes";
import type { LiveTurnStore } from "../../lib/live-turn-store";

const styles = stylex.create({
  setup: {
    display: "flex",
    minHeight: "100%",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: space.s24,
  },
  centered: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
  },
  setupSpinner: { marginBottom: space.s12, color: color.faint },
  title: {
    fontSize: text.itemTitle,
    fontWeight: weight.strong,
    color: color.fg,
  },
  setupDetail: {
    marginTop: space.s6,
    fontSize: text.label,
    fontWeight: weight.medium,
    color: color.faint,
  },
  waiting: {
    position: "relative",
    display: "flex",
    height: "100%",
    minHeight: geometry.paneEmptyMinHeight,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s4,
    paddingInline: space.s24,
    textAlign: "center",
  },
  waitingLoader: { marginBottom: space.s8, color: color.dim },
  waitingDetail: {
    maxWidth: geometry.paneEmptyMeasure,
    fontSize: text.label,
    fontWeight: weight.medium,
    lineHeight: leading.relaxed,
    color: color.dim,
  },
  fill: { minHeight: "100%" },
  faint: { color: color.faint },
  status: { display: "inline-flex" },
  meta: { fontSize: text.meta, fontWeight: weight.regular },
  label: { fontSize: text.label },
  activity: { fontSize: text.meta, fontWeight: weight.medium },
  tabular: { fontVariantNumeric: "tabular-nums" },
  steerWait: {
    fontWeight: weight.regular,
    fontVariantNumeric: "tabular-nums",
    opacity: opacity.quiet,
  },
  clip: { overflow: "hidden" },
  // msgRow spelled out: its Tailwind `flex-col` would beat a StyleX row.
  busyRow: {
    marginInline: "auto",
    marginBottom: geometry.turnGap,
    display: "flex",
    width: "100%",
    maxWidth: geometry.sessionColumn,
    marginTop: space.s2,
    flexDirection: "row",
    alignItems: "center",
    gap: space.s2,
    paddingInline: space.s4,
    paddingBlock: geometry.busyRowPadBlock,
    color: color.dim,
  },
  dotSlot: {
    marginLeft: `calc(-1 * ${space.s8})`,
    display: "grid",
    width: space.s20,
    height: space.s20,
    flexShrink: 0,
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
      {...stylex.props(styles.setup)}
    >
      <div {...stylex.props(styles.centered)}>
        <Spinner size="md" {...stylex.props(styles.setupSpinner)} />
        <div {...stylex.props(styles.title)}>Setting up workspace</div>
        <div {...stylex.props(styles.setupDetail)}>
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
    <div {...stylex.props(styles.waiting)}>
      <PageLoader {...stylex.props(styles.waitingLoader)} />
      <div {...stylex.props(styles.title)}>Creating your workspace</div>
      <div {...stylex.props(styles.waitingDetail)}>{detail}</div>
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
  if (!visible) return <div {...stylex.props(styles.fill)} />;
  // The fade sits on the wrapper, not on the skeleton: Motion writes inline
  // opacity, which the ghosts' own breathing animation would overwrite.
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ type: "tween", duration: duration.base, ease }}
    >
      <TranscriptSkeleton label="Loading transcript" />
    </motion.div>
  );
}

// How long the cached tail may sit on screen before the catch-up spinner
// appears. Most watch handshakes answer well inside this, and a ring that
// flashes and goes on every thread open is worse than none.
const SYNC_SPINNER_DELAY_S = 0.25;

/**
 * A thread opened from its cached entries while the server is still answering
 * the resume watch. The entries are real and readable, just possibly behind;
 * this is the one hint that newer messages may be on the way. It floats over
 * the scroller's bottom padding rather than joining the transcript, so it
 * never reads as a row of the conversation and never moves one.
 */
export function TranscriptSyncing() {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      role="status"
      aria-live="polite"
      data-transcript-syncing
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0 } }}
      transition={{
        type: "tween",
        duration: reducedMotion ? 0 : duration.micro,
        delay: reducedMotion ? 0 : SYNC_SPINNER_DELAY_S,
        ease,
      }}
      className={TRANSCRIPT_SYNC_SPOT}
    >
      <Spinner {...stylex.props(styles.faint)} />
      <span className="sr-only">Checking for new messages</span>
    </motion.div>
  );
}

// Persistent turn-level status: the dot and the run's elapsed time, counted
// from its first second. A tool, a thought or a reply already shows itself
// in the transcript above, so the row adds no words of its own except for a
// compaction or a retry wait, which nothing above explains. The phase is
// still announced to assistive tech through a hidden label; the elapsed value
// is hidden from it so it is not read out every second, and so is a retry
// countdown, whose label would otherwise be re-announced on every tick. The
// ticker stays inside this tiny node instead of re-rendering the transcript,
// and it lands on the run's own second boundaries so the count never skips.
function BusyWorking({
  since,
  activity,
}: {
  since: number | null;
  activity: RunActivity | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  const ticking = since != null || activity?.kind === "retrying";
  useEffect(() => {
    if (!ticking) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      const into = since == null ? 0 : (((at - since) % 1000) + 1000) % 1000;
      timer = setTimeout(tick, 1000 - into);
    };
    tick();
    return () => clearTimeout(timer);
  }, [ticking, since]);
  const status = busyActivityStatus(
    since == null ? 0 : now - since,
    activity,
    now,
  );
  const countingDown = activity?.kind === "retrying";
  return (
    <>
      <span
        role="status"
        aria-live={countingDown ? "off" : "polite"}
        aria-label={countingDown ? "Retrying" : undefined}
        {...stylex.props(styles.status)}
      >
        {status.label ? (
          <TextShimmer
            {...sx(
              [styles.activity, countingDown && styles.tabular],
              msgActivityShimmer,
            )}
          >
            {status.label}
          </TextShimmer>
        ) : (
          <span className="sr-only">{status.spoken}</span>
        )}
      </span>
      {status.detail && (
        <span {...stylex.props(styles.meta, styles.faint, styles.tabular)}>
          · {status.detail}
        </span>
      )}
      {since != null && (
        // On its own the time is the row, so it reads at label size; beside
        // a compaction or retry label it matches that label's size.
        <span
          aria-hidden="true"
          {...stylex.props(
            styles.faint,
            styles.tabular,
            status.label ? styles.meta : styles.label,
          )}
        >
          {status.label ? `· ${status.elapsed}` : status.elapsed}
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
  return <span {...stylex.props(styles.steerWait)}>{label}</span>;
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
    <span {...stylex.props(styles.meta, styles.faint)}>
      {slow ? "Still stopping…" : "Stopping…"}
    </span>
  );
}

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
  const activity = useSyncExternalStore(
    liveTurnStore.subscribe,
    liveTurnStore.getActivity,
    liveTurnStore.getNoActivity,
  );
  // The row stays for the whole run, under streamed words too: it is one
  // dot and a short count, so a line wrap above moves it without the jolt a
  // sentence of status copy used to make.
  return (
    <motion.div
      initial={reducedMotion ? false : { height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{
        type: "tween",
        duration: reducedMotion ? 0 : duration.base,
        ease,
      }}
      onUpdate={onLayout}
      {...stylex.props(styles.clip)}
    >
      <div {...sx(styles.busyRow, "msg")}>
        {/* The 8px pull hangs off the DOT, not off the row: msgRow centres
				    itself in the reading column with `mx-auto`, and a `-ml-2` on the
				    row overrides that auto (Tailwind emits `margin-left` after
				    `margin-inline`), leaving `margin-right: auto` to shove the whole
				    row against the scroller's left gutter. Here it lands the dot's
				    centre on the work fold's chevron, which hangs out by the same
				    8px from a box that stays centred. */}
        <span {...stylex.props(styles.dotSlot)}>
          <PulseDot size={9} />
        </span>
        {stoppingSince != null ? (
          <BusyStopping since={stoppingSince} />
        ) : (
          <BusyWorking since={since} activity={activity} />
        )}
      </div>
    </motion.div>
  );
}
