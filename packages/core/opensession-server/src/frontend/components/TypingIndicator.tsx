import { cn } from "../ui/cn";
import { Tooltip } from "../ui/tooltip";
import { isTouchPrimary } from "../lib/platform";
import {
  typingLabel,
  typingPreviews,
  type TypingPresence,
} from "../lib/typing";

/**
 * "Jaap is typing…" under the transcript. Hovering the label shows the head
 * of what they have typed so far; on a phone, where there is no hover, the
 * same preview sits inline as one truncated line.
 */
export function TypingIndicator({
  presence,
  className,
}: {
  presence: TypingPresence;
  className?: string;
}) {
  const label = typingLabel(presence.users);
  if (!label) return null;
  const previews = typingPreviews(presence);
  const preview =
    previews.length === 0 ? null : previews.length === 1 ? (
      previews[0]!.text
    ) : (
      <span className="flex flex-col gap-1">
        {previews.map(({ user, text }) => (
          <span key={user}>
            <span className="opacity-70">{user}: </span>
            {text}
          </span>
        ))}
      </span>
    );
  return (
    <div className={cn("text-label text-faint", className)}>
      <Tooltip
        label={preview}
        multiline
        align="start"
        popupClassName="break-words"
      >
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="inline-block"
        >
          {label}
        </span>
      </Tooltip>
      {isTouchPrimary &&
        previews.length > 0 && (
          // Outside the live region on purpose: a preview that changes on every
          // keystroke must not be read aloud each time.
          <div className="truncate">
            {previews
              .map(({ user, text }) =>
                previews.length > 1 ? `${user}: ${text}` : text,
              )
              .join(" · ")}
          </div>
        )}
    </div>
  );
}
