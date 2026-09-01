import { utilityClassName } from "../ui/cn";
/**
 * The session's right-hand workspace panel, as finished utility classes — what
 * used to be the `panel-*` family in legacy.css.
 *
 * The panel is one surface with two shapes: a resizable column beside the
 * transcript on desktop, and a fixed overlay column from 920px down. Both the
 * shell (PANEL_SHELL, shared with WorkspacePane's standing info panel) and the
 * contents — drag handle, tab strip, body, sheet head — live here.
 *
 * It had a third shape, a full-width bottom sheet on phones, and that is gone
 * rather than migrated: neither call site renders below 720px. See PANEL_SHELL
 * for what was measured before dropping it.
 *
 * Two conventions carried over from lib/pr-tone-classes.ts, for the same
 * reasons: a state carries its whole colour set rather than layering one over
 * another (Tailwind resolves same-property collisions by its own output order),
 * and anything that used to be an ancestor-keyed override is an arbitrary
 * variant on the element itself.
 */

/**
 * The panel shell itself — a resizable column beside the transcript, and a
 * fixed overlay column from 920px down. Both of its call sites (SessionViewer's
 * workspace panel and WorkspacePane's standing info panel) render it.
 *
 * `viewer-panel` stays on the markup as a bare hook: lib/pr-tone-classes.ts
 * reaches into it with `[.viewer-panel_&]` to size the PR strip inside the
 * panel, which is a rule about a descendant of an element this file doesn't
 * own.
 *
 * The width is the drag handle's to set — PANEL_RESIZE writes `--panel-w` — so
 * the shell only names the fallback and the bounds. The cap reserves the left
 * sidebar plus a readable session column rather than a fixed pixel width:
 * reviewing code wants real width on a wide display.
 *
 * The fallback is 32% of the pane, which at 1440 gives the transcript a little
 * over twice the panel's width. It was 40%, and at that share the panel read as
 * a second content column rather than a companion to one: most of what it holds
 * is a short Info list, so the extra width came out of the transcript and was
 * spent on empty surface. Anyone who wants the old share drags the handle once
 * and their own width is stored.
 *
 * It paints `bg-panel-surface`, four units off white rather than the tier below
 * it that `bg-raised` gave (#f6f6f6 against a white page): at column height
 * that was a wall of grey next to the content, and the largest flat area in the
 * window whenever the Info tab was short. The panel is a second column of the
 * same page rather than chrome over it, so it sits a shade off the page and
 * lets its seam do the dividing, exactly as the sidebar does on the other side.
 *
 * It also re-points `--bg-panel` at `--panel-plate`, which is the whole reason
 * the sections inside it are not addressed one by one: five or six plates stack
 * down one narrow column, and the page's plate strength repeated that many
 * times reads as a pile of blocks rather than a list of sections. Every
 * `bg-panel` in the subtree steps together instead: the Info sections, the
 * selected tab pill, the Portals cards, the avatar rings that ring themselves
 * in `var(--bg-panel)`.
 *
 * There is deliberately no phone shape here, though the old sheet had one (a
 * full-width bottom sheet: rounded top, `sheet-up` animation, its own shadow).
 * Neither call site renders on a phone — both are gated on `!isPhone`, and the
 * content is reached there as a full-width view tab instead (`session-tab-view`
 * → VIEWER_REVIEW_MAIN). Measured before removing it: at 390px no
 * `.viewer-panel` element exists on either a session or a workspace route, and
 * the toggle that would open one isn't rendered either. Reviving the phone
 * sheet means reviving that JSX first; its styling is not carried here as
 * decoration.
 */
export const PANEL_SHELL =
  utilityClassName(
    "viewer-panel @container relative flex min-h-0 w-[var(--panel-w,32%)] min-w-[320px] shrink-0 flex-col ",
  ) +
  utilityClassName(
    "max-w-[max(480px,calc(100vw-620px))] border-l border-divider bg-panel-surface [--bg-panel:var(--panel-plate)] ",
  ) +
  // From 920px down it stops being a column in the layout and becomes an
  // overlay over the session, anchored under the top bar (--header-h is 0 on
  // desktop, the bar's height on a phone) with PANEL_OVERLAY dimming behind it.
  utilityClassName(
    "max-[920px]:fixed max-[920px]:top-[var(--header-h)] max-[920px]:right-0 max-[920px]:bottom-0 ",
  ) +
  utilityClassName(
    "max-[920px]:z-30 max-[920px]:w-[min(480px,94vw)] max-[920px]:max-w-none max-[920px]:min-w-0 ",
  ) +
  "max-[920px]:shadow-[-12px_0_32px_rgba(0,0,0,0.5)]";

