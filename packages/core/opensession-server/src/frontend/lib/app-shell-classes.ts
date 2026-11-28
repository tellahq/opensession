import type { Route } from "./app-route";

/**
 * The application shell, as finished utility classes — what used to be
 * `.app-body`, `.workspace-shell`, `.detail-pane` and `.detail-topbar` in
 * legacy.css.
 *
 * These four are one object, not four components, and they had to move
 * together: every interesting rule in the family was keyed off an ancestor
 * (`.app-body.sidebar-collapsed .workspace-shell`,
 * `.app:not(:has(.app-header-overlay)) .detail-pane`,
 * `.detail-topbar:has(+ .session-tabs) .detail-topbar-title`), and a compound
 * legacy selector outranks a single utility — so migrating any one of them
 * alone would have left the others quietly winning their old values.
 *
 * The shell also has two complete layouts rather than one with tweaks. On
 * desktop it is two flush columns: the sidebar, then the workspace filling the
 * rest of the window, with a hairline seam and, in light, a soft shadow falling
 * back onto the sidebar. On phones the
 * outer box DISSOLVES — `.workspace-shell` was `display: contents`
 * — and the pane becomes an iOS-style page stack, absolutely positioned and
 * slid in from the right over the sidebar. The desktop form is unprefixed and
 * the phone form overrides it, because Tailwind emits every breakpoint variant
 * after every unprefixed utility.
 *
 * Three class names stay on the markup as bare hooks with no styling of their
 * own, because things outside this file name them:
 *
 *   · `app-body` + `sidebar-collapsed` — base.css hides the WCO nav pane with
 *     `.app-body.sidebar-collapsed .detail-pane .wco-nav-pane`, and
 *     lib/session-viewer-classes.ts insets the session header from the
 *     floating re-open control with `[.app-body.sidebar-collapsed_&]`;
 *   · `detail-pane` — the same base.css rule, and lib/session-tab-classes.ts
 *     reads `--strip-clearance` off `.detail-pane:has(.session-tab-reorder ~
 *     .session-tab-reorder)`;
 *   · `detail-topbar` / `detail-topbar-title` — base.css insets the title past
 *     the traffic lights and the floating nav cluster when the desktop sidebar
 *     is collapsed, a rule about an element in a platform state that cannot be
 *     a utility. The title row also wears `wco-chrome`, the one name that makes
 *     a top-of-pane row draggable in the desktop shell.
 *
 * `workspace-shell`, `right-panel-slot`, `turn-spacer` and `reviews` named
 * nothing outside their own rules, so those names are gone from the markup
 * entirely.
 */

/**
 * The row under the top bar: sidebar + workspace. Desktop paints the shared
 * chrome material here so the sidebar sits on it, and an opaque sticky header
 * scrolls over the same colour instead of revealing a seam. Phones get the
 * page stack's positioning context instead, and the plain page colour.
 */
export const APP_BODY =
  "app-body flex min-h-0 flex-1 bg-sidebar " +
  "desktop:[background:linear-gradient(var(--sidebar-material),var(--sidebar-material)),var(--sidebar-bg)] " +
  "phone:relative phone:overflow-hidden phone:bg-surface";

/**
 * The detail pane and its optional right panel as one object, flush to the
 * window: the workspace takes every pixel the sidebar leaves, and the only
 * thing between the two is the seam and, in light, a subtle shadow on its left
 * edge. No gutter and no corner: the shadow only gives the sidebar a little
 * depth against the workspace without turning the seam into a raised card
 * edge. `--content-edge-shadow` is `none` in dark, where a black cast on a
 * near-black column reads as a smudge rather than depth.
 *
 * `display: contents` on phones is load-bearing rather than tidy: dissolving
 * the box restores `.detail-pane` and the fixed panel portal to the layout
 * relationship their mobile positioning rules expect.
 */
/**
 * The new layout's window row is 36px, not 48: it holds tabs and a few
 * controls, and the sheet under it is where the room should go. Set on the
 * boxes beside the minibar because the variable is read all through them.
 *
 * The desktop shell's row is set by its traffic lights, which centre on the
 * sidebar's row beside them: 48px in a shell that cannot move them ((48 - 12)
 * / 2 in its main.js), and 44px in one that can (`titlebar-follows-row`, set
 * in index.html; PaneTopRow reports the height), 2px higher and no further,
 * so the lights keep their room at the window's corner.
 */
