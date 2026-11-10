import { useState } from "react";
import { copyToClipboard } from "../../lib/share-link";
import { CopyCheck } from "../../ui/copy";
import { Tooltip } from "../../ui/tooltip";
import { IconCopy } from "../icons";

/** A small inline copy glyph that turns into a check for a beat. */
export function CopyTextButton({
  text,
  label,
}: {
  text: string;
  /** What gets copied, as the tooltip and accessible name ("Copy title"). */
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip label={copied ? "Copied" : label}>
      <button
        type="button"
        aria-label={label}
        className="focus-ring grid size-6 shrink-0 place-items-center rounded-sm border-0 bg-transparent p-0 text-faint hover:bg-hover hover:text-fg"
        onClick={() =>
          copyToClipboard(text, () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          })
        }
      >
        <CopyCheck copied={copied} idle={<IconCopy />} />
      </button>
    </Tooltip>
  );
}
