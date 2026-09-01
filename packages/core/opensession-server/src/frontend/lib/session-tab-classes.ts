import { utilityClassName } from "../ui/cn";
import { MOBILE_CONTROL_GLASS_EFFECTS } from "./app-header-classes";

/**
 * The session tab strip's vocabulary, as finished utility classes. This used
 * to be the `session-tab*` family in legacy.css.
 *
 * Two things shape everything here.
 *
 * 1. Desktop keeps quiet labels separated by short rules. On the phone PWA,
 *    every tab uses the same glass capsule as the top bar, while the active tab
 *    keeps a stronger filled surface.
 *
 * 2. Each tab state carries its whole colour set. A colored tab does not layer
 *    a fill over the plain tab's fill; `tabClass` returns exactly one background
 *    per state. The states stay resolved in JS because the old cascade picked a
 *    winner by rule order, and a stack of utilities cannot reproduce that
 *    reliably.
 *
 * A few class names survive on the markup as bare hooks with no styling of
 * their own, because things OUTSIDE this file name them:
 *
 *   · `session-tabs`: app-shell-classes.ts suppresses the top bar's scroll
 *     divider while the strip overlaps that edge, and SessionSplit sizes the
 *     bar with `[&>.session-tabs]:shrink-0`;
 *   · `session-tab-view` / `session-tab-reorder`: `.app:has(.session-tab-view)
 *     .app-header-overlay` and `.detail-pane:has(.session-tab-reorder ~
 *     .session-tab-reorder)` set the phone header's fill and
 *     `--strip-clearance` on elements that belong to other components.
 *
 * The dots used to be a third pair of hooks, for base.css's reduced-motion
 * exception list; they now carry that exception themselves — see `tabDotClass`.
 */

/** 8px, the compact trailing controls' corner. Authored the way base.css
 * authors every corner; there is no 8px step in the radius scale. */
const PILL = utilityClassName("rounded-[calc(8px*var(--rf))]");
/** Desktop tabs use the standard medium squircle; phones become round pills. */
const TAB_SHAPE = utilityClassName(
  "desktop:rounded-md desktop:[corner-shape:squircle]",
);

/* ── The strip ──────────────────────────────────────────────────────────── */

/**
 * The bar itself. `group/strip` reveals history, which stays quiet until the
 * strip is pointed at. The new-tab + remains visible whenever the strip exists.
 *
 * The old rule painted a `linear-gradient(var(--topbar-bg), var(--bg))` here,
 * but BOTH breakpoints set `background: var(--bg)` over it, so the gradient
 * never reached a screen; the same is true of its 6px/8px padding. Neither is
 * carried over.
 */
export const TAB_STRIP =
  utilityClassName(
    "session-tabs group/strip relative flex min-w-0 shrink-0 items-center gap-[3px] px-2 ",
  ) +
  utilityClassName("desktop:bg-surface phone:bg-transparent ") +
  utilityClassName("phone:pointer-events-none phone:*:pointer-events-auto ") +
  // Every desktop tab bar has one closing hairline. A pseudo-element avoids
  // changing its height. Phones stay borderless so fixed chrome never becomes
  // a grey rule across the screen.
  utilityClassName(
    "desktop:after:pointer-events-none desktop:after:absolute desktop:after:inset-x-0 ",
  ) +
  utilityClassName(
    "desktop:after:bottom-0 desktop:after:h-px desktop:after:bg-divider desktop:after:content-[''] ",
  ) +
  // Desktop: a compact band. The active tab's own surface supplies the
  // selection boundary, so the line closes the bar rather than underlining it.
  //
  // The non-split bar takes its 11px header overlap at the call site. The
  // session header above is a fixed 48px row whose title is centred in it, and
  // the tab labels are centred in this 40px band, so the two words sit far
  // apart while neither box looks generous. Neither row can be trimmed on its
  // own because the header's height lines it up with the sidebar's brand row.
  // The strip closes the distance by climbing into the header's slack. Split
  // bars start at the top of an overflow-clipped column, so their full box stays
  // in flow instead of losing its top edge outside that column.
  utilityClassName("desktop:h-10 desktop:py-0 ") +
  // When overflowing tabs pass under the pinned +, pointing at the control
  // softens enough of the edge to reach the adjacent label. TAB_SCROLL gates
  // the mask itself on data-overflow, so tabs that fit never fade.
  "desktop:[&:has(.session-tab-new:hover)]:[--tabs-control-fade-end:64px] " +
  // Phone: pulled out of flow and pinned flush under the header's bottom edge,
  // so it reads as fixed chrome rather than a strip the transcript scrolls by.
  // The header's scroll-edge blur continues behind these glass controls.
  utilityClassName(
    "phone:absolute phone:inset-x-0 phone:top-[var(--pane-header-h)] phone:z-[6] ",
  ) +
  utilityClassName("phone:m-0 phone:py-[5px] ") +
  // A lone session with no view tabs has nothing to switch between, so the
  // strip is pure chrome on a phone — every tab is a .session-tab-reorder
  // wrapper, so "2+ sessions" reads as two adjacent wrappers.
  "phone:[&:not(:has(.session-tab-view)):not(:has(.session-tab-reorder~.session-tab-reorder))]:hidden";