export const NEW_LAYOUT_ROW_HEIGHT =
  "[html:not(.wco)_[data-minibar]~&]:[--desktop-header-h:36px] " +
  "[html.wco_[data-minibar]~&]:[--desktop-header-h:48px] " +
  "[html.wco.titlebar-follows-row_[data-minibar]~&]:[--desktop-header-h:44px]";

/** The sidebar row a shell that can move its lights centres them on. */
export const NEW_LAYOUT_LIGHTS_ROW_PX = 44;

/**
 * The workspace's share of the row in the desktop shell: 4px shorter than the
 * sidebar's row beside the lights (44px, or 40px once the lights can move up).
 * Its labels and icons keep to the lights' line by sitting `--row-drop` lower
 * than the row's middle, so the tabs start nearer the window's top and the
 * sheet starts higher.
 */
const NEW_LAYOUT_PANE_ROW =
  "[html:not(.wco)_[data-minibar]~&]:[--desktop-header-h:36px]" +
  " [html.wco_[data-minibar]~&]:[--desktop-header-h:44px]" +
  " [html.wco.titlebar-follows-row_[data-minibar]~&]:[--desktop-header-h:40px]" +
  " [html.wco_[data-minibar]~&]:[--row-drop:4px]";

/**
 * The new layout's window row over the pane: the tab strip, then the page's
 * header. It is the grey of the minibar and the sidebar, and the panel under
 * it starts at this row's bottom edge. That edge is the top of the panel's
 * outline (WORKSPACE_SHELL), which the active tab covers.
 * `components/shell/PaneTopRow.tsx` renders it. Hidden while it holds nothing,
 * on a page that brings a bar of its own. Over the desktop shell's translucent
 * material it paints nothing, so the window shows through it as it does
 * through the minibar and the sidebar beside it.
 */
export const PANE_TOP_ROW =
  "relative flex min-w-0 shrink-0 items-stretch bg-sidebar [html.material-backdrop_&]:bg-transparent " +
  "[&:not(:has(>:not(:empty)))]:hidden " +
  // The header's controls keep to the lights' line (NEW_LAYOUT_PANE_ROW).
  "[&_.wco-chrome]:pt-[var(--row-drop,0px)]";

/**
 * The new layout's window-row controls beside the minibar: the sidebar
 * toggle, the bell, back, forward and search. One size whether the sidebar
 * is open or closed, so the toggle does not grow when it is the only thing
 * left in the row (NEW_LAYOUT_SIDEBAR_REOPEN). A 30px box with 22px glyphs,
 * a step up from the pane's own 28px controls: these are the window's
 * navigation, not one session's actions.
 */
export const NEW_LAYOUT_CHROME_CONTROLS =
  "[&_:is(button,a)]:size-7.5 [&_:is(button,a)]:min-h-7.5 [&_:is(button,a)]:p-0 [&_svg]:size-[22px]";

/** The sidebar toggle while the sidebar is closed, at the size and the spot
 *  it has in the open sidebar's row (NEW_LAYOUT_CHROME_CONTROLS). */
export const NEW_LAYOUT_SIDEBAR_REOPEN =
  "new-layout:top-[calc((var(--desktop-header-h)-30px+var(--row-drop,0px))/2)] new-layout:size-7.5 new-layout:[&_svg]:size-[22px]";

/** The strip's share of that row. The strip brings its own room at each end.
 *  With the sidebar collapsed, the floating re-open control sits over the
 *  row's first 48px. The desktop shell adds its navigation cluster there and
 *  insets further (base-platform.css). */
export const PANE_TOP_ROW_TABS =
  "flex min-w-0 flex-1 items-stretch [.app-body.sidebar-collapsed_&]:pl-10";

