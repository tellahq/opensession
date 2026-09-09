import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { UNDO_SHORTCUT_KEYS } from "../../lib/undo";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { duration, ease } from "../../ui/motion";
import { Tooltip } from "../../ui/tooltip";
import { IconUndo } from "../icons";

/**
 * Whole seconds left until `deadline`, re-rendered on each second boundary
 * rather than on a free-running interval, so the digit flips exactly when
 * the value changes and never twice for one value.
 */
function useSecondsLeft(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline == null) return;
    setNow(Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      timer = setTimeout(
        () => {
          setNow(Date.now());
          arm();
        },
        remaining % 1000 || 1000,
      );
    };
    arm();
    return () => clearTimeout(timer);
  }, [deadline]);
  if (deadline == null) return null;
  return Math.max(1, Math.ceil((deadline - now) / 1000));
}

/**
 * The undo affordance that sits in front of the merge button during its
 * five-second window: the undo glyph plus a digit counting the seconds
 * left. The merge button itself stays put and reads "Merging…", so
 * cancelling never moves the thing the user just pressed.
 */
export function MergeUndoControl({
  onUndo,
  deadline = null,
  compact = false,
  className,
}: {
  onUndo: () => void;
  /** When the merge fires; drives the countdown. Omit for a bare glyph. */
  deadline?: number | null;
  compact?: boolean;
  className?: string;
}) {
  const seconds = useSecondsLeft(deadline);
  return (
    <Tooltip label="Undo merge" shortcut={UNDO_SHORTCUT_KEYS}>
      <Button
        variant="ghost"
        size={compact ? "sm" : "md"}
        aria-label={
          seconds == null ? "Undo merge" : `Undo merge, ${seconds}s left`
        }
        onClick={onUndo}
        icon={<IconUndo size={compact ? 18 : 20} />}
        iconTone="full"
        className={cn(
          "shrink-0 text-dim",
          seconds != null && "pr-2",
          className,
        )}
      >
        {seconds != null && (
          <span
            aria-hidden
            className="relative inline-block w-[1ch] overflow-hidden font-medium tabular-nums"
          >
            {/* Each digit rolls down through the slot as the next one takes
                its place, the way a mechanical counter turns. */}
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={seconds}
                className="inline-block"
                initial={{ y: "-100%", opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: "100%", opacity: 0 }}
                transition={{ type: "tween", duration: duration.base, ease }}
              >
                {seconds}
              </motion.span>
            </AnimatePresence>
          </span>
        )}
      </Button>
    </Tooltip>
  );
}