/**
 * The scrolling half of the strip. Its edge fades are driven by a CSS scroll
 * timeline — no scroll listeners, no re-renders — and are gated on the
 * `data-overflow` attribute the component writes, because a timeline that goes
 * INACTIVE holds its last value instead of reverting.
 */
export const TAB_SCROLL =
  // `flex-[1_1_auto]`, not `flex-1`: Tailwind's shorthand is `1 1 0%`, and a
  // zero basis sizes the scroll from nothing rather than from its tabs.
  // Only split strips become size containers: inline-size containment on the
  // intrinsic-width desktop strip would erase the tabs from its flex basis and
  // collapse the whole scroller. A split instead fills its available width so
  // TAB_BASE can safely use that definite query size.
  utilityClassName(
    "flex min-w-0 flex-[1_1_auto] items-center gap-[3px] overflow-x-auto overscroll-x-contain ",
  ) +
  "data-[split]:[container-type:inline-size] data-[split]:desktop:flex-[1_1_auto] " +
  utilityClassName("[scrollbar-width:none] [&::-webkit-scrollbar]:hidden ") +
  // Hug the content on desktop so the pinned "+" sits right after the last tab
  // rather than being pushed to the far right. The group keeps its intrinsic
  // height so the selected tab floats vertically inside the 40px band.
  utilityClassName("desktop:flex-[0_1_auto] ") +
  "supports-[animation-timeline:scroll()]:[animation:session-tabs-fade-start_1ms_both,session-tabs-fade-end_1ms_both] " +
  "supports-[animation-timeline:scroll()]:[animation-timeline:scroll(self_inline),scroll(self_inline)] " +
  "supports-[animation-timeline:scroll()]:[animation-range:0_24px,calc(100%_-_24px)_100%] " +
  "supports-[animation-timeline:scroll()]:data-[overflow]:[mask-image:linear-gradient(to_right,transparent_0,#000_var(--tabs-fade-start),#000_calc(100%_-_max(var(--tabs-fade-end),var(--tabs-control-fade-end,0px))),transparent_100%)]";

/**
 * The drag-to-reorder group wraps EVERY tab — sessions and view panes alike —
 * so a pane can be dragged in among the sessions. `flex-none` is load-bearing:
 * the tabs inside never shrink, so a group allowed to shrink would collapse
 * below its content and the last tab would paint over whatever the scroll laid
 * out after the shrunken box. Sizing to content pushes the overflow out to the
 * scroll, which is the thing that scrolls.
 */
export const TAB_GROUP = utilityClassName(
  "relative inline-flex flex-none items-center gap-[3px]",
);

/** Each tab's Reorder.Item wrapper. `relative` lets whileDrag's z-index lift
 *  the dragged tab over its siblings. Desktop uses a short rule between quiet
 *  inactive tabs. Phone capsules separate themselves. */