export const WORKSPACE_SHELL =
  // Above the sidebar's pinned labels (z 20), so their scroll-under washes
  // cannot cut the shadow. The resize grabber stays above both at z 30.
  "relative z-shell-pane flex min-h-0 min-w-0 flex-1 overflow-hidden border-l border-divider bg-surface desktop:[box-shadow:var(--content-edge-shadow)] " +
  // Collapsed sidebar: nothing to divide from or cast depth onto.
  "[.app-body.sidebar-collapsed_&]:border-l-0 [.app-body.sidebar-collapsed_&]:[box-shadow:none] " +
  // The new layout: the minibar, the sidebar and the window row are one grey
  // chrome, and the workspace is the only panel on it. A quiet one: a
  // hairline outline, a 10px corner, a 6px gap to the window at the right
  // and a 4px one at the bottom. Nothing is cast across the seam. A variant rather than
  // state, so AppShell stays free of hooks.
  //
  // The outline is one opaque colour, shared with the active tab's border and
  // the curve at its foot (lib/session-tab-classes.ts): the divider as it
  // reads on the chrome. The divider itself is translucent, and where two
  // strokes of it overlap it doubles.
  "new-layout:border-l-0 new-layout:[box-shadow:none] " +
  "new-layout:[--tab-edge:color-mix(in_srgb,var(--border)_55%,var(--sidebar-bg))] " +
  "new-layout:mr-1.5 new-layout:mb-1 new-layout:rounded-b-pane new-layout:[corner-shape:round] " +
  // The outline is drawn over the content rather than as a border, because
  // the window row is inside this box and a border would run up its sides.
  // Under a row it starts at the row's bottom edge. The tab strip sits above
  // it (TAB_SCROLL_ATTACHED), so the active tab can cover the line.
  "new-layout:before:pointer-events-none new-layout:before:absolute new-layout:before:inset-0 new-layout:before:z-shell-overlay " +
  "new-layout:before:rounded-pane new-layout:before:rounded-tl-[var(--panel-tl)] new-layout:before:border new-layout:before:border-[color:var(--tab-edge)] new-layout:before:content-[''] " +
  "new-layout:[&:has([data-pane-top-row]>:not(:empty))]:before:top-[calc(var(--desktop-header-h)-1px)] " +
  // The bottom corners are this box's own, so its clip rounds them. The top
  // ones are under the row and inside the box, so the chrome is painted back
  // over the content outside each arc.
  "new-layout:[&:has([data-pane-top-row]>:not(:empty))]:after:pointer-events-none new-layout:[&:has([data-pane-top-row]>:not(:empty))]:after:absolute new-layout:[&:has([data-pane-top-row]>:not(:empty))]:after:inset-x-0 new-layout:[&:has([data-pane-top-row]>:not(:empty))]:after:top-[calc(var(--desktop-header-h)-1px)] " +
  "new-layout:[&:has([data-pane-top-row]>:not(:empty))]:after:z-shell-overlay new-layout:[&:has([data-pane-top-row]>:not(:empty))]:after:h-2.5 new-layout:[&:has([data-pane-top-row]>:not(:empty))]:after:content-[''] " +
  "new-layout:[&:has([data-pane-top-row]>:not(:empty))]:after:[background:radial-gradient(circle_at_100%_100%,transparent_9.75px,var(--sidebar-bg)_10.25px)_left_top/var(--panel-tl)_var(--panel-tl)_no-repeat,radial-gradient(circle_at_0_100%,transparent_9.75px,var(--sidebar-bg)_10.25px)_right_top/10px_10px_no-repeat] " +
  // Over the desktop shell's translucent material, opaque grey under the
  // row or at those corners would not match the chrome around it. There the
  // panel's fill starts at the row's bottom edge, and the corners are cut
  // out of the box instead of painted over.
  "[html.material-backdrop_&]:new-layout:[&:has([data-pane-top-row]>:not(:empty))]:[background:linear-gradient(transparent_calc(var(--desktop-header-h)-1px),var(--bg)_0)] " +
  "[html.material-backdrop_&]:new-layout:[&:has([data-pane-top-row]>:not(:empty))]:after:hidden " +
  "[html.material-backdrop_&]:new-layout:[&:has([data-pane-top-row]>:not(:empty))]:[clip-path:shape(from_0_0,hline_to_100%,vline_to_calc(var(--desktop-header-h)-1px),hline_to_calc(100%-10px),arc_to_100%_calc(var(--desktop-header-h)+9px)_of_10px_cw,vline_to_100%,hline_to_0,vline_to_calc(var(--desktop-header-h)-1px+var(--panel-tl)),arc_to_var(--panel-tl)_calc(var(--desktop-header-h)-1px)_of_var(--panel-tl)_cw,hline_to_0,close)] " +
  // The first tab stands on the panel's left edge. While it is the open
  // one its side is that edge carried straight up, so the panel has no corner
  // of its own there. Not with the sidebar collapsed, where the strip starts
  // further in and the corner is the panel's again.
  "new-layout:[--panel-tl:10px] " +
  "[.app-body:not(.sidebar-collapsed)_&]:[&:has([data-pane-top-row-tabs]_.session-tab-reorder:first-child>[aria-selected=true])]:[--panel-tl:0px] " +
  // A page with no row is the whole panel: it keeps the same gap at the top
  // and rounds its own top corners.
  "new-layout:[&:not(:has([data-pane-top-row]>:not(:empty)))]:mt-1.5 new-layout:[&:not(:has([data-pane-top-row]>:not(:empty)))]:rounded-t-pane " +
  NEW_LAYOUT_PANE_ROW +
  " " +
  // An open media viewer lifts the session input above its scrim, which
  // this box's own stacking context would otherwise keep below it.
  "[html[data-lightbox-composer]_&]:z-auto " +
  "phone:contents";

