import { utilityClassName } from "../ui/cn";
import type { GitDotTone } from "./pr-git-tasks";
import type { PrTone } from "./pr-refs";
import type { checkClass } from "./pr-status-derive";

/**
 * The shared vocabulary of the PR surfaces, as finished utility classes.
 *
 * Two things live here rather than on the markup.
 *
 * The tone lookups replace classes the `pr-*` markup used to assemble at
 * render time — `pr-git-dot-${tone}`, `pr-bar-state-${tone}`,
 * `pr-num-chip-${tone}`, `pr-sib-dot-${tone}`. A class built from a fragment
 * can never be proven unused by scripts/css-audit.ts, so those rules were
 * pinned in legacy.css permanently; a lookup that returns the whole class
 * cannot be. Same pattern as TONE_TEXT in lib/sidebar-hover.ts.
 *
 * The row strings are here because two surfaces render the same git-status
 * row from different components — the review canvas (pr/GitStatus.tsx) and the
 * workspace panel (WorkspaceInfo.tsx). They were one legacy class each; a
 * shared constant keeps them one thing rather than two copies that drift.
 */

/** Fill for the small state dot on a git-status row. `muted` keeps the dot's
 *  own default (faint), which is what "no tone class" used to mean. */
export const GIT_DOT_BG: Record<GitDotTone, string> = {
  green: utilityClassName("bg-green"),
  yellow: utilityClassName("bg-yellow"),
  red: utilityClassName("bg-red"),
  blue: utilityClassName("bg-blue"),
  purple: utilityClassName("bg-purple"),
  muted: utilityClassName("bg-faint"),
};

/** A state dot, not a step marker: small and filled with the row's own state
 *  colour, so a stack of them doesn't read as a checklist that never
 *  completes. Pair with a GIT_DOT_BG entry. */
export const GIT_DOT = utilityClassName(
  "mx-0.5 size-1.5 shrink-0 rounded-full",
);
export const GIT_ROW = utilityClassName(
  "flex items-center gap-2 px-2 py-1 text-label text-fg",
);
export const GIT_LABEL = utilityClassName(
  "flex-1 overflow-hidden text-ellipsis",
);
/** The one action that clears the row, quiet on the right. 12px in the old
 *  sheet; it is a control label, so it snaps to text-label.
 *
 *  A weak plate rather than bare words: as text it read as part of the row's
 *  own sentence, and the only thing saying "press me" arrived on hover. The
 *  fill is `--control-surface`, one step over whatever the row sits on (the
 *  panel plate, the review canvas), so it reads as a control at the quietest
 *  weight the row can carry — the Button primitive's `soft`, at chip size.
 *  `data-popup-open` keeps the menu triggers ("Request", "Change") lit while
 *  their own menu is open. */
const GIT_ACTION_BOX = utilityClassName(
  "inline-flex min-h-[22px] shrink-0 items-center whitespace-nowrap rounded-md px-2 text-label font-semibold transition-[color,background-color] disabled:cursor-default disabled:opacity-60",
);
const GIT_ACTION_NEUTRAL = utilityClassName(
  "bg-control text-dim enabled:hover:bg-active enabled:hover:text-fg data-[popup-open]:bg-active data-[popup-open]:text-fg",
);
export const GIT_ACTION = `${GIT_ACTION_BOX} ${GIT_ACTION_NEUTRAL}`;
/** What the plate adds when the action opens a menu rather than doing the
 *  thing: one trailing chevron, on the Button primitive's caret terms. That is
 *  14px beside a 12px label, `gap-1`, and 4px shaved off the caret's side so
 *  the glyph's own whitespace doesn't push the pair off balance. */
const GIT_ACTION_MENU_BOX = utilityClassName("gap-1 pr-1");

/** The tone names a Review row's status band uses (WorkspaceInfo's
 *  `REVIEW_ROW_BG`). A structurally identical union, so a row can pass its own
 *  tone straight in. */
export type RowActionTone = "green" | "yellow" | "red" | "blue" | "muted";

/** The row's action, in the row's own colour. The action a Review row offers
 *  is that row's next step — "Fix" belongs to the red reading, "Change" to the
 *  yellow request — so it takes the band's hue rather than sitting on it as a
 *  neutral plate and reading as unrelated chrome. The same soft fill the PR
 *  chips use (the tone mixed into the control surface at 24%), which keeps it
 *  one weight over the band it sits on.
 *
 *  That fill puts the 12px label at ~3.1:1 against its own plate, the same
 *  place the toned PR chips already sit. The row does not lean on it: the
 *  state is spelled out in words beside it, and the label is only the verb.
 *
 *  Each entry carries its whole colour set, resting and hover, because two
 *  colour utilities on one element resolve by Tailwind's output order rather
 *  than the order they are written — and each is spelled out rather than built
 *  from the token name, because Tailwind only compiles class names it can find
 *  in the source. `muted` keeps the neutral plate: a row with nothing to
 *  report has no colour to lend. */