export const TAB_ITEM =
  utilityClassName(
    "session-tab-reorder relative inline-flex shrink-0 items-center ",
  ) +
  utilityClassName("after:pointer-events-none after:absolute after:top-1/2 ") +
  utilityClassName(
    "after:-right-0.5 after:h-3 after:w-px after:-translate-y-1/2 ",
  ) +
  utilityClassName(
    "after:bg-divider after:content-[''] last:after:hidden phone:after:hidden ",
  ) +
  // The active surface supplies both edges. Hide the trailing divider when
  // either this item or its next sibling is active.
  "[&:has(>[aria-selected=true])]:after:hidden data-[next-active]:after:hidden";

/** Picked up: an inactive desktop tab has no surface of its own and would smear
 *  over every label it passes. It lifts into an opaque chip while dragging. */
export const TAB_ITEM_DRAGGING = utilityClassName(
  `${TAB_SHAPE} cursor-grabbing bg-panel smooth-shadow-ring-sm`,
);

/**
 * Where the dragged tab will land. Reorder already opens the gap live, but an
 * empty hole between two bare labels reads as nothing, so this paints a thin
 * insertion rule at the slot's leading edge — a caret, not a second chip
 * competing with the tab in hand. Above the dragged chip on purpose: the chip
 * follows the pointer while the slot snaps to whole positions, so a caret
 * painted underneath would vanish exactly when the order changes.
 */
export const TAB_DROP_SLOT =
  utilityClassName("pointer-events-none absolute inset-y-2 z-[5] ") +
  utilityClassName(
    "[animation:tab-drop-slot-in_var(--dur-micro)_var(--ease)] [transition:left_var(--dur)_var(--ease)] ",
  ) +
  utilityClassName(
    "motion-reduce:animate-none motion-reduce:transition-none ",
  ) +
  utilityClassName(
    "after:absolute after:inset-y-0 after:left-0 after:w-0.5 after:rounded-[1px] after:bg-accent after:content-['']",
  );

/** Trailing controls pinned after the scroll on desktop. */
export const TAB_ACTIONS = utilityClassName(
  "ml-auto flex flex-none items-center gap-[3px]",
);

/* ── A tab ──────────────────────────────────────────────────────────────── */

/**
 * Everything a tab is regardless of state: box, type and the interaction
 * transition. The label was 12px, which is not a step on the type scale; it is
 * interface copy, so it snaps UP to `text-label` (13px) — which is also what
 * the phone rule already set on the title, so the two viewports now agree
 * instead of differing by a pixel.
 */
const TAB_BASE =
  utilityClassName(
    "relative inline-flex max-w-[min(200px,100cqw)] shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap ",
  ) +
  utilityClassName(
    `${TAB_SHAPE} border-0 px-2.5 py-1.5 text-label shadow-none `,
  ) +
  utilityClassName("transition-[background-color,color] ") +
  utilityClassName(
    `phone:rounded-full phone:border phone:border-[color:var(--mobile-header-control-border)] `,
  ) +
  `phone:shadow-[var(--mobile-header-control-shadow)] ${MOBILE_CONTROL_GLASS_EFFECTS}`;

export type TabState = {
  active: boolean;
  waiting: boolean;
  /** A user-chosen swatch, supplied inline as `--tab-color`. */
  colored: boolean;
};

/**
 * The selected tab is the only ordinary desktop tab with a surface. Phone tabs
 * are all glass: the selected one is the bright plate, the rest a dimmer wash.
 * Custom colours stay visible as an explicit exception, but use a quieter mix
 * while inactive.
 */
export function tabClass(state: TabState): string {
  const { active, waiting, colored } = state;
  const ink =
    active || waiting
      ? utilityClassName("text-fg")
      : utilityClassName("text-dim hover:text-fg");
  const surface = colored
    ? active
      ? utilityClassName(
          "bg-[color-mix(in_srgb,var(--tab-color)_22%,var(--bg-panel))] ",
        ) +
        utilityClassName(
          "hover:bg-[color-mix(in_srgb,var(--tab-color)_28%,var(--bg-panel))] ",
        ) +
        utilityClassName(
          "phone:bg-[color-mix(in_srgb,var(--tab-color)_22%,var(--mobile-tab-surface-selected))]",
        )
      : utilityClassName(
          "bg-[color-mix(in_srgb,var(--tab-color)_9%,transparent)] ",
        ) +
        utilityClassName(
          "hover:bg-[color-mix(in_srgb,var(--tab-color)_16%,transparent)] ",
        ) +
        utilityClassName(
          "phone:bg-[color-mix(in_srgb,var(--tab-color)_9%,var(--mobile-tab-surface))]",
        )
    : active
      ? utilityClassName(
          "bg-panel hover:bg-hover phone:bg-[var(--mobile-tab-surface-selected)]",
        )
      : utilityClassName(
          "bg-transparent hover:bg-hover phone:bg-[var(--mobile-tab-surface)]",
        );

  return `${TAB_BASE} ${ink} ${surface}`;
}