/**
 * The pane itself. `relative` anchors the floating re-open control that appears
 * when the desktop sidebar collapses.
 *
 * On phones it is a page pushed over the sidebar. `--pane-header-h` is how much
 * room the pane's OWN chrome (the docked tab strip, the transcript's top
 * padding) has to leave for the top bar: the pane is `inset: 0` inside
 * `.app-body`, so it starts wherever the bar leaves off. Under a floating
 * `.app-header-overlay` (home, a session) the bar covers the pane's first
 * `--header-h` pixels and pane-relative offsets must clear it; on every other
 * route the bar stays in flow ABOVE `.app-body`, the pane already starts below
 * it, and counting `--header-h` again would push the strip a full bar-height
 * down the screen. Only for pane-RELATIVE offsets — `position: fixed` chrome
 * inside the pane is viewport-relative and keeps using `--header-h`.
 */
export const DETAIL_PANE =
  "detail-pane relative flex min-h-0 min-w-0 flex-1 flex-col " +
  "phone:absolute phone:inset-0 phone:z-sticky phone:bg-surface " +
  "phone:[--pane-header-h:var(--header-h)] " +
  "phone:[.app:not(:has(.app-header-overlay))_&]:[--pane-header-h:0px] " +
  // `transform`, not Tailwind's `translate` property, because that is what
  // the transition beside it names — and what the header animates with.
  "phone:[transform:translateX(100%)] " +
  "phone:[transition:transform_var(--dur-lg)_var(--ease)] " +
  // Pushed on top. The shadow rides the pushed state rather than the pane,
  // or its left-side shadow bleeds back onto the sidebar while it rests just
  // off the right edge.
  "phone:[.app-body.mobile-detail_&]:[transform:translateX(0)] " +
  "phone:[.app-body.mobile-detail_&]:shadow-[-10px_0_28px_rgba(0,0,0,0.35)] " +
  // How much extra top room the phone's DOCKED tab bar takes, published to
  // everything inside the pane that has to start below it — the transcript
  // (VIEWER_MESSAGES), the view-tab panes, the review host. It is only set
  // when a strip is really shown: a lone session with no view tabs hides the
  // strip, and then the default 0 is the right answer. Two selectors because
  // "a strip is shown" is either a view tab or a second session tab.
  "phone:[&:has(.session-tab-view)]:[--strip-clearance:46px] " +
  "phone:[&:has(.session-tab-reorder~.session-tab-reorder)]:[--strip-clearance:46px]";