const GIT_ACTION_TONE: Record<RowActionTone, string> = {
  muted: GIT_ACTION_NEUTRAL,
  green: utilityClassName(
    "bg-[color-mix(in_srgb,var(--green)_24%,var(--control-surface))] text-green enabled:hover:bg-[color-mix(in_srgb,currentColor_34%,var(--control-surface))] data-[popup-open]:bg-[color-mix(in_srgb,currentColor_34%,var(--control-surface))]",
  ),
  yellow: utilityClassName(
    "bg-[color-mix(in_srgb,var(--yellow)_24%,var(--control-surface))] text-yellow enabled:hover:bg-[color-mix(in_srgb,currentColor_34%,var(--control-surface))] data-[popup-open]:bg-[color-mix(in_srgb,currentColor_34%,var(--control-surface))]",
  ),
  red: utilityClassName(
    "bg-[color-mix(in_srgb,var(--red)_24%,var(--control-surface))] text-red enabled:hover:bg-[color-mix(in_srgb,currentColor_34%,var(--control-surface))] data-[popup-open]:bg-[color-mix(in_srgb,currentColor_34%,var(--control-surface))]",
  ),
  blue: utilityClassName(
    "bg-[color-mix(in_srgb,var(--blue)_24%,var(--control-surface))] text-blue enabled:hover:bg-[color-mix(in_srgb,currentColor_34%,var(--control-surface))] data-[popup-open]:bg-[color-mix(in_srgb,currentColor_34%,var(--control-surface))]",
  ),
};

export function gitActionClass(tone: RowActionTone, menu = false): string {
  return `${GIT_ACTION_BOX} ${GIT_ACTION_TONE[tone]}${menu ? ` ${GIT_ACTION_MENU_BOX}` : ""}`;
}
export const GIT_ACTION_CARET = utilityClassName("shrink-0 opacity-55");
/** Follow-up line under the rows. Carries no colour: the caller adds
 *  `text-faint` ("Asked … ✓") or `text-red` (an error), because two colour
 *  utilities on one element resolve by Tailwind output order, not by the
 *  order they are written. */
export const GIT_NOTE = utilityClassName("pt-0.5 pb-1.5 pl-5 text-meta");

/** Ink for a check's mark and its rollup count. Replaces `${checkClass(…)}-text`,
 *  which was built from the rank string at render time. `check-neutral` had no
 *  rule of its own and keeps inheriting the row's colour. */
/** pr-status-derive.ts keeps its rank union private; read it off the function. */
type CheckRank = ReturnType<typeof checkClass>;

export const CHECK_TEXT: Record<CheckRank, string> = {
  "check-success": utilityClassName("text-green"),
  "check-failure": utilityClassName("text-red"),
  "check-pending": utilityClassName("text-yellow"),
  "check-neutral": "",
};

/* ── PR status strip ─────────────────────────────────────────────────────
 *
 * The strip (PrStatusBar) and the series rows under it (PrSeriesRows) are one
 * subtree rendered from two components, so their vocabulary lives here rather
 * than in either file.
 *
 * Two ancestors reach into the strip from SessionViewer — the phone bottom
 * sheet (`.viewer-panel`) and the info page's status card
 * (`.session-info-status`). Those classes belong to a component this family
 * doesn't own, so their overrides stay selectors, as arbitrary variants on the
 * strip itself, instead of becoming props on a component two callers away.
 */

/** The strip: one row of status atop the workspace panel. It is a plate rather
 *  than a band — the panel wraps it in PANEL_PR_PLATE (lib/session-panel-classes),
 *  which supplies the inset, the corner and the clip, so the strip carries no
 *  edge of its own there. The one place it still draws a border is the phone
 *  info card, where consecutive strips are rows of one card.
 *
 *  The markup also keeps the bare `pr-bar` class, and the checking line keeps
 *  `pr-bar-checking`. Neither styles anything any more — they are hooks for the
 *  reduced-motion block in base.css, which kills every animation with
 *  !important and then hands a few liveness signals back. A utility cannot win
 *  against !important, so dropping the hook would silently freeze the
 *  "Checking status…" pulse for anyone on reduced motion. Same reason
 *  `.markdown` stays on the description. Where the strip tops a pane it also
 *  wears `wco-chrome`, which is what makes a row draggable in the desktop
 *  shell. */
