import { z } from "zod";

// The sidebar's chords themselves live in lib/shortcuts, which is where every
// rebindable command is declared and where the keycaps to advertise come from
// (shortcutKeys / useShortcutKeys). What stays here is the touch behaviour of
// a sidebar row, plus the focus rules those chords apply: whether a focused
// text field keeps the key for itself is per chord, not one blanket rule.

const EDITABLE =
  "input, textarea, select, [contenteditable='true'], [contenteditable='']";

interface ClosestTarget extends EventTarget {
  closest(selectors: string): EditableElement | null;
}

interface EditableElement {
  classList: { contains(name: string): boolean };
  value?: string;
}

const callablePropertySchema = z.object({
  closest: z.instanceof(Function),
});
const editableElementContract = z.object({
  classList: z.object({ contains: z.instanceof(Function) }),
  value: z.string().optional(),
});
const closestTargetSchema = z.custom<ClosestTarget>(
  (value) => callablePropertySchema.safeParse(value).success,
);
const editableElementSchema = z.custom<EditableElement>(
  (value) => editableElementContract.safeParse(value).success,
);

function editableAncestor(target: EventTarget | null): EditableElement | null {
  const owner = closestTargetSchema.safeParse(target);
  if (!owner.success) return null;
  const editable = editableElementSchema.safeParse(
    owner.data.closest(EDITABLE),
  );
  return editable.success ? editable.data : null;
}

/** True when an editable element owns focus and should keep the archive
 * chords for itself. The main composer textarea is exempt: it autofocuses on
 * every session open, which left the advertised ⌘E dead almost all the time,
 * and the chord types nothing, so firing there only costs the browser's niche
 * find-selection default. Rename fields, search boxes, etc. keep the guard. */
export function editableSwallowsArchiveChord(
  target: EventTarget | null,
): boolean {
  const editable = editableAncestor(target);
  return !!editable && !editable.classList.contains("composer-textarea");
}

/** True when an editable element owns focus and the chord is one the field
 * itself answers: ⌘↑/⌘↓ put the caret at the start and end of the text. A
 * draft is exactly where those moves are worth keeping, so every field claims
 * them, with one carve-out: an EMPTY composer, where the caret has nowhere to
 * go and the keypress does nothing either way.
 *
 * That carve-out is what keeps workspace cycling reachable. The composer is
 * where focus tends to sit (opening a workspace aims it there, ⌃R puts it
 * there, a new session in the workspace takes it), so claiming the chord
 * unconditionally would leave ⌘↑/⌘↓ dead in the place people press it from.
 * The moment there is text to move through, the caret wins. */
export function editableOwnsCaretChord(target: EventTarget | null): boolean {
  const editable = editableAncestor(target);
  if (!editable) return false;
  if (!editable.classList.contains("composer-textarea")) return true;
  return !!editable.value?.length;
}

// Long-press (touch) tuning for the mobile action sheet.
export const LONG_PRESS_MS = 450; // hold before the sheet opens
export const LONG_PRESS_SLOP = 10; // px of finger travel that cancels it (a scroll)
export const SWIPE_REVEAL_PX = 82;
export const SWIPE_OPEN_THRESHOLD = 36;
export const SWIPE_FULL_RATIO = 0.45;
export const SWIPE_COMMIT_MS = 210;
export const SWIPE_AXIS_LOCK_PX = 8;

export type SwipeAction = "archive" | "star";
export type SwipeState = { key: string; offset: number; action?: SwipeAction };

export function swipeActionForOffset(offset: number): SwipeAction | null {
  return offset < 0 ? "archive" : offset > 0 ? "star" : null;
}

export function clampSwipe(dx: number, rowWidth: number): number {
  const limit = Math.max(SWIPE_REVEAL_PX, rowWidth);
  return Math.max(-limit, Math.min(limit, dx));
}

export function fullSwipeThreshold(rowWidth: number): number {
  const usableWidth = Math.max(SWIPE_REVEAL_PX, rowWidth - 28);
  return Math.min(
    Math.max(SWIPE_REVEAL_PX * 1.8, rowWidth * SWIPE_FULL_RATIO),
    usableWidth,
  );
}

export function swipeCommitOffset(
  action: SwipeAction,
  rowWidth: number,
): number {
  return action === "archive" ? -rowWidth : rowWidth;
}