/**
 * The drop target outlined while a tab is dragged to the pane's edge to split
 * it. Absolutely placed inside the pane, below the header and the tab strip,
 * and inert — it is a hint, never a hit target.
 *
 * The width is the share the dropped column would take. Half the pane is right
 * only for the drop that CREATES a split; once one exists App.tsx overrides
 * `--split-preview-share` with the target column's real ratio. The 12px it
 * subtracts is the 8px inset on its own side plus the gutter to the divider.
 *
 * The 36px is where the desktop tab strip ends (a 40px band pulled 8px up into
 * the header, see `TAB_STRIP`) plus the same 4px gutter the other edges keep;
 * it moves with the band.
 */
export const tabSplitDropPreviewClass = (side: "left" | "right" | "panel") =>
  "pointer-events-none absolute top-[calc(var(--desktop-header-h)+36px)] bottom-2 z-shell-pane " +
  "w-[calc(var(--split-preview-share,50%)-12px)] " +
  "rounded-[calc(10px*var(--rf))] [corner-shape:var(--cs)] border-2 border-accent " +
  "bg-accent/16 " +
  // A hairline of white inside the accent edge, so the outline still reads
  // against a light screenshot or a pale diff behind it.
  "shadow-[inset_0_0_0_1px_color-mix(in_srgb,white_16%,transparent)] " +
  (side === "left" ? "left-2" : "right-2");

/**
 * The hairline a chrome row grows once content has scrolled underneath it.
 *
 * At rest a bar and the content below it share one fill, so there is no seam
 * to mark and no line is drawn — that is the resting top row the app settled
 * on. Content that has scrolled up under the row IS a seam, and this closes it
 * off for as long as it lasts. The sidebar's chrome strip and the pane's title
 * bar both take it, so the two halves of the top row answer their own scroller
 * on the same terms.
 *
 * `data-scrolled` is set by `hooks/useScrollEdge.ts`; the module doc there
 * says why it is an attribute rather than a scroll timeline.
 *
 * A pseudo-element rather than a border: a border that appears would jog
 * everything below it down a pixel, and a permanently-present transparent one
 * would grow `.detail-topbar` — which has no fixed height — past the 48px the
 * bars align on. It also keeps `empty:hidden` working, which a real child
 * would defeat. The flip is `desktop:` only; on phones the bar floats over the
 * content and dissolves it with a mask instead (see `appHeader`).
 */
export const SCROLL_EDGE_DIVIDER =
  "relative after:pointer-events-none after:absolute after:inset-x-0 " +
  "after:bottom-0 after:h-px after:bg-divider after:opacity-0 " +
  "after:transition-opacity after:content-[''] " +
  "desktop:data-[scrolled]:after:opacity-100";

/** Top bar above the tab strip: the session's header portals in here on
 *  session routes, other views render a plain title. `empty:hidden` collapses
 *  it where there is neither (Home), so it costs no vertical space.
 *
 *  The desktop tab strip overlaps the bottom of this bar. Its active pill and
 *  short separators occupy that edge, so the scroll hairline stands down
 *  instead of cutting behind them. Written against the pane rather than as
 *  `:has(+ .session-tabs)`: a split gives each column its own strip, nested a
 *  level down from this row. */
export const DETAIL_TOPBAR =
  `detail-topbar flex min-w-0 shrink-0 flex-col items-stretch empty:hidden ${SCROLL_EDGE_DIVIDER} ` +
  "[.detail-pane:has(.session-tabs)_&]:after:content-none " +
  // In the new layout's window row the hairline is the row's own, and this
  // bar takes what the tab strip beside it leaves, or all of it when alone.
  "new-layout:after:hidden new-layout:only:flex-1";

