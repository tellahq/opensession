import { utilityClassName } from "../ui/cn";
/**
 * The phone top bar — one iOS-style nav bar, and everything that rides in it.
 *
 * The bar is a single `<header>` in App.tsx that wears three different faces:
 * `display:none` on desktop (the brand and user controls live in the sidebar
 * there), a solid band in flow on ordinary pushed routes, and a fixed
 * transparent overlay on the routes that scroll under it (home, Feed, and a
 * session). The faces are one element, so they migrate together: splitting
 * them would leave the overlay's `position:fixed` fighting the band's
 * `height` across two stylesheets.
 *
 * Two class names survive as bare hooks, carrying no styling of their own:
 *
 * - `app-header-overlay` — the only marker of "the bar is floating over this
 *   route". Two other modules read it from outside this tree:
 *   `lib/app-shell-classes.ts` zeroes `--pane-header-h` with
 *   `.app:not(:has(.app-header-overlay))`, and `lib/session-tab-classes.ts`
 *   offsets the docked tab strip with `.app:has(.app-header-overlay)`. Drop
 *   the name and the transcript's top inset and the tab strip both break, in
 *   opposite directions.
 * - `app-header-actions` — `lib/session-viewer-classes.ts` flattens the
 *   session header into the bar through `[.app-header-actions_&]` when
 *   SessionViewer portals it in here.
 *
 * `header-sessionbar` is kept on the markup too, but only as prose insurance:
 * nothing selects it any more (the `flex-shrink` fixes it used to carry are
 * folded into `ui/status.tsx`'s PulseDot, and its `.repo-tile` rule matched
 * nothing once the tile moved to the pill's leading slot). It can go with the
 * two stale comments that still name it, in `ui/status.tsx` and
 * `components/RepoTile.tsx`.
 *
 * Everything below is `phone:`-scoped wherever the rule it replaces lived in
 * the `max-width: 720px` block, even on elements that only ever render inside
 * this bar. The bar is `hidden`, not unmounted, on desktop — its subtree still
 * resolves computed styles there — so dropping the prefix would quietly change
 * what those elements compute at desktop width.
 */

/**
 * The bar. `justify-between` is the fallback distribution; on a pushed page
 * the title pill's `mr-auto` and the actions cluster's fixed gap take over.
 * Padding is authored twice on purpose: 16px edges are what the desktop rule
 * spelled (inert under `hidden`, but it is what the element computes), 12px is
 * the phone edge that lines up with the content column below. The top pad
 * keeps a small gap on a flat-top device while a notched one still gets its
 * full safe-area inset.
 */
const APP_HEADER_BASE =
  utilityClassName(
    "hidden h-[var(--header-h)] shrink-0 items-center justify-between bg-sidebar ",
  ) +
  utilityClassName("px-4 pt-[env(safe-area-inset-top,0px)] pb-0 ") +
  utilityClassName(
    "phone:flex phone:px-3 phone:pt-[max(env(safe-area-inset-top,0px),8px)]",
  );

/**
 * Pushed pages (a session, a PR…): the band itself goes invisible so its
 * controls read as floating bubbles over the page — Back, the title pill, the
 * actions. No chrome band, no divider.
 *
 * The rule this replaces also set `border-bottom-color: transparent`. Nothing
 * draws a border on this element (no rule in base.css or here targets it), so
 * that declaration only ever moved a computed value; it is not carried over.
 */
const APP_HEADER_DETAIL = utilityClassName("phone:bg-transparent");

/**
 * Home, Feed, and a session: the bar floats over the content instead of
 * reserving a band above it, so the list / the transcript fill the full height
 * and scroll UNDER the pills. Taps fall through the gaps between the pills to the content
 * underneath — `*:pointer-events-auto` hands them back to the pills themselves.
 *
 * `::before` is the scroll edge, and it is the reason this works at all: a blur
 * that fades out downward over a fade of the page colour, both masked so the
 * band ends by disappearing rather than by drawing a line. Without it a
 * transcript line or a dark screenshot slides up into the gaps and the bar
 * reads as three stickers dropped on a page. It sits at `z-index:-1` — inside
 * the bar's own stacking context, so still above the page, but below the pills,
 * which are positioned siblings that would otherwise be washed out by it.
 *
 * When the docked tab strip is present, the scroll edge stops at the header so
 * it cannot wash over the tab labels. The tabs carry their own glass material.
 * The header is a sibling of the pane, so that state is keyed off the nearest
 * common ancestor.
 *
 * SessionViewer can still collapse lower chat chrome while reading, but this
 * navigation bar stays pinned so Back and its actions never scroll away.
 */
