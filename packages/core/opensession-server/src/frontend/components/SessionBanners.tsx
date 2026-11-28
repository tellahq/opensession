import { useLayoutEffect, useRef, useState } from "react";
import type { UnifiedSession } from "../lib/types";
import * as stylex from "@stylexjs/stylex";
import { Button } from "../ui/button";
import {
  color,
  controlHeight,
  geometry,
  media,
  radius,
  space,
  text,
} from "../ui/tokens.stylex";
import { IconClock } from "./icons";

const styles = stylex.create({
  /** The strip under the session header. On a phone the header floats over
   *  the column, so an in-flow row would hide under it: the strip pins under
   *  the header (and the docked tab strip, when shown) instead. */
  strip: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.s8,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: color.divider,
    backgroundColor: color.raised,
    paddingInline: { default: space.s16, [media.phone]: space.s12 },
    paddingBlock: space.s6,
    position: { default: null, [media.phone]: "absolute" },
    insetInline: { default: null, [media.phone]: 0 },
    top: { default: null, [media.phone]: geometry.belowPaneHeader },
    zIndex: { default: null, [media.phone]: 5 },
  },
  /** One notice: a small control's height, one truncating line. */
  chip: {
    display: "inline-flex",
    maxWidth: "100%",
    minHeight: controlHeight.sm,
    alignItems: "center",
    gap: space.s6,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    borderRadius: radius.pill,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.line,
    backgroundColor: color.panel,
    paddingInline: space.s12,
    fontSize: text.label,
    color: color.dim,
  },
  /** The loop's chip ends in its Stop button, so it closes tighter. */
  loopChip: { gap: space.s8, paddingInlineEnd: space.s4 },
  fixed: { flexShrink: 0 },
  schedule: { flexShrink: 0, color: color.fg },
  prompt: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

type SessionLoop = NonNullable<UnifiedSession["loop"]>;

/** "Every 15m until 14:30", in the viewer's own clock. */
export function loopScheduleLabel(loop: SessionLoop): string {
  const every = `Every ${loop.intervalMinutes}m`;
  if (!loop.until) return every;
  const until = new Date(loop.until);
  if (Number.isNaN(until.getTime())) return every;
  return `${every} until ${until.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/**
 * A session loop (`/loop`, or an agent monitoring with schedule_prompt's
 * every_minutes) re-runs its prompt on a timer, so the person needs to see
 * that it is running, when it ends, and a way to end it that does not mean
 * remembering `/loop stop`.
 */
export function SessionLoopBanner({
  loop,
  onStop,
}: {
  loop: SessionLoop;
  /** Absent while disconnected: the loop cannot be stopped from here. */
  onStop?: () => void;
}) {
  const [stopping, setStopping] = useState(false);
  return (
    <span {...stylex.props(styles.chip, styles.loopChip)} title={loop.prompt}>
      <IconClock size={16} dense {...stylex.props(styles.fixed)} />
      <span {...stylex.props(styles.schedule)}>{loopScheduleLabel(loop)}</span>
      <span {...stylex.props(styles.prompt)}>{loop.prompt}</span>
      {onStop && (
        <Button
          size="sm"
          variant="ghost"
          className="min-h-[22px] shrink-0 px-2"
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            onStop();
          }}
        >
          {stopping ? "Stopping" : "Stop"}
        </Button>
      )}
    </span>
  );
}

/** The strip under the session header for standing instructions: a pinned
 *  `/goal` and a running loop. */
export function SessionBanners({
  session,
  onStopLoop,
  onHeightChange,
}: {
  session: Pick<UnifiedSession, "goal" | "loop">;
  onStopLoop?: () => void;
  /** The strip's height, 0 while it is gone, so chrome that hangs below the
   *  header (the Workspace summary card) can clear it. */
  onHeightChange?: (height: number) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const shown = Boolean(session.goal || session.loop);
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!shown || !el || !onHeightChange) return;
    onHeightChange(el.offsetHeight);
    const observer = new ResizeObserver(() => onHeightChange(el.offsetHeight));
    observer.observe(el);
    return () => {
      observer.disconnect();
      onHeightChange(0);
    };
  }, [shown, onHeightChange]);
  if (!shown) return null;
  return (
    <div ref={stripRef} {...stylex.props(styles.strip)}>
      {session.goal && (
        <span {...stylex.props(styles.chip)} title="Cleared with /goal clear">
          🎯 {session.goal}
        </span>
      )}
      {session.loop && (
        <SessionLoopBanner loop={session.loop} onStop={onStopLoop} />
      )}
    </div>
  );
}