/**
 * The plain title. Matches `.viewer-header` and the sidebar brand row's height
 * so the three line up across the top of the app at every width, including
 * under a tab strip.
 *
 * It takes the page's own fill rather than the lifted `--topbar-bg` chrome
 * tint, and draws no line under itself. That is the answer `.viewer-header`
 * settled on for the chat, and the reason is the same here: a bar and the
 * content below it sharing one fill means the top of a page reads as one
 * surface, and at the top of a list there is no seam to mark. It was a step of
 * grey with a hairline under it, which drew a boundary across a place nothing
 * was crossing. Once something IS passing underneath, `.detail-topbar` grows
 * the hairline back (SCROLL_EDGE_DIVIDER), which is why the line belongs to
 * that wrapper and not to this row.
 *
 * The row is always drawn on a route that has a name, whether or not the name
 * is showing in it (DETAIL_TOPBAR_TITLE_TEXT below decides that). Two things
 * depend on the box rather than on the word: in the desktop shell this row is
 * the window's titlebar, and a row that came and went with the scroll would
 * take the top edge's drag region with it; and `.detail-topbar:empty` collapses
 * the bar, so the pane's content would jump 52px up and down as you scrolled.
 */
export const DETAIL_TOPBAR_TITLE =
  "detail-topbar-title wco-chrome flex h-[var(--desktop-header-h)] items-center px-4 " +
  "bg-surface new-layout:bg-transparent " +
  "text-item-title font-semibold text-fg " +
  // Collapsed desktop sidebar: clear the floating re-open control and the
  // fallback nav/search cluster beside it.
  "desktop:[.app-body.sidebar-collapsed_&]:pl-[148px] " +
  "phone:hidden";

/**
 * The trailing slot of that row: a page's own controls, portaled up out of its
 * column so the bar naming the page also holds what you do to it.
 *
 * The bar spans the pane and holds nothing at rest, since the name only arrives
 * once the page's heading has gone under it, while the page below could be
 * paying two or three rows of its own before its first item. A page with
 * controls puts them here instead (Pull requests does), and what is left in the
 * body is the title and its one line of numbers.
 *
 * `font-normal` because the row is a heading: without it a search field in this
 * slot renders its placeholder semibold. `empty:hidden` because the slot is on
 * every named route and only one page fills it, and an empty box still spends
 * its own padding in the row.
 */
export const DETAIL_TOPBAR_ACTIONS =
  "ml-auto flex min-w-0 items-center gap-2 pl-4 font-normal empty:hidden";

/** List pages laid out in the pull request list's centred column: the bar's
 *  title takes the same column so it lines up with the list below. */
export const LIST_COLUMN_VIEWS: ReadonlySet<Route["view"]> = new Set<
  Route["view"]
>(["prs", "feed", "issues"]);

/** Pages whose controls fill the actions slot beside the title. */
export const TOPBAR_ACTION_VIEWS: ReadonlySet<Route["view"]> = new Set<
  Route["view"]
>(["prs", "issues", "archived"]);

/**
 * The word inside that row, which is only there once the page's own heading has
 * gone. `data-shown` is set by hooks/useLargeTitle.ts.
 *
 * It rises the last few pixels as it arrives, from the direction the heading it
 * replaces just left in, so the name reads as having moved up into the bar
 * rather than as a second copy switching on. Tailwind's default duration and
 * curve are the app's `--dur-micro` / `--ease`, which is the step for an
 * in-place state change and needs no value of its own here.
 *
 * Only the word fades. The row keeps its fill and its hairline throughout:
 * they belong to the bar, not to the title, and fading the box would take the
 * top of the window with it.
 */
export const DETAIL_TOPBAR_TITLE_TEXT =
  // It gives way first to whatever a page puts in the actions slot beside it,
  // and gives way hard: at rest this word is invisible, so a narrow pane would
  // otherwise be cutting a page's controls to hold room for a title nobody can
  // see yet. Scrolled, it truncates, which is what a name in a bar does.
  "min-w-0 shrink-[100] truncate translate-y-1 opacity-0 " +
  "transition-[opacity,translate] " +
  "data-[shown]:translate-y-0 data-[shown]:opacity-100";

/**
 * The right panel portals into this slot. `contents` dissolves it so the panel
 * (and its overlay) become direct flex children of the shell — a full-height
 * right column at the same level as the pane, rather than a box confined below
 * the session header.
 */
export const RIGHT_PANEL_SLOT = "contents";

/** Bottom spacer that lets the latest turn reach the top of the viewport. The
 *  scroll hook sets its height imperatively; no transition, so it tracks a
 *  streaming reply exactly. */
export const TURN_SPACER =
  "pointer-events-none h-0 shrink-0 [overflow-anchor:none]";