export const PR_BAR =
  // A container, so the actions can drop their labels when the panel is
  // dragged narrow. The panel is resizable, so its width is not a function of
  // the viewport and `phone:` cannot see it: at ~465px the headline — the one
  // thing the strip is for — was the part that got squeezed out.
  utilityClassName(
    "@container flex min-h-[var(--desktop-header-h)] items-center gap-2.5 px-3 py-2 ",
  ) +
  // The globe (staging) icon rides inside the strip, flush to its padding.
  "[&>.staging-icon]:-ml-0.5 [&>.staging-icon]:shrink-0 " +
  // Phone: a row of the bottom sheet, and a row of the info card.
  "phone:[.viewer-panel_&]:min-h-[50px] phone:[.viewer-panel_&]:px-3.5 " +
  "phone:[.session-info-status_&]:min-h-[46px] phone:[.session-info-status_&]:px-2.5 " +
  // In the info card the strips stack as rows of one card, so there the seam
  // is a rule. Keyed on the card alone rather than on `phone:` as well: the
  // card only ever renders on a phone, and `phone:` is `width < 720px` while
  // the page that draws it means `<= 720px`, so pinning the divider to the
  // breakpoint would drop it at exactly 720.
  "[.session-info-status_&]:border-b [.session-info-status_&]:border-divider " +
  "[.session-info-status_&]:last:border-b-0";

/** Inside the info card the strip (or the stack of strips) is the card's
 *  content, so it takes the card's corner and clips to it. */
export const PR_BAR_IN_CARD = "phone:[.session-info-status>&]:overflow-hidden";

/** The strip's tone band. Purple and yellow had no soft token and were frozen
 *  as dark-theme rgba() literals, so both themes got the dark hue; mixing from
 *  the token re-themes them. */
export const PR_BAR_BG: Record<PrTone, string> = {
  green: utilityClassName("bg-green-soft"),
  purple: utilityClassName(
    "bg-[color-mix(in_srgb,var(--purple)_10%,transparent)]",
  ),
  red: utilityClassName("bg-red-soft"),
  yellow: utilityClassName(
    "bg-[color-mix(in_srgb,var(--yellow)_9%,transparent)]",
  ),
  // The plate fill its neighbours in the panel wear (`--bg-panel` is
  // re-pointed to `--panel-plate` inside the column), so a strip with nothing
  // to report sits in the same family as the sections under it rather than
  // reading as a white band cut across the top. The info card supplies its
  // own surface, so there the strip stays transparent.
  muted: utilityClassName("bg-panel [.session-info-status_&]:bg-transparent"),
};

/** The same band in the workspace summary card, where it plates the PR rows
 *  rather than spanning a pane. Two departures from the strip's map above.
 *  `muted` carries no fill: the card is quiet text on one surface, and a state
 *  with nothing to report has no colour to lend, so it gets no plate. Green and
 *  red drop to a lighter mix than `--*-soft` because the card sits on the
 *  popup's own raised surface, where the strip's weight reads as a highlight
 *  band instead of a tint. */
export const PR_SUMMARY_BAND_BG: Record<PrTone, string> = {
  green: utilityClassName(
    "bg-[color-mix(in_srgb,var(--green)_11%,transparent)]",
  ),
  purple: utilityClassName(
    "bg-[color-mix(in_srgb,var(--purple)_10%,transparent)]",
  ),
  red: utilityClassName("bg-[color-mix(in_srgb,var(--red)_11%,transparent)]"),
  yellow: utilityClassName(
    "bg-[color-mix(in_srgb,var(--yellow)_10%,transparent)]",
  ),
  muted: "",
};

/** A session that shipped one feature as several PRs: the primary strip plus a
 *  row per sibling, as one continuous block of status. */
export const PR_BAR_STACK = utilityClassName(
  `flex min-w-0 flex-col ${PR_BAR_IN_CARD}`,
);

/** First-load placeholder ("Checking status…") so the strip holds its place
 *  instead of popping in once /pr and /git-status resolve. */
export const PR_BAR_CHECKING = utilityClassName(
  "text-label font-semibold text-dim animate-[pulse_1.6s_ease-in-out_infinite]",
);