/** The label uses the close control's space while the tab is idle. Hovering
 *  reveals close over the title, with a wider fade keeping both legible. */
export const TAB_TITLE =
  utilityClassName(
    "session-tab-title block min-w-0 max-w-[150px] overflow-hidden ",
  ) +
  "data-[overflow]:[mask-image:linear-gradient(to_right,#000_0,#000_calc(100%_-_10px),transparent_100%)] " +
  utilityClassName("desktop:max-w-[166px] ") +
  "desktop:group-hover/tab:[mask-image:linear-gradient(to_right,#000_0,#000_calc(100%_-_36px),transparent_100%)] " +
  "desktop:group-focus-within/tab:[mask-image:linear-gradient(to_right,#000_0,#000_calc(100%_-_36px),transparent_100%)]";

/** An icon-only view tab (Staging → a globe): drop the label's text metrics so
 *  the tab sizes to the glyph. */
export const TAB_VICON = utilityClassName(
  "inline-flex items-center justify-center leading-none",
);

/** Unsent draft in a sibling session. The title already reserves 14px for the
 * close control, so the pencil uses that room on hover instead of sitting
 * underneath the control as it appears. */
export const TAB_DRAFT =
  utilityClassName("inline-flex flex-none items-center text-dim ") +
  "[@media_(hover:hover)_and_(pointer:fine)]:transition-transform " +
  "[@media_(hover:hover)_and_(pointer:fine)]:group-hover/tab:-translate-x-3.5 " +
  "[@media_(hover:hover)_and_(pointer:fine)]:group-focus-within/tab:-translate-x-3.5 " +
  utilityClassName("motion-reduce:transition-none");

/**
 * Teammates who have THIS tab open. The sidebar answers "someone is in this
 * workspace"; a workspace is a strip of tabs, so the strip is where that
 * answers "which one".
 *
 * The faces sit in a row with a small gap rather than an overlapping pile:
 * a pile needs a gap ring painted in the surface behind it, and a tab has
 * five of those (plain, hover, active, waiting, coloured, and none of them on
 * desktop, where the tab is flat on the strip). Two faces plus a count is
 * also all a 200px tab has room for.
 */
export const TAB_FACES = utilityClassName(
  "flex flex-none items-center gap-0.5",
);

/** One face. Small enough to read as a marker beside the label, not a
 *  participant list. */
export const TAB_FACE = utilityClassName("shrink-0");

/** "+2" when more people are here than the strip shows faces for. */
export const TAB_FACES_MORE = utilityClassName(
  "text-meta leading-none text-dim",
);

/** Inline rename input, sized to sit in place of the title. */
export const TAB_RENAME = utilityClassName(
  "my-[-1px] max-w-[150px] rounded-xs border border-accent bg-surface px-[3px] font-[inherit] text-[inherit] outline-none",
);

/* ── Liveness dots ──────────────────────────────────────────────────────── */

/**
 * The running / needs-you dot. "Needs you" is blue throughout — the sidebar
 * already resolved it that way.
 *
 * base.css's reduced-motion block kills every animation with `!important` and
 * then hands a handful of liveness signals back BY CLASS NAME — these two dots
 * among them. That list is the one thing a migration can break silently: the
 * rule stays valid, it just stops matching, and the "still running" pulse
 * freezes for anyone with the preference set with nothing to detect it. So the
 * exception rides the element instead of the list, where it travels with the
 * component; it wins on equal specificity because the utility sheet is linked
 * last, and `!` matches the block it is arguing with.
 *
 * `pulse` is defined by BOTH legacy.css and the utility sheet, and keyframes
 * don't cascade by specificity: the later definition wins document-wide, so
 * every legacy `animation: pulse` has in fact been running the utility sheet's
 * 1 → 0.5 fade rather than the authored 1 → 0.35. Naming the same keyframes
 * here keeps exactly what ships; this is not the place to change it.
 */