const APP_HEADER_OVERLAY =
  "app-header-overlay " +
  utilityClassName(
    "phone:fixed phone:inset-x-0 phone:top-0 phone:z-40 phone:bg-transparent ",
  ) +
  utilityClassName("phone:pointer-events-none phone:*:pointer-events-auto ") +
  utilityClassName(
    "phone:before:absolute phone:before:inset-x-0 phone:before:top-0 ",
  ) +
  utilityClassName(
    "phone:before:bottom-auto phone:before:z-[-1] phone:before:h-[calc(100%+30px)] ",
  ) +
  "phone:[.app:has(.session-tabs)_&]:before:h-full " +
  utilityClassName(
    "phone:before:pointer-events-none phone:before:content-[''] ",
  ) +
  // The fade is thinned deliberately. It used to be SOLID `--bg` for its first
  // half, which is exactly the band the controls sit in, so each control was
  // backed by an opaque plate of the page colour and had nothing to be
  // translucent against. Full strength survives only across the status-bar
  // strip, where the clock has to stay legible; from there down the blur is
  // what does the work, which is how an iOS scroll edge behaves.
  utilityClassName(
    "phone:before:[background:linear-gradient(to_bottom,var(--bg)_0%,color-mix(in_srgb,var(--bg)_55%,transparent)_52%,color-mix(in_srgb,var(--bg)_18%,transparent)_78%,transparent_100%)] ",
  ) +
  "phone:before:backdrop-blur-[20px] phone:before:backdrop-saturate-[1.4] " +
  utilityClassName(
    "phone:before:[-webkit-mask-image:linear-gradient(to_bottom,#000_0%,#000_62%,transparent_100%)] ",
  ) +
  utilityClassName(
    "phone:before:[mask-image:linear-gradient(to_bottom,#000_0%,#000_62%,transparent_100%)]",
  );

/**
 * The bar's three faces, assembled so that only one of them is ever on the
 * markup. That is not tidiness: `position` is a single Tailwind utility group,
 * so a `phone:relative` and a `phone:fixed` on one element are resolved by the
 * order Tailwind EMITS them (static, fixed, absolute, relative, sticky) rather
 * than the order they were written — `relative` wins, and the floating bar
 * silently drops back into flow. The stylesheet this replaces got the opposite
 * answer for free, by source order. So the in-flow face and the floating face
 * each spell their own position, and the caller picks one.
 *
 * `detail`: a pushed page with no chrome band. `floating`: home, Feed, or a
 * session, out of flow over the scrolling content.
 */