/**
 * Left-edge drag handle — the mirror of the sidebar's. The hairline it paints
 * is a ::after inset from the handle's own box, so the grab area is wider than
 * the line without taking layout width. Hidden on phones, where the panel is a
 * sheet with nothing to drag.
 *
 * The hover paint is scoped to `body:not(.resizing-panel)` rather than left to
 * compete with the dragging paint: during a drag the pointer is also hovering,
 * and which of two same-property utilities wins is Tailwind's output order,
 * not the order they are written. The old sheet resolved it by specificity
 * (0,3,0 over 0,2,0); this makes the two states mutually exclusive instead.
 */
export const PANEL_RESIZE =
  utilityClassName(
    "absolute top-0 left-[-3px] z-[6] h-full w-[7px] cursor-col-resize phone:hidden ",
  ) +
  utilityClassName(
    "after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:bg-transparent ",
  ) +
  utilityClassName("after:transition-[background-color] after:content-[''] ") +
  "[body:not(.resizing-panel)_&]:hover:after:bg-line-strong " +
  "[body.resizing-panel_&]:after:bg-faint";

/**
 * The PR strip's plate at the top of the panel.
 *
 * The strip used to run edge to edge with a hairline under it, which made it
 * chrome bolted to the panel's top rather than part of the column. It is a
 * plate now: the same corner as every section under it (`rounded-lg`, matching
 * INFO_LIST_CLASS), so it reads as the first element of the info column instead
 * of a band across it.
 *
 * The margin is the column's own padding rather than a value of its own. The
 * sections below sit 12px off the panel's edges (WorkspaceInfo's `px-2` inside
 * the `px-1` wrapper its two panel call sites give it) and open 12px under the
 * plate (its `pt-3`), so the plate takes the same 12px above and beside it. One
 * padding all the way round the content, not a tighter frame at the top than
 * the gap to the first section.
 *
 * The inset and the corner live here rather than on the strip because only this
 * call site wants them — on a phone the same strip is a row inside the session
 * info card, which supplies its own edge. The clip is what lets a session with
 * several PRs keep its series rows inside the corner: the stack renders as one
 * plate, not a plate followed by loose rows.
 */
export const PANEL_PR_PLATE =
  // `panel-pr-plate` is a hook, not styling: PANEL_INFO_TOP below reads it to
  // tell a column that opens under this plate from one that opens alone.
  "panel-pr-plate " +
  // `empty:hidden` because the strip renders nothing on a session with no pull
  // request to report (see PrStatusBar): the plate is a wrapper, so without it
  // the column would still pay this margin for a row that isn't there.
  utilityClassName("mx-3 mt-3 overflow-hidden rounded-lg empty:hidden");

/**
 * The info column's own top padding, on top of WorkspaceInfo's 12px.
 *
 * With the plate above it the column opens 12px under a filled surface, the
 * same padding it takes on every other side. On a session with no pull request
 * the strip collapses, and the column's first element is then a bare "Review"
 * label sitting that same 12px off the panel's top edge. A small label needs
 * more air above it than a plate does, so the column opens lower when it stands
 * alone and keeps the matched 12px when it doesn't.
 */
export const PANEL_INFO_TOP = utilityClassName(
  "pt-2 [.panel-pr-plate:not(:empty)~*_&]:pt-0",
);

/** The panel's scrolling content. */
export const PANEL_BODY = utilityClassName("min-h-0 flex-1 overflow-y-auto");

/**
 * The panel's standing tab strip: the places this workspace can open, on one
 * line above their content. It sits outside PANEL_BODY so it stays put while
 * the selected page scrolls, and its bottom rule separates chrome from page.
 */
export const PANEL_TABS = utilityClassName(
  "flex h-[var(--desktop-header-h)] shrink-0 items-center gap-1 border-b border-divider px-2",
);

/** One tab: an icon, a word, and whatever that destination wants to report. */
export const PANEL_TAB =
  utilityClassName(
    "focus-ring flex min-w-0 items-center gap-1.5 rounded-control px-2 py-1 ",
  ) +
  utilityClassName(
    "text-label text-dim transition-colors hover:bg-hover hover:text-fg ",
  ) +
  "@max-[380px]:flex-1 @max-[380px]:justify-center @max-[380px]:px-1";

/**
 * The scrim behind the panel once it stops being a column and starts being an
 * overlay. It only exists from 920px down; above that the panel sits in the
 * layout and dims nothing.
 */
export const PANEL_OVERLAY =
  utilityClassName("hidden ") +
  utilityClassName(
    "max-[920px]:fixed max-[920px]:inset-[var(--header-h)_0_0_0] max-[920px]:z-[25] ",
  ) +
  utilityClassName("max-[920px]:block max-[920px]:bg-[rgba(0,0,0,0.45)] ") +
  utilityClassName("phone:inset-0 phone:z-[45] phone:bg-[rgba(0,0,0,0.5)]");