const DOT_BASE = utilityClassName("size-1.5 shrink-0 rounded-full");

export const tabDotClass = (waiting: boolean) =>
  waiting
    ? `${DOT_BASE} bg-blue shadow-[0_0_6px_var(--blue)] animate-[pulse_1.2s_ease-in-out_infinite] ` +
      "motion-reduce:[animation-duration:1.2s]! motion-reduce:[animation-iteration-count:infinite]!"
    : `${DOT_BASE} bg-yellow animate-[pulse_1.4s_ease-in-out_infinite] ` +
      "motion-reduce:[animation-duration:1.4s]! motion-reduce:[animation-iteration-count:infinite]!";

/** A view tab's status dot (PR state). Shared with the right panel's tabs,
 *  which render the same mark. The caller adds the tone's fill. */
export const PANEL_TAB_DOT = utilityClassName("size-[7px] rounded-full");

/**
 * What that dot means on a Review view-tab: the PR's state, plus the conflict
 * case, which is a mergeability flag rather than a state of its own.
 *
 * A lookup of literal strings because the old spelling was
 * `` `pr-dot-${prState.toLowerCase()}` `` — a class assembled at runtime, which
 * no utility can ever be (Tailwind only compiles names it can find in source).
 * Same tones the rule set, and the same ones lib/sidebar-hover gives these
 * states in the row hover cards.
 */
export const PR_DOT_TONE: Record<string, string> = {
  OPEN: utilityClassName("bg-green"),
  MERGED: utilityClassName("bg-purple"),
  CLOSED: utilityClassName("bg-red"),
  CONFLICT: utilityClassName("bg-yellow"),
};

/* ── Per-tab close, and the trailing controls ───────────────────────────── */

const CLOSE_BASE =
  utilityClassName(
    "-my-0.5 -mr-[3px] inline-flex size-4 shrink-0 cursor-pointer items-center justify-center ",
  ) +
  utilityClassName("rounded-sm border-0 bg-transparent p-0 text-dim ") +
  utilityClassName(
    "hover:bg-pressed hover:text-fg [@media_(hover:none)]:size-[26px] [@media_(hover:none)]:-mr-1",
  );

/** Desktop close controls share one absolute position, so revealing one never
 * changes its width and never asks Motion to shuffle every sibling. */
const CLOSE_OVERLAY_POSITION =
  "[@media_(hover:hover)_and_(pointer:fine)]:absolute " +
  "[@media_(hover:hover)_and_(pointer:fine)]:right-1 [@media_(hover:hover)_and_(pointer:fine)]:top-1/2 " +
  "[@media_(hover:hover)_and_(pointer:fine)]:z-[1] [@media_(hover:hover)_and_(pointer:fine)]:m-0 " +
  "[@media_(hover:hover)_and_(pointer:fine)]:-translate-y-1/2 " +
  "[@media_(hover:hover)_and_(pointer:fine)]:transition-opacity";

const CLOSE_OVERLAY_HIDDEN =
  "[@media_(hover:hover)_and_(pointer:fine)]:pointer-events-none " +
  "[@media_(hover:hover)_and_(pointer:fine)]:opacity-0 " +
  "[@media_(hover:hover)_and_(pointer:fine)]:group-hover/tab:pointer-events-auto " +
  "[@media_(hover:hover)_and_(pointer:fine)]:group-hover/tab:opacity-100 " +
  "[@media_(hover:hover)_and_(pointer:fine)]:focus-visible:pointer-events-auto " +
  "[@media_(hover:hover)_and_(pointer:fine)]:focus-visible:opacity-100";

/** Phones have no hover, so close stays in flow with a finger-sized hit area. */
const CLOSE_TOUCH = utilityClassName("size-[26px] -mr-1");

export const tabCloseClass = (phone: boolean) =>
  `${CLOSE_BASE} ${phone ? CLOSE_TOUCH : `${CLOSE_OVERLAY_POSITION} ${CLOSE_OVERLAY_HIDDEN}`}`;

