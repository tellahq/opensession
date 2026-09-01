import { describe, expect, test } from "bun:test";
import {
  composerHighlightHtml,
  composerImageAttachmentRanges,
  needsComposerHighlight,
} from "./composer-highlight";

const reference = "[Image 2 · 12–42% × 20–60%]";

describe("image attachment references in the composer mirror", () => {
  test("paints the full model-readable reference as one inline token", () => {
    expect(composerImageAttachmentRanges(`Fix ${reference} please`)).toEqual([
      {
        start: 4,
        end: 4 + reference.length,
        attachmentIndex: 1,
      },
    ]);
    expect(composerHighlightHtml(`${reference} Fix this`)).toBe(
      `<span class="cmp-image-attachment">${reference}</span> Fix this​`,
    );
  });

  test("turns on the metrics-identical mirror for image references", () => {
    expect(needsComposerHighlight(reference)).toBe(true);
  });
});
