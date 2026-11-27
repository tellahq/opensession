import React from "react";
import type { PastedTextAttachment } from "../lib/pasted-text";
import { pastedTextLineLabel } from "../lib/pasted-text";
import { ComposerContextChip } from "./ComposerContextChip";
import { IconFileText2 } from "./icons";

interface Props {
  attachment: PastedTextAttachment;
  onRemove: () => void;
  disabled?: boolean;
}

/** Large clipboard text, kept out of the field while remaining part of the send. */
export function PastedTextContext({ attachment, onRemove, disabled }: Props) {
  return (
    <ComposerContextChip
      icon={<IconFileText2 size={20} />}
      label="Pasted text"
      meta={pastedTextLineLabel(attachment.text)}
      onRemove={onRemove}
      removeLabel="Remove pasted text"
      disabled={disabled}
    />
  );
}