/** The headline — the one derived line the strip is for. */
export const PR_BAR_STATE = utilityClassName(
  "cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-label font-semibold hover:underline",
);

/** Ink for the headline and for a series row's state. */
export const PR_STATE_TEXT: Record<PrTone, string> = {
  green: utilityClassName("text-green"),
  purple: utilityClassName("text-purple"),
  red: utilityClassName("text-red"),
  yellow: utilityClassName("text-yellow"),
  muted: utilityClassName("text-dim"),
};

/** The same headline inside the strip, where the state is already carried by
 *  the band behind it, the chip and the action. A settled reading keeps the
 *  panel's own ink instead of repeating it a fourth time: "Ready to merge" in
 *  green, on green, beside a green chip and a green Merge button was a whole
 *  row of one colour. A state that wants the reader — a conflict, a failing
 *  check — keeps the tone in the words as well, because that is the one the
 *  eye should be caught by. */
export const PR_BAR_STATE_TEXT: Record<PrTone, string> = {
  ...PR_STATE_TEXT,
  green: utilityClassName("text-fg"),
  purple: utilityClassName("text-fg"),
};

export const PR_BAR_ERROR = utilityClassName(
  "max-w-[180px] truncate text-meta text-red",
);

/** Compact chip + primary action in the session header, shown while the
 *  workspace panel is closed. */
export const PR_HEAD = utilityClassName(
  "flex min-w-0 items-center gap-2 [.viewer-header-actions_&]:mx-1.5",
);
/** The header's error/prompted lines are tighter than the strip's — the header
 *  has a title to leave room for. */
export const PR_HEAD_ERROR = utilityClassName(
  "max-w-[120px] truncate text-meta text-red",
);
/** Sized to the header chip so the pair reads as one control. */
export const PR_HEAD_BTN = utilityClassName("min-h-[32px] px-[11px]");

/** Where a PR chip is rendered. `bar`/`head` are the primary chip (half of the
 *  split button, hence the squared end); `sib` is a sibling chip in the header,
 *  `row` a sibling chip inside a series row, `card` the one a hover card ends
 *  on. */
type ChipSize = "bar" | "head" | "sib" | "row" | "card";

const CHIP_BASE = utilityClassName(
  "inline-flex items-center gap-0.5 whitespace-nowrap border font-semibold tabular-nums no-underline transition-[background-color]",
);

const CHIP_SIZE: Record<ChipSize, string> = {
  bar: utilityClassName(
    "min-h-[30px] cursor-pointer rounded-s-control rounded-e-none px-2.5 text-label",
  ),
  head: utilityClassName(
    "min-h-[32px] cursor-pointer rounded-s-control rounded-e-none px-[11px] text-label",
  ),
  // A sibling chip in the header was authored as a smaller pill, but the
  // header's own `.pr-head .pr-num-chip` override sat later in the stylesheet
  // and won the tie, so what ships is the primary chip's size minus its
  // shadow. Kept as it ships; making it genuinely smaller is a visual change,
  // not a migration.
  sib: utilityClassName(
    "min-h-[32px] cursor-pointer rounded-control px-[11px] text-label",
  ),
  // Inert markup inside the row button — the whole row is the target.
  row: utilityClassName(
    "min-h-[22px] cursor-[inherit] rounded-md px-[7px] text-label",
  ),
  // A hover card's footer. Sized and rounded to the action that can sit
  // beside it, which is a <Button size="sm">: 26px, and `rounded-control`
  // like every size in that scale, which goes pill on a box this short.
  card: utilityClassName(
    "min-h-[26px] shrink-0 cursor-pointer rounded-control px-2 text-label",
  ),
};

/** Toned chips take a soft tinted fill rather than the neutral control
 *  surface, so a green "Ready to merge" chip sits as a green pill on the green
 *  strip. Each entry carries its whole colour set — ink, edge, fill and hover
 *  — because two colour utilities on one element resolve by Tailwind's output
 *  order, not by the order they are written. */
