import { checkClass, formatCheckDuration } from "../../lib/pr-status-derive";
import { CHECK_TEXT } from "../../lib/pr-tone-classes";
import type { PrCheck } from "../../lib/types";

/** `pr-check-mark-pending` styles nothing — it is base.css's hook for keeping
 *  this pulse alive under prefers-reduced-motion, which it does with
 *  !important and a utility therefore cannot. */
export function CheckRow({ check }: { check: PrCheck }) {
  const cls = checkClass(check.status, check.conclusion);
  const mark =
    cls === "check-success" ? "✓" : cls === "check-failure" ? "✕" : "●";
  const duration = formatCheckDuration(check);
  return (
    <div className="group flex items-center gap-2 rounded-control px-1.5 py-1 text-label text-fg transition-[background] hover:bg-hover">
      <a
        className="flex min-w-0 flex-1 items-center gap-2 text-inherit no-underline"
        href={check.url}
        target="_blank"
        rel="noopener"
      >
        <span
          className={`w-3.5 shrink-0 text-center text-label ${CHECK_TEXT[cls]} ${
            cls === "check-pending" ? "pr-check-mark-pending animate-live" : ""
          }`}
        >
          {mark}
        </span>
        <span className="flex-1 truncate">{check.name}</span>
        {duration && (
          <span className="text-meta tabular-nums text-faint">{duration}</span>
        )}
        {check.url && (
          <span className="text-item-title text-faint group-hover:text-fg">
            ↗
          </span>
        )}
      </a>
    </div>
  );
}