/**
 * The trailing controls use quiet chrome with no pill fill or shadow. History
 * reveals with the strip, on focus, and while its menu is open.
 */
const CTRL_REVEAL =
  "[@media_(hover:hover)_and_(pointer:fine)]:pointer-events-none " +
  "[@media_(hover:hover)_and_(pointer:fine)]:opacity-0 " +
  "[@media_(hover:hover)_and_(pointer:fine)]:transition-opacity " +
  "[@media_(hover:hover)_and_(pointer:fine)]:group-hover/strip:pointer-events-auto " +
  "[@media_(hover:hover)_and_(pointer:fine)]:group-hover/strip:opacity-100 " +
  "[@media_(hover:hover)_and_(pointer:fine)]:focus-visible:pointer-events-auto " +
  "[@media_(hover:hover)_and_(pointer:fine)]:focus-visible:opacity-100 " +
  "[@media_(hover:hover)_and_(pointer:fine)]:data-[menu-open]:pointer-events-auto " +
  "[@media_(hover:hover)_and_(pointer:fine)]:data-[menu-open]:opacity-100 " +
  "[@media_(hover:hover)_and_(pointer:fine)]:data-[popup-open]:pointer-events-auto " +
  "[@media_(hover:hover)_and_(pointer:fine)]:data-[popup-open]:opacity-100";

const CTRL_BASE =
  utilityClassName(
    "inline-flex min-h-[36px] shrink-0 cursor-pointer items-center whitespace-nowrap ",
  ) +
  utilityClassName(
    `border border-transparent bg-transparent px-3.5 py-1.5 ${PILL} `,
  ) +
  utilityClassName(
    "font-[inherit] leading-none text-dim transition-[background-color,color] ",
  ) +
  utilityClassName("hover:bg-hover hover:text-fg");

/** Desktop trailing controls match the tabs' 28px box and medium radius. */
const CTRL_DESKTOP = utilityClassName(
  "desktop:size-7 desktop:min-h-auto desktop:self-center desktop:rounded-md desktop:p-0",
);

/**
 * New-tab "+". Always visible once there is a strip, so adding a sibling does
 * not depend on discovering a hover state. It keeps a comfortable square hit
 * area on touch and matches the tabs on desktop.
 */
export const TAB_NEW = utilityClassName(
  `session-tab-new ${CTRL_BASE} ${CTRL_DESKTOP} justify-center text-[15px] desktop:text-[22px]`,
);

/**
 * Archived-sessions menu. Same desktop footprint as the "+" it sits beside:
 * the two are one pair of quiet square controls after the last tab. Stays lit
 * while its menu is open (`data-popup-open`).
 */
export const TAB_HISTORY =
  utilityClassName(`${CTRL_BASE} ${CTRL_DESKTOP} justify-center `) +
  "data-[popup-open]:bg-hover data-[popup-open]:text-fg " +
  CTRL_REVEAL;

/* ── Tab colour swatches ─────────────────────────────────────────────────────
   The row of colour chips in a tab's context menu. Each chip carries its colour
   as an inline style (the palette is data, see lib/tab-colors), so what's left
   here is the ring, the box and the grow-on-hover.

   `rounded-full` is right on these and only these: the rule spelled a bare
   `border-radius: 50%` with no `corner-shape`, so a chip is a true circle
   rather than one of the app's squircles. The hairline stays the untokenized
   15% white it has always been — it reads as a highlight on a saturated chip,
   not as a chrome border, so `border-line` would be a visual change rather
   than a translation. */
export const TAB_SWATCH = utilityClassName(
  "size-[22px] rounded-full border border-[rgba(255,255,255,0.15)] transition-transform hover:scale-[1.18]",
);

/** The chip for the colour the tab currently wears: a ring in the page ink,
 *  gapped off the chip by the panel it sits on. */
export const TAB_SWATCH_ON =
  "shadow-[0_0_0_2px_var(--bg-panel),0_0_0_3px_var(--text)]";

/** The "no colour" chip: an empty ring with a diagonal strike. */
export const TAB_SWATCH_NONE =
  utilityClassName(
    "relative bg-active after:absolute after:inset-[3px] after:rotate-45 after:border-t ",
  ) + utilityClassName("after:border-t-faint after:content-['']");
