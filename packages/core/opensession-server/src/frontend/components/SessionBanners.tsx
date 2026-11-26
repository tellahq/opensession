import { useLayoutEffect, useRef, useState } from "react";
import type { UnifiedSession } from "../lib/types";
import { SESSION_BANNER, SESSION_BANNERS } from "../lib/session-viewer-classes";
import { Button } from "../ui/button";
import { IconClock } from "./icons";

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
    <span
      className={`${SESSION_BANNER} gap-2 pr-1 text-dim`}
      title={loop.prompt}
    >
      <IconClock size={16} dense className="shrink-0" />
      <span className="shrink-0 text-fg">{loopScheduleLabel(loop)}</span>
      <span className="min-w-0 truncate">{loop.prompt}</span>
      {onStop && (
        <Button
          size="sm"
          variant="ghost"
          className="-my-1 min-h-[22px] shrink-0 px-2"
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
    <div ref={stripRef} className={SESSION_BANNERS}>
      {session.goal && (
        <span
          className={`${SESSION_BANNER} text-dim`}
          title="Cleared with /goal clear"
        >
          🎯 {session.goal}
        </span>
      )}
      {session.loop && (
        <SessionLoopBanner loop={session.loop} onStop={onStopLoop} />
      )}
    </div>
  );
}
