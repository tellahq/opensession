/**
 * Pure selection and formatting helpers for the sticky active user prompt bar
 * shown while scrolling through a long turn in the session transcript.
 */

export interface MeasuredUserPrompt {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
}

const MIN_SCROLL_TOP_PX = 120;
const MIN_TURN_REMAINING_PX = 240;

/**
 * Formats a user message into a concise single-line preview suitable for the
 * sticky turn header.
 */
export function summarizeUserPrompt(raw: string, maxChars = 140): string {
  const withoutQuotes = raw
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith(">"))
    .join(" ");
  const normalized = (withoutQuotes.trim() || raw).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Given viewport-relative user message rects inside the transcript scroll
 * container, returns the id of the user prompt whose response the reader is
 * currently scrolled inside — or null when no prompt has scrolled off-screen
 * or the turn is too short to warrant a sticky header.
 */
export function pickStickyPromptId(params: {
  readonly scrollTop: number;
  readonly containerTop: number;
  readonly containerBottom: number;
  readonly prompts: readonly MeasuredUserPrompt[];
}): string | null {
  const { scrollTop, containerTop, containerBottom, prompts } = params;
  if (scrollTop < MIN_SCROLL_TOP_PX || prompts.length === 0) return null;

  let activeIndex = -1;
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i]!;
    if (p.bottom < containerTop + 8) {
      activeIndex = i;
    } else {
      break;
    }
  }
  if (activeIndex < 0) return null;

  const active = prompts[activeIndex]!;
  const next = prompts[activeIndex + 1];
  // Don't flash the bar right as the next user prompt is about to enter view.
  if (next && next.top - containerTop < MIN_TURN_REMAINING_PX) {
    return null;
  }
  // Ensure there is meaningful content in the viewport below the header.
  if (containerBottom - containerTop < MIN_TURN_REMAINING_PX) {
    return null;
  }
  return active.id;
}
