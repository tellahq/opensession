import { cn } from "../ui/cn";
import { Tooltip } from "../ui/tooltip";
import {
  STATUS_LABEL,
  plainStatusClass,
  plainStatusIcon,
} from "../lib/plain-status";

/**
 * A Plain thread's status as one square badge: the glyph for the state, on
 * that state's tint. Everywhere the app shows a thread's status.
 *
 * It is a picture with a name, not a control. The word it replaced is the
 * tooltip and the accessible name, so the state can still be read out and
 * hovered for; changing it is the job of the Done / Snooze controls next to
 * it (`PlainThreadActions`), which is why this is a `span` with no tab stop.
 */
export function PlainStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const label = STATUS_LABEL[status] || status;
  const Icon = plainStatusIcon(status);
  return (
    <Tooltip label={label}>
      <span
        className={cn(plainStatusClass(status), className)}
        role="img"
        aria-label={`Status: ${label}`}
      >
        <Icon size={20} />
      </span>
    </Tooltip>
  );
}
