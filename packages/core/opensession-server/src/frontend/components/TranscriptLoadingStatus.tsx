import { msgSystemInline } from "../lib/msg-classes";
import { Spinner } from "../ui/spinner";

/** A transcript fetch occupying the same one-line slot as session context. */
export function TranscriptLoadingStatus() {
  return (
    <span
      className={msgSystemInline}
      role="status"
      aria-live="polite"
      data-transcript-loading
    >
      <span className="inline-flex h-5 items-center gap-2 whitespace-nowrap">
        <Spinner className="text-dim" />
        Loading transcript…
      </span>
    </span>
  );
}
