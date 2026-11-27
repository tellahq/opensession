/**
 * Pure selection logic for the wide-screen floating "Looking at" image PiP.
 *
 * When a reader scrolls past an image (user attachment or agent screenshot) on
 * a wide pane while reading commentary below it, keeps the most recently passed
 * image pinned cleanly in the right gutter — never overlapping the reading
 * column and never duplicating an image that is still visible on screen.
 */

export interface MeasuredTranscriptImage {
  readonly src: string;
  readonly alt: string;
  readonly top: number;
  readonly bottom: number;
}

export const PIP_MIN_CONTAINER_WIDTH_PX = 1140;
const MIN_SCROLL_TOP_PX = 120;

export function pickLookingAtImage(params: {
  readonly containerWidth: number;
  readonly containerTop: number;
  readonly containerBottom: number;
  readonly scrollTop: number;
  readonly images: readonly MeasuredTranscriptImage[];
}): MeasuredTranscriptImage | null {
  const { containerWidth, containerTop, containerBottom, scrollTop, images } =
    params;
  if (
    containerWidth < PIP_MIN_CONTAINER_WIDTH_PX ||
    scrollTop < MIN_SCROLL_TOP_PX ||
    images.length === 0
  ) {
    return null;
  }

  // If any image is currently visible inside the viewport, don't show a PiP.
  const anyVisible = images.some(
    (img) => img.bottom > containerTop + 16 && img.top < containerBottom - 16,
  );
  if (anyVisible) return null;

  // Pick the most recent image scrolled completely above the viewport.
  let passed: MeasuredTranscriptImage | null = null;
  for (const img of images) {
    if (img.bottom <= containerTop + 16) {
      passed = img;
    } else {
      break;
    }
  }
  return passed;
}