const CHIP_TONE: Record<PrTone, string> = {
  muted: utilityClassName(
    "border-line bg-control text-dim hover:bg-[color-mix(in_srgb,currentColor_12%,transparent)] active:bg-[color-mix(in_srgb,currentColor_18%,transparent)]",
  ),
  green: utilityClassName(
    "border-[color-mix(in_srgb,var(--green)_22%,transparent)] bg-[color-mix(in_srgb,var(--green)_24%,var(--control-surface))] text-green hover:bg-[color-mix(in_srgb,currentColor_32%,var(--control-surface))]",
  ),
  purple: utilityClassName(
    "border-[color-mix(in_srgb,var(--purple)_22%,transparent)] bg-[color-mix(in_srgb,var(--purple)_24%,var(--control-surface))] text-purple hover:bg-[color-mix(in_srgb,currentColor_32%,var(--control-surface))]",
  ),
  red: utilityClassName(
    "border-[color-mix(in_srgb,var(--red)_22%,transparent)] bg-[color-mix(in_srgb,var(--red)_24%,var(--control-surface))] text-red hover:bg-[color-mix(in_srgb,currentColor_32%,var(--control-surface))]",
  ),
  yellow: utilityClassName(
    "border-[color-mix(in_srgb,var(--yellow)_22%,transparent)] bg-[color-mix(in_srgb,var(--yellow)_24%,var(--control-surface))] text-yellow hover:bg-[color-mix(in_srgb,currentColor_32%,var(--control-surface))]",
  ),
};

/** The same chip on a plain row: the primary chip fills with its tone because
 *  it sits on a matching band, and on a bare row that fill reads as a badge and
 *  out-shouts the strip. Toned ink and edge, no fill, no hover — the state on
 *  the right is where the colour carries. */
const CHIP_TONE_FLAT: Record<PrTone, string> = {
  muted: utilityClassName("border-line bg-control text-dim"),
  green: utilityClassName(
    "border-[color-mix(in_srgb,var(--green)_22%,transparent)] bg-control text-green",
  ),
  purple: utilityClassName(
    "border-[color-mix(in_srgb,var(--purple)_22%,transparent)] bg-control text-purple",
  ),
  red: utilityClassName(
    "border-[color-mix(in_srgb,var(--red)_22%,transparent)] bg-control text-red",
  ),
  yellow: utilityClassName(
    "border-[color-mix(in_srgb,var(--yellow)_22%,transparent)] bg-control text-yellow",
  ),
};

export function prChipClass(tone: PrTone, size: ChipSize): string {
  // A card's chip goes flat for the same reason a row's does: it sits on the
  // popup's own surface rather than on a band already in its colour, and a
  // tinted fill there reads as a badge beside the card's one real action.
  const flat = size === "row" || size === "card";
  // Only the neutral chip keeps the control shadow: a toned pill is already
  // separated from the strip by its fill, and a sibling chip is too small to
  // carry one.
  const shadow = tone === "muted" && (size === "bar" || size === "head");
  // Unlike a row's chip, a card's is the link itself, so it answers the
  // pointer. Mixed from its own ink so a green chip washes green.
  const hover =
    size === "card"
      ? utilityClassName(
          " hover:bg-[color-mix(in_srgb,currentColor_12%,transparent)] active:bg-[color-mix(in_srgb,currentColor_18%,transparent)]",
        )
      : "";
  return `${CHIP_BASE} ${CHIP_SIZE[size]} ${flat ? CHIP_TONE_FLAT[tone] : CHIP_TONE[tone]}${shadow ? " smooth-shadow-sm" : ""}${hover}`;
}

/** The phone top bar's PR chip.
 *
 *  Phones get no workspace panel and no status strip, so this is the only
 *  place a session's PR state is shown: the number in the PR's own colour,
 *  in the bar's right slot. Same toned pill as a sibling chip in the header,
 *  resized to the 44px touch height and given the same shadow as every other
 *  control in that bar. Both ends are its own because it is one target rather
 *  than half of a split button. */
export function prPhoneChipClass(tone: PrTone): string {
  return `${CHIP_BASE} ${CHIP_TONE[tone]} min-h-11 shrink-0 cursor-pointer rounded-full px-2.5 text-label shadow-[var(--mobile-header-control-shadow)]`;
}

/** The outbound half of the split button: same tone, square inner corner, and
 *  it presses rather than washes. */
export function prChipExternalClass(
  tone: PrTone,
  size: "bar" | "head",
): string {
  const geometry =
    // -ml-px collapses the shared seam to a single hairline.
    utilityClassName(
      "-ml-px inline-flex items-center justify-center rounded-e-control rounded-s-none border no-underline transition-[background-color,scale] active:scale-[0.96]",
    );
  const colour =
    tone === "muted"
      ? // No ink of its own: the neutral half is an <a>, so its arrow takes
        // the link colour, and the hover wash mixes from it.
        utilityClassName(
          "border-line bg-control smooth-shadow-sm hover:bg-[color-mix(in_srgb,currentColor_12%,transparent)]",
        )
      : CHIP_TONE[tone];
  return `${geometry} ${size === "head" ? "size-[32px]" : "size-[30px]"} ${colour}`;
}