export function appHeader({
  detail,
  floating,
}: {
  detail: boolean;
  floating: boolean;
}): string {
  return [
    APP_HEADER_BASE,
    floating ? APP_HEADER_OVERLAY : "phone:relative",
    detail ? APP_HEADER_DETAIL : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Leading slot: the brand on the root page, the Back bubble on a pushed one. */
export const APP_HEADER_LEFT = utilityClassName(
  "flex shrink-0 items-center gap-2",
);

/**
 * What every floating control in this bar is made of: a thinned fill over a
 * blur, so the page passing underneath tints it. This is the whole difference
 * between an iOS toolbar item and a white pill sitting on a page, and it is one
 * string rather than four copies because the four controls are one material:
 * Back, the title pill, the grouped actions capsule, and the session header's
 * ⋯ trigger (components/SessionViewer.tsx, which imports it).
 *
 * The `-webkit-` spelling is not legacy dressing: iOS Safari, and the installed
 * PWA with it, still ships `backdrop-filter` only under the prefix, so dropping
 * it turns the glass back into a flat wash on the exact client this is for.
 * base.css collapses the fill back to an opaque `--bg` where the browser has no
 * backdrop-filter at all, and for reduced transparency.
 */
export const MOBILE_CONTROL_GLASS_EFFECTS =
  utilityClassName(
    "phone:[backdrop-filter:var(--mobile-header-control-blur)] ",
  ) +
  utilityClassName(
    "phone:[-webkit-backdrop-filter:var(--mobile-header-control-blur)]",
  );

export const MOBILE_CONTROL_GLASS =
  utilityClassName("phone:bg-[var(--mobile-header-control-surface)] ") +
  MOBILE_CONTROL_GLASS_EFFECTS;

/**
 * One circular mobile top-bar control: Back, More and future page actions all
 * share this material, size, neutral ink and press response. `rounded-full`,
 * not `rounded-[999px]`, keeps the platform's true-circle toolbar shape.
 */
export const MOBILE_TOP_BAR_CONTROL =
  utilityClassName(
    "phone:m-0 phone:inline-flex phone:size-11 phone:min-h-11 phone:items-center phone:justify-center ",
  ) +
  utilityClassName(
    `phone:rounded-full phone:border phone:border-[color:var(--mobile-header-control-border)] ${MOBILE_CONTROL_GLASS} phone:p-0 `,
  ) +
  utilityClassName(
    "phone:text-fg phone:shadow-[var(--mobile-header-control-shadow)] ",
  ) +
  utilityClassName("phone:cursor-pointer phone:touch-manipulation ") +
  utilityClassName("phone:[-webkit-tap-highlight-color:transparent] ") +
  utilityClassName(
    "phone:[transition-property:opacity] phone:duration-[var(--dur)] ",
  ) +
  utilityClassName(
    "phone:ease-[var(--ease)] phone:active:scale-100 phone:active:opacity-40 phone:active:duration-0 ",
  ) +
  "phone:[&_svg]:size-[26px] phone:[&_svg]:shrink-0";

/** Back adds only its PWA hook and the chevron's optical left nudge. */
export const MOBILE_BACK =
  `pwa-header-back ${MOBILE_TOP_BAR_CONTROL} ` +
  "phone:[&_svg]:size-[34px] phone:[&_svg]:-ml-px";

/**
 * Live connection dot on the organization mark in the sidebar selector. It
 * rides a relative wrapper because the tile itself can clip its image. The
 * colour is set inline from the socket state.
 */
export const APP_LOGO_STATUS = utilityClassName(
  "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-raised",
);

/**
 * The title pill on a pushed page: the repo tile leads, then the name over a
 * model · cost subtitle, in a capsule that matches the Back bubble beside it.
 *
 * This replaces two rules — a centred, absolutely-positioned `.app-header-title`
 * and the `.app-header-detail` override that turned it into this pill. The
 * centred one is unreachable: the title only renders when the bar is in its
 * detail face, so the override always won. What survived of the base rule is
 * folded in here (the flex box and `text-fg`); its `bottom: 0` did not, being
 * inert on a statically-positioned element.
 *
 * `rounded-full` rather than `rounded-[999px]`: the rule set no `corner-shape`,
 * so this capsule is a round one. Both radii clamp to the same half-height
 * anyway; spelling it `999px` would hand it a squircle it never had.
 */
export const HEADER_TITLE_PILL =
  utilityClassName(
    "phone:flex phone:min-h-11 phone:flex-[0_1_auto] phone:min-w-0 phone:items-center ",
  ) +
  utilityClassName(
    "phone:justify-start phone:gap-[9px] phone:ml-2 phone:mr-auto ",
  ) +
  utilityClassName("phone:py-[5px] phone:pr-4 phone:pl-[11px] ") +
  utilityClassName(
    `phone:rounded-full phone:border phone:border-[color:var(--mobile-header-control-border)] ${MOBILE_CONTROL_GLASS} `,
  ) +
  utilityClassName(
    "phone:shadow-[var(--mobile-header-control-shadow)] phone:text-fg ",
  ) +
  utilityClassName("phone:pointer-events-auto");

/** Center a plain page title independently of the leading and trailing controls. */
export const HEADER_TITLE_PILL_CENTERED = utilityClassName(
  "phone:absolute phone:left-1/2 phone:ml-0 phone:mr-0 phone:[transform:translateX(-50%)]",
);

/**
 * Archived keeps Search at the phone's bottom edge. While that field is
 * focused, the controls recede and the page rises into their space. Both
 * directions are transitions so a quick focus change reverses from its current
 * position instead of restarting. Overflow stays visible while resting so the
 * floating controls' shadows can extend below the header box. Archived also
 * keeps the shadow inside the bar: 16px above and below the controls when
 * there is no status-bar safe area.
 */
export const ARCHIVED_SEARCH_HEADER =
  utilityClassName(
    "phone:h-[calc(max(env(safe-area-inset-top,0px),16px)+60px)]! ",
  ) +
  utilityClassName("phone:pt-[max(env(safe-area-inset-top,0px),16px)]! ") +
  utilityClassName("phone:transition-[height,padding-top,opacity,transform] ") +
  utilityClassName("phone:duration-[var(--dur)] phone:ease-[var(--ease)] ") +
  "phone:[body.kb-open_&]:h-0! phone:[body.kb-open_&]:pt-0! " +
  "phone:[body.kb-open_&]:pointer-events-none phone:[body.kb-open_&]:opacity-0 " +
  utilityClassName(
    "phone:[body.kb-open_&]:[transform:translateY(-8px)] motion-reduce:transition-none",
  );

/**
 * The pill on a page that names itself, which is every page but a session: it
 * is not there until that name has scrolled up under the bar, and then it is.
 * The iOS large title, on the surface the pattern comes from. `data-shown` is
 * set by hooks/useLargeTitle.ts.
 *
 * The whole lozenge fades, not just the word inside it. This one is a floating
 * pill rather than a band across the top, so an empty one is a blank white
 * capsule sitting in the header with nothing in it, which is worse than the
 * duplicate title it was there to avoid.
 */
export const HEADER_TITLE_PILL_FADE =
  utilityClassName(
    "phone:translate-y-1 phone:opacity-0 phone:transition-[opacity,translate] ",
  ) + "phone:data-[shown]:translate-y-0 phone:data-[shown]:opacity-100";

/**
 * On a session the pill is the tap target for the settings menu, and the name
 * dims on press to say so. The group name is what carries that press down to
 * the name; it is only on the markup when the pill is actually tappable, so
 * the plain title can't dim on a stray press.
 */
export const HEADER_TITLE_PILL_TAPPABLE =
  `${HEADER_TITLE_PILL} group/titlepill ` +
  utilityClassName(
    "phone:cursor-pointer phone:[-webkit-tap-highlight-color:transparent]",
  );

/**
 * Leading repo tile — a fixed square spanning both text rows. It is filled by
 * SessionViewer's portal, so it hides while empty rather than holding open the
 * pill's 9px gap in front of a name that has no tile yet.
 */
export const HEADER_TITLE_REPO =
  utilityClassName(
    "phone:inline-flex phone:flex-none phone:items-center phone:justify-center ",
  ) + "phone:empty:hidden";

/** Name over metadata, stacked to the right of the repo tile. */
export const HEADER_TITLE_COL =
  utilityClassName(
    "phone:flex phone:min-w-0 phone:flex-col phone:items-start phone:justify-center ",
  ) + utilityClassName("phone:gap-px");

/**
 * The name's row. The leading is pinned rather than left at `normal` (~1.21):
 * the name and the metadata line below it are a stacked pair, so the space
 * between them should be the 1px column gap plus a known half-leading, not
 * whatever the font's default line box happens to be.
 */
export const HEADER_TITLE_ROW =
  utilityClassName(
    "phone:flex phone:min-w-0 phone:max-w-full phone:items-center phone:gap-[7px] ",
  ) + utilityClassName("phone:text-base phone:leading-4 phone:font-semibold");

/** The name itself, softly faded if clipped and dimming while pressed. */
export const HEADER_TITLE_TEXT = utilityClassName(
  "phone:flex-1 phone:group-active/titlepill:opacity-60",
);

/**
 * The metadata line's slot under the name — filled by SessionViewer's portal.
 * A touch lighter than the name so the subtitle recedes (Slack-header). Pointer
 * events are re-enabled here because the bar turns them off wholesale.
 */
export const HEADER_TITLE_MODEL =
  utilityClassName(
    "phone:max-w-full phone:truncate phone:text-meta phone:font-medium ",
  ) +
  utilityClassName(
    "phone:leading-[1.1] phone:text-faint phone:pointer-events-auto",
  );

/**
 * The session bar: the line under the title that just *shows* repo · model ·
 * cost. Tapping it (or the name above) opens the settings menu where those are
 * changed. `min-h-4` holds the line at full height whether or not the cost
 * meter has landed yet, so the pill doesn't grow a few px on the first turn.
 *
 * `header-sessionbar` leads the string as a bare hook — see the module note.
 */
export const HEADER_SESSIONBAR =
  utilityClassName(
    "header-sessionbar phone:inline-flex phone:min-h-4 phone:min-w-0 ",
  ) +
  utilityClassName(
    "phone:max-w-full phone:items-center phone:justify-start phone:gap-1.5 ",
  ) +
  utilityClassName("phone:cursor-pointer phone:pointer-events-auto ") +
  utilityClassName(
    "phone:[-webkit-tap-highlight-color:transparent] phone:active:opacity-60",
  );

/**
 * The middot between repo · model · cost. Bigger than the text around it, but
 * its line box is capped at the metadata line's own height: at 20px/1 the dot
 * was the tallest thing on the line and set the row height by itself, opening
 * a gap under the title that nothing visible filled.
 */
/* The 16px is glyph geometry, not a step of the scale: it sizes the middle dot
   between two runs of metadata so the dot lands optically centred against
   11px text. See the scale note in styles/tailwind.css. */
export const HEADER_SESSIONBAR_SEP = utilityClassName(
  "phone:shrink-0 phone:text-[16px] phone:leading-4 phone:text-dim",
);

export const HEADER_SESSIONBAR_MODEL =
  utilityClassName(
    "truncate phone:min-w-0 phone:max-w-[45vw] phone:text-meta ",
  ) + utilityClassName("phone:font-medium phone:text-dim");

/**
 * The cost meter, restyled for the subtitle line: the model's size and colour,
 * a smaller context ring, and none of the toolbar button's padding. `min-h-0`
 * drops the meter's 32px touch box — as a subtitle it only needs its own line,
 * and the extra height was padding the gap under the title open.
 *
 * The two `[&_…]` reaches are what the ancestor rules did: the cost figure ships
 * `text-fg` for the toolbar, and the ring's `<svg>` carries its own size
 * attributes. The cache rate is dropped through the meter's own
 * `showCacheRate` prop instead of being hidden after the fact.
 */
export const HEADER_SESSIONBAR_USAGE = utilityClassName(
  "min-h-0 gap-1 p-0 text-meta [&_span]:text-dim [&_svg]:size-2.5",
);

/**
 * The trailing slot. On the root page it carries Search and the portaled
 * filter; on a pushed page SessionViewer portals its whole header in here.
 *
 * `app-header-actions` stays on the markup as a hook — see the module note.
 *
 * The gap belongs to each variant rather than here: the two faces want
 * different spacing, and two `gap-*` utilities on one element are resolved by
 * Tailwind's OUTPUT order rather than the order they are written, so a `gap-0`
 * appended after this string silently loses to a `gap-2.5` inside it.
 */
const HEADER_ACTIONS_BASE = utilityClassName(
  "app-header-actions phone:flex phone:min-w-0 phone:items-center",
);

/**
 * On the root page the two glyphs in this slot — Filter and Search — are one
 * control, the way adjacent bar-button items group on iOS: a single capsule
 * carrying both, split by a hairline, rather than two separate circles floating
 * next to each other. So the surface (edge, fill, shadow, radius) lives here
 * on the container and the segments inside it are transparent; `gap-0` closes
 * the 10px the loose pair sat on, and `overflow-hidden` keeps a segment's press
 * dim inside the capsule's own curve.
 *
 * It is white (`bg-surface`) and undivided, which is what the native app's own
 * grouped toolbar item looks like — glass over the page, holding two glyphs
 * with no rule between them. That also lines it up with the Back bubble and
 * title pill on a pushed page, which are the same white capsule on the same
 * bar. The segments inside are wide rather than square for the same reason:
 * the glyph is ~22pt and the air around it is what makes the group read as one
 * control instead of two buttons that happen to touch.
 *
 * Only the root variant groups. A pushed page portals SessionViewer's whole
 * header into this slot, which is a row of unrelated controls and keeps the
 * loose spacing.
 */
export const APP_HEADER_ACTIONS =
  utilityClassName(
    `${HEADER_ACTIONS_BASE} phone:ml-auto phone:gap-0 phone:overflow-hidden `,
  ) +
  utilityClassName(
    `phone:rounded-full phone:border phone:border-[color:var(--mobile-header-control-border)] ${MOBILE_CONTROL_GLASS} `,
  ) +
  "phone:shadow-[var(--mobile-header-control-shadow)]";

/**
 * On a pushed page the title pill already carries `mr-auto` to shove this
 * cluster to the right edge. Two competing auto margins both collapse to 0 on a
 * long title, so the pill butts straight against the actions — a fixed gap, and
 * no shrinking, keeps air between them.
 */
export const APP_HEADER_ACTIONS_DETAIL = utilityClassName(
  `${HEADER_ACTIONS_BASE} phone:ml-2.5 phone:flex-none phone:gap-2.5`,
);

/**
 * A segment of the grouped bar control (see `APP_HEADER_ACTIONS`): 40pt tall
 * and wider than it is high, with no chrome of its own. The capsule around it
 * draws the edge, fill and shadow. The glyph is thickened past its 1.5 stroke
 * because iOS nav-bar glyphs are bold and it reads spindly at this size
 * otherwise. `--header-h` in base.css leaves this control 40px below the bar's
 * 8px top inset. Move the two together.
 *
 * 40 rather than 44: the segment is wider than it is tall, so the target the
 * thumb actually meets stays past 44pt across, and the bar reads as chrome
 * rather than as the tallest thing on the screen.
 */
const MOBILE_BAR_SEGMENT =
  utilityClassName(
    "phone:relative phone:inline-flex phone:h-10 phone:w-13 phone:shrink-0 ",
  ) +
  utilityClassName(
    "phone:items-center phone:justify-center phone:rounded-none ",
  ) +
  utilityClassName(
    "phone:border-none phone:bg-transparent phone:p-0 phone:shadow-none ",
  ) +
  utilityClassName("phone:cursor-pointer phone:touch-manipulation ") +
  utilityClassName("phone:[-webkit-tap-highlight-color:transparent] ") +
  utilityClassName("phone:active:opacity-35 phone:active:duration-0 ") +
  "phone:[&_svg]:size-[23px] phone:[&_svg]:[stroke-width:2]";

/**
 * Search — the trailing half of the pair. No rule divides it from the filter:
 * the two glyphs sit in one undivided capsule, as they do in the native app's
 * grouped toolbar item. The air between them is the separation.
 */
export const MOBILE_SEARCH_BTN =
  utilityClassName(`${MOBILE_BAR_SEGMENT} phone:text-fg `) +
  utilityClassName(
    "phone:[transition-property:opacity] phone:duration-[var(--dur)] ",
  ) +
  utilityClassName("phone:ease-[var(--ease)]");

/**
 * Filter, portaled out of the sidebar header into the same capsule. `-order-1`
 * seats it to Search's left. Muted until a filter is actually set, then raised
 * to the neutral foreground used by the other bar actions.
 *
 * Two whole strings rather than a shared base plus a colour: two `text-*`
 * utilities on one element are resolved by Tailwind's OUTPUT order, not the
 * order they were written in. Read them through `mobileFilterBtn()`, never
 * build the class name.
 */
const MOBILE_FILTER_BTN_BASE =
  utilityClassName(`${MOBILE_BAR_SEGMENT} phone:-order-1 `) +
  utilityClassName(
    "phone:[transition:opacity_var(--dur)_var(--ease),color_var(--dur-micro)_var(--ease)] ",
  );

const MOBILE_FILTER_BTN = {
  muted: `${MOBILE_FILTER_BTN_BASE} phone:text-dim`,
  active: `${MOBILE_FILTER_BTN_BASE} phone:text-fg`,
} as const;

/** Raised to the neutral foreground while the popover is open or filtered. */
export function mobileFilterBtn(active: boolean): string {
  return active ? MOBILE_FILTER_BTN.active : MOBILE_FILTER_BTN.muted;
}
