import React from "react";
import { quotePreview, type Quote } from "../lib/quotes";
import { ComposerContextChip } from "./ComposerContextChip";
import { IconCursor } from "./icons";

interface Props {
  quote: Quote;
  onRemove: () => void;
  disabled?: boolean;
}

/** The active transcript selection, shown as lightweight composer context.
 *  Shares its shape with note mode — see ComposerContextChip. */
export function QuoteContext({ quote, onRemove, disabled }: Props) {
  return (
    <ComposerContextChip
      icon={<IconCursor size={15} />}
      label="Selected text"
      title={quotePreview(quote.text)}
      onRemove={onRemove}
      removeLabel="Remove selected text"
      disabled={disabled}
    />
  );
}