/** The stack chip — `position/size` with the layers glyph, sitting left of the
 *  PR chip. A pill rather than half of a split button: it opens one popup, so
 *  both of its ends are its own. Sized to whichever strip it rides in, and it
 *  runs tighter than a PR chip because the glyph already fills its left. */
export function prStackChipClass(tone: PrTone, size: "bar" | "head"): string {
  const box =
    size === "head"
      ? utilityClassName("min-h-[32px] pr-[9px] pl-[5px]")
      : utilityClassName("min-h-[30px] pr-2 pl-1");
  return `${CHIP_BASE} ${box} cursor-pointer rounded-control text-label ${CHIP_TONE[tone]}`;
}

/** The split button's two halves lift over each other on hover/focus so the
 *  shared seam doesn't clip the active one's edge. */
export const PR_CHIP_SEAM = utilityClassName(
  "hover:relative hover:z-[1] focus-visible:relative focus-visible:z-[1]",
);

/** Sibling PRs in the header's overflow menu: a dot in each PR's own tone. */
export const PR_SIB_DOT = utilityClassName("size-[7px] shrink-0 rounded-full");
export const PR_SIB_DOT_BG: Record<PrTone, string> = {
  green: utilityClassName("bg-green"),
  purple: utilityClassName("bg-purple"),
  red: utilityClassName("bg-red"),
  yellow: utilityClassName("bg-yellow"),
  muted: utilityClassName("bg-dim"),
};

/** A series row: repo · number · title · state. It repeats the primary row one
 * weight down and paints the whole row in its own state colour. */
export const PR_ROW = utilityClassName(
  "flex min-h-[38px] items-center gap-0.5 border-t border-divider pr-2 hover:brightness-[1.08]",
);
export const PR_ROW_BG: Record<PrTone, string> = {
  green: utilityClassName("bg-green-soft"),
  purple: utilityClassName(
    "bg-[color-mix(in_srgb,var(--purple)_10%,transparent)]",
  ),
  red: utilityClassName("bg-red-soft"),
  yellow: utilityClassName(
    "bg-[color-mix(in_srgb,var(--yellow)_9%,transparent)]",
  ),
  muted: utilityClassName("bg-panel"),
};
export const PR_ROW_MAIN = utilityClassName(
  "flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-1 text-left text-label",
);
/** The title takes what's left and gives it up first — the state on the right
 *  is the part you scan for. */
export const PR_ROW_TITLE = utilityClassName("min-w-0 truncate text-dim");
export const PR_ROW_STATE = utilityClassName(
  "ml-auto shrink-0 whitespace-nowrap text-label font-semibold",
);
/* ── Per-repo tabs (a multi-repo session's PR panel) ─────────────────────
 *
 * Selected and unselected each carry their whole colour set. Layering the
 * selected one over a default would leave two border-color utilities on one
 * element, and which wins is Tailwind's output order rather than the order
 * they are written. Phone keeps the bigger tap target it already had.
 */
export const PR_REPO_TABS = utilityClassName(
  "flex gap-1 overflow-x-auto border-b border-divider px-3 py-2",
);
/* The row inside ReviewToolbar when a branch has no pull request yet. Desktop
 * gets its edge from the shared floating toolbar; phone keeps the divider used
 * by its edge-to-edge review chrome. */
export const PR_NO_PR_BAR = utilityClassName(
  "flex shrink-0 items-center gap-2 overflow-x-auto px-3 py-2 whitespace-nowrap [scrollbar-width:none] phone:border-b phone:border-divider [&>*]:shrink-0 [&::-webkit-scrollbar]:hidden",
);
const PR_REPO_TAB = utilityClassName(
  "inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-[3px] text-label phone:px-3 phone:py-2",
);
export const prRepoTabClass = (selected: boolean) =>
  `${PR_REPO_TAB} ${selected ? "border-line bg-panel text-fg" : "border-transparent bg-transparent text-dim hover:text-fg"}`;
/** Unlink (×) inside the selected linked-PR tab. */
export const PR_REPO_TAB_X = utilityClassName(
  "-mr-1 inline-flex items-center text-dim hover:text-fg",
);

export const PR_ROW_OUT = utilityClassName(
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-dim hover:bg-[color-mix(in_srgb,currentColor_14%,transparent)] hover:text-fg",
);
