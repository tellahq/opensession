import React from "react";

/**
 * Icon set lifted from an `iconic-pro` library
 * (packages/core/webapp/src/frontend/assets/icons/iconic-pro) so Open Session's
 * session UI uses the same quality stroke icons as the product instead of emoji.
 * All are 24×24, `currentColor`, stroke-width 1.5 — size via the `size` prop.
 *
 * Size scale — stick to these three steps so icons feel consistent (bumped
 * one step 2026-07: the old 18/20 read too small):
 *   20 = inline/meta glyphs riding along with text (draft pencil, trailing
 *        chevrons, tool-status check/x, disclosure carets in rows)
 *   22 = standard standalone icons (the default — search, list rows, menus)
 *   24 = primary action buttons + overlay chrome (composer send/mic/plus,
 *        lightbox nav, mobile top-bar buttons, the footer settings gear)
 * Note: the few hand-drawn 16-viewBox SVGs around the app render ~15% denser
 * than this 24-grid set, so their pixel sizes run smaller for the same visual
 * weight (a raw 17 ≈ iconic 20). Migrate them here when touched.
 */
type IconProps = React.SVGProps<SVGSVGElement> & {
  size?: number;
  /**
   * Opt out of MIN_ICON_SIZE. For a glyph riding INSIDE a small chip, the
   * floor inverts its own reasoning: at 20 the icon, not the text, sets the
   * chip's height, so the chip grows to fit the glyph instead of the glyph
   * sitting with the word. Only for that case — a standalone icon that looks
   * too big is a container to rework, not a size to shrink.
   */
  dense?: boolean;
};

// Hard floor at the scale's smallest step: these 24-grid glyphs only draw
// ~60% of their box, so anything below 20px renders as a speck. Sub-20 sizes
// kept sneaking in (11–17px) — clamp them here; if a spot can't fit a 20px
// icon, rework the container, don't shrink the icon.
//
// Exported because the clamp is silent, and a container that sizes ITSELF from
// the same number a caller passed the icon will be too small for what actually
// renders. `ui/copy`'s CopyCheck is the one that bit: it drew a 15px box for a
// glyph the clamp had already made 20, so the icon overflowed down and right
// and read as badly centred. Anything sizing a box around one of these glyphs
// takes this floor too.
export const MIN_ICON_SIZE = 20;
const MIN_SIZE = MIN_ICON_SIZE;

function Svg({
  size = 22,
  dense,
  children,
  ...rest
}: IconProps & { children: React.ReactNode }) {
  const px = dense ? size : Math.max(size, MIN_SIZE);
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

const stroke = {
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconArrowUp(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M17.25 10.25L12 4.75L6.75 10.25" />
      <path {...stroke} d="M12 19.25V5.75" />
    </Svg>
  );
}

/** Arrow up to a bar — "all the way to the start", vs IconArrowUp's one step. */
export function IconArrowUpToLine(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M5.75 4.75h12.5" />
      <path {...stroke} d="M17.25 13.25L12 8.25L6.75 13.25" />
      <path {...stroke} d="M12 19.25V9.25" />
    </Svg>
  );
}

export function IconArrowDown(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M17.25 13.75L12 19.25L6.75 13.75" />
      <path {...stroke} d="M12 4.75v13.5" />
    </Svg>
  );
}

export function IconMic(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M12 4.75c1.795 0 3.25 1.455 3.25 3.25v4a3.25 3.25 0 1 1-6.5 0V8c0-1.795 1.455-3.25 3.25-3.25Z"
      />
      <path {...stroke} d="M18.25 11.75V12a6.25 6.25 0 0 1-12.5 0v-.25" />
      <path {...stroke} d="M12 18.25v1" />
    </Svg>
  );
}

const SLIDERS_PATHS = ["M4.75 8h6", "M15.25 8h4", "M4.75 16h3", "M12.25 16h7"];
const SLIDERS_CIRCLES = [
  { cx: 13, cy: 8 },
  { cx: 10, cy: 16 },
];

export function IconSliders(p: IconProps) {
  return (
    <Svg {...p}>
      {SLIDERS_PATHS.map((d) => (
        <path key={d} {...stroke} d={d} />
      ))}
      {SLIDERS_CIRCLES.map(({ cx, cy }) => (
        <circle
          key={`${cx}-${cy}`}
          {...stroke}
          cx={cx}
          cy={cy}
          r="2.25"
          fill="none"
        />
      ))}
    </Svg>
  );
}

export function IconKeyboard(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="4.75" y="4.75" width="14.5" height="14.5" rx="2" />
      <path
        {...stroke}
        d="M8 8H8.01M12 8H12.01M16 8H16.01M8 12H8.01M12 12H12.01M16 12H16.01M7.75 16.25H16.25"
      />
    </Svg>
  );
}

export function IconChecklist(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="4.75" y="5.75" width="4.5" height="4.5" rx="1" />
      <path
        {...stroke}
        d="M4.75 13.75V17.25C4.75 17.8023 5.19772 18.25 5.75 18.25H9.25M12.75 6.75H19.25M12.75 9.25H19.25M12.75 14.75H19.25M12.75 17.25H19.25M6.75 15.25L8 16.75L10.25 12.75"
      />
    </Svg>
  );
}

export function IconFilter(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        d="M4.75 6C4.33579 6 4 6.33579 4 6.75C4 7.16421 4.33579 7.5 4.75 7.5H19.25C19.6642 7.5 20 7.16421 20 6.75C20 6.33579 19.6642 6 19.25 6H4.75Z"
        fill="currentColor"
      />
      <path
        d="M6.75 11.25C6.33579 11.25 6 11.5858 6 12C6 12.4142 6.33579 12.75 6.75 12.75H17.25C17.6642 12.75 18 12.4142 18 12C18 11.5858 17.6642 11.25 17.25 11.25H6.75Z"
        fill="currentColor"
      />
      <path
        d="M8.75 16.5C8.33579 16.5 8 16.8358 8 17.25C8 17.6642 8.33579 18 8.75 18H15.25C15.6642 18 16 17.6642 16 17.25C16 16.8358 15.6642 16.5 15.25 16.5H8.75Z"
        fill="currentColor"
      />
    </Svg>
  );
}

export function IconSidebarRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M6.75 4.75H17.25C18.3546 4.75 19.25 5.64543 19.25 6.75V17.25C19.25 18.3546 18.3546 19.25 17.25 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V6.75C4.75 5.64543 5.64543 4.75 6.75 4.75Z"
      />
      <path {...stroke} d="M14.75 4.75V19.25" />
    </Svg>
  );
}

// Mirror of IconSidebarRight — a framed panel with the divider on the left,
// marking the collapsible left column. Same 24-grid stroke so it matches the
// right toggle in size and weight.
export function IconSidebarLeft(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M6.75 4.75H17.25C18.3546 4.75 19.25 5.64543 19.25 6.75V17.25C19.25 18.3546 18.3546 19.25 17.25 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V6.75C4.75 5.64543 5.64543 4.75 6.75 4.75Z"
      />
      <path {...stroke} d="M9.25 4.75V19.25" />
    </Svg>
  );
}

export function IconChevronDown(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M6.75 10.25L12 15.25L17.25 10.25" />
    </Svg>
  );
}

export function IconChevronLeft(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M13.75 6.75L8.75 12L13.75 17.25" />
    </Svg>
  );
}

export function IconChevronRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M10.25 6.75L15.25 12L10.25 17.25" />
    </Svg>
  );
}

export function IconArrowRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M5.25 12H18.75" />
      <path {...stroke} d="M13.5 6.75L18.75 12L13.5 17.25" />
    </Svg>
  );
}

const CHECK_PATH = "M5.75 12.75L9.5 16.25L18.25 7.75";

export function IconCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d={CHECK_PATH} />
    </Svg>
  );
}

export function IconCheckCircle(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M4.75 12C4.75 7.99594 7.99594 4.75 12 4.75V4.75C16.0041 4.75 19.25 7.99594 19.25 12V12C19.25 16.0041 16.0041 19.25 12 19.25V19.25C7.99594 19.25 4.75 16.0041 4.75 12V12Z"
      />
      <path
        {...stroke}
        d="M9.75 12.75L10.1837 13.6744C10.5275 14.407 11.5536 14.4492 11.9564 13.7473L14.25 9.75"
      />
    </Svg>
  );
}

/** Solid status dot whose check is genuinely knocked out, so translucent
 * surfaces and artwork show through instead of being imitated with a fixed
 * background color. */
export function IconCheckCircleFilled(p: IconProps) {
  const maskId = React.useId();
  return (
    <Svg {...p}>
      <defs>
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="24"
          height="24"
        >
          <rect width="24" height="24" fill="white" />
          <path
            d="M8.5 12.25L10.75 14.25L15.5 9.5"
            fill="none"
            stroke="black"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </mask>
      </defs>
      <circle
        cx="12"
        cy="12"
        r="8"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
    </Svg>
  );
}

export function IconQuestionCircle(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="12" cy="12" r="7.25" />
      <path
        {...stroke}
        d="M9.75 9.75C9.75 8.50736 10.7574 7.5 12 7.5C13.2426 7.5 14.25 8.50736 14.25 9.75C14.25 11.25 12 11.5 12 13"
      />
      <path {...stroke} d="M12 16.25H12.01" />
    </Svg>
  );
}

// Enter/return key glyph: a corner-down-left arrow. Used as the keyboard hint
// on the Create button (replaces the bare ↵ character).
export function IconReturn(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M17.25 8.25V10.5C17.25 11.88 16.13 13 14.75 13H7" />
      <path {...stroke} d="M10.25 16.5L6.75 13L10.25 9.5" />
    </Svg>
  );
}

export function IconBolt(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M10.75 13.25H6.75L13.25 4.75V10.75H17.25L10.75 19.25V13.25Z"
      />
    </Svg>
  );
}

export function IconArrowDownRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M17.25 8.75V17.25H8.75" />
      <path {...stroke} d="M17 17L6.75 6.75" />
    </Svg>
  );
}

export function IconArrowTurnDownRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M6.75 5.75V9.25C6.75 13.116 9.884 16.25 13.75 16.25H18.25"
      />
      <path {...stroke} d="M15.25 13.25L18.25 16.25L15.25 19.25" />
    </Svg>
  );
}

// ↗ open-in-new / external-link arrow — the icon-set replacement for the raw
// "↗" glyph on the Preview and Preview environment links.
export function IconArrowUpRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M8.75 15.25L15.25 8.75" />
      <path {...stroke} d="M9.25 8.75H15.25V14.75" />
    </Svg>
  );
}

export function IconShare(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M9.25 4.75H6.75C5.64543 4.75 4.75 5.64543 4.75 6.75V17.25C4.75 18.3546 5.64543 19.25 6.75 19.25H17.25C18.3546 19.25 19.25 18.3546 19.25 17.25V14.75M19.25 9.25V4.75H14.75M19 5L11.75 12.25"
      />
    </Svg>
  );
}

// Hash / number sign — the "Copy number" affordance on the PR chip menu.
export function IconHash(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M9.5 4.75L7.5 19.25" />
      <path {...stroke} d="M16.5 4.75L14.5 19.25" />
      <path {...stroke} d="M5 8.75H18.5" />
      <path {...stroke} d="M4.5 15.25H18" />
    </Svg>
  );
}

// Filled play triangle — starts the local app preview (replaces the raw "▶" glyph). The
// round linejoin softens the tips so it matches the stroke set's rounding.
export function IconPlay(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} fill="currentColor" d="M9 7.5L16.5 12L9 16.5V7.5Z" />
    </Svg>
  );
}

// Outlined play triangle — same glyph, stroke-only so it reads like the rest of
// the icon set (used for the session-header preview affordance, where the state
// color carries the meaning and a filled wedge looked heavy). Drawn large in the
// 24-grid so it carries the same visual weight as the globe beside it (a plain
// triangle occupies less of its box than a circle at the same `size`).
export function IconPlayOutline(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M6.5 4.5L19.5 12L6.5 19.5V4.5Z" />
    </Svg>
  );
}

/** Play inside a screen outline, matching Apple's `play.rectangle`. */
export function IconPlayRectangle(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="3.75" y="6" width="16.5" height="12" rx="2.25" />
      <path {...stroke} d="M10 9L15 12L10 15V9Z" />
    </Svg>
  );
}

// Camera — snapshot the preview. Redrawn on the 24-grid so it carries the same
// weight as its split-button siblings (the old hand-drawn 16-viewBox one read
// denser and off-scale).
export function IconCamera(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M4.75 8.75C4.75 7.64543 5.64543 6.75 6.75 6.75H8L9 5.25H15L16 6.75H17.25C18.3546 6.75 19.25 7.64543 19.25 8.75V16.25C19.25 17.3546 18.3546 18.25 17.25 18.25H6.75C5.64543 18.25 4.75 17.3546 4.75 16.25V8.75Z"
      />
      <circle {...stroke} cx="12" cy="12.25" r="3" fill="none" />
    </Svg>
  );
}

// Picture: a framed photo, where IconCamera is the act of taking one. Both
// exist because a profile picture is a FILE you replace, not a shot the app
// captures. Frame spans the set's 4.75 → 19.25.
export function IconImage(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="4.75" y="4.75" width="14.5" height="14.5" rx="3" />
      <circle {...stroke} cx="9.5" cy="9.5" r="1.25" fill="none" />
      {/* The ridge runs into the frame's lower corners rather than stopping
          inside it: a hill floating in the middle of the box reads as a shape
          on a card, not as a photograph. */}
      <path
        {...stroke}
        d="M5.25 17.25L9.6 12.65C10.1 12.12 10.94 12.12 11.44 12.65L15.75 17.25"
      />
      <path
        {...stroke}
        d="M13.5 14.85L15.1 13.2C15.6 12.68 16.43 12.68 16.93 13.2L18.75 15.1"
      />
    </Svg>
  );
}

// Arms run 4.75 → 19.25, the same 14.5 of the 24 grid the sidebar, chart and
// link glyphs draw. The old 5.75 → 18.25 cross covered only 12.5, so a plus
// rendered visibly smaller than whatever sat beside it at the same size, and
// call sites kept compensating with a one-off bump (25 beside 22 buttons, 22
// on 20px menu rows). Those bumps also scaled the stroke, so the mark came
// back heavier than its neighbours instead of merely bigger. Drawing the
// set's span means a plus needs no exception: size it off the normal scale.
export function IconPlus(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M12 4.75V19.25" />
      <path {...stroke} d="M19.25 12L4.75 12" />
    </Svg>
  );
}

export function IconMinus(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M19.25 12H4.75" />
    </Svg>
  );
}

/* Repo glyph for the session-header breadcrumb: a 2×2 grid of tiles. */
export function IconRepo(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="4.75" y="4.75" width="6" height="6" rx="1.75" />
      <rect {...stroke} x="13.25" y="4.75" width="6" height="6" rx="1.75" />
      <rect {...stroke} x="4.75" y="13.25" width="6" height="6" rx="1.75" />
      <rect {...stroke} x="13.25" y="13.25" width="6" height="6" rx="1.75" />
    </Svg>
  );
}

export function IconPaperclip(p: IconProps) {
  return (
    <Svg viewBox="0 0 25 24" {...p}>
      <path
        {...stroke}
        d="M19.4496 11.9511L13.3335 17.8601C11.4156 19.7131 8.30597 19.7131 6.38804 17.8601C4.46306 16.0003 4.47116 12.9826 6.4061 11.1325L12.0503 5.70078C13.3626 4.43293 15.4902 4.43292 16.8025 5.70075C18.1196 6.97324 18.114 9.038 16.7901 10.3039L11.0824 15.7858C10.374 16.4702 9.22538 16.4702 8.51694 15.7858C7.80849 15.1013 7.80849 13.9916 8.51695 13.3071L13.2435 8.74069"
      />
    </Svg>
  );
}

export function IconAtSign(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="12" cy="12" r="3.25" />
      <path
        {...stroke}
        d="M12 19.25C7.99594 19.25 4.75 16.0041 4.75 12C4.75 7.99594 7.99594 4.75 12 4.75C18.8125 4.75 19.25 9.125 19.25 12V13.25C19.25 14.3546 18.3546 15.25 17.25 15.25C16.1454 15.25 15.25 14.3546 15.25 13.25V8.75"
      />
    </Svg>
  );
}

export function IconCrosshair(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M18.25 12C18.25 15.4518 15.4518 18.25 12 18.25C8.54822 18.25 5.75 15.4518 5.75 12C5.75 8.54822 8.54822 5.75 12 5.75C15.4518 5.75 18.25 8.54822 18.25 12Z"
      />
      <path {...stroke} d="M12 4.75V9.25" />
      <path {...stroke} d="M19.25 12L14.75 12" />
      <path {...stroke} d="M12 14.75V19.25" />
      <path {...stroke} d="M9.25 12L4.75 12" />
    </Svg>
  );
}

export function IconCursor(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M8.25 7L17.75 11.75L13.5 13.25L11.75 17.5L8.25 7Z" />
      <path {...stroke} d="M5.25 8.5H3.75" />
      <path {...stroke} d="M6.25 6.25L5.25 5.25" />
      <path {...stroke} d="M8.5 5.25V3.75" />
    </Svg>
  );
}

export function IconBrowserTab(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M9.75 4.75H7.75C6.09315 4.75 4.75 6.09315 4.75 7.75V16.25C4.75 17.9069 6.09315 19.25 7.75 19.25H16.25C17.9069 19.25 19.25 17.9069 19.25 16.25V8.25M9.75 4.75V7.25C9.75 7.80228 10.1977 8.25 10.75 8.25H14.25M9.75 4.75H14.25M19.25 8.25V7.75C19.25 6.09315 17.9069 4.75 16.25 4.75H14.25M19.25 8.25H14.25M14.25 8.25V4.75"
      />
    </Svg>
  );
}

/* ── Tool icons (transcript work blocks) ─────────────────── */

export function IconTerminal(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M5.25 7.25L10.25 12L5.25 16.75" />
      <path {...stroke} d="M12.25 16.75H18.75" />
    </Svg>
  );
}

export function IconFile(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M7.75 19.25H16.25C17.3546 19.25 18.25 18.3546 18.25 17.25V9L14 4.75H7.75C6.64543 4.75 5.75 5.64543 5.75 6.75V17.25C5.75 18.3546 6.64543 19.25 7.75 19.25Z"
      />
      <path {...stroke} d="M18 9.25H13.75V5" />
    </Svg>
  );
}

/** File Text 2 — a folded page with readable text lines. */
export function IconFileText2(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M7.75 19.25H16.25C17.3546 19.25 18.25 18.3546 18.25 17.25V9L14 4.75H7.75C6.64543 4.75 5.75 5.64543 5.75 6.75V17.25C5.75 18.3546 6.64543 19.25 7.75 19.25Z"
      />
      <path {...stroke} d="M18 9.25H13.75V5" />
      <path {...stroke} d="M8.25 12H15.75" />
      <path {...stroke} d="M8.25 15.25H15.75" />
      <path {...stroke} d="M8.25 8.75H10.25" />
    </Svg>
  );
}

/** A page with a folded corner — the composer's team-note mode. */
export function IconNote(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M13.75 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V6.75C4.75 5.64543 5.64543 4.75 6.75 4.75H17.25C18.3546 4.75 19.25 5.64543 19.25 6.75V13.75M13.75 19.25L19.25 13.75M13.75 19.25V14.75C13.75 14.1977 14.1977 13.75 14.75 13.75H19.25"
      />
    </Svg>
  );
}

export function IconPencil(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M4.75 19.25L9 18.25L18.2929 8.95711C18.6834 8.56658 18.6834 7.93342 18.2929 7.54289L16.4571 5.70711C16.0666 5.31658 15.4334 5.31658 15.0429 5.70711L5.75 15L4.75 19.25Z"
      />
      <path {...stroke} d="M14.0234 7.03906L17.0234 10.0391" />
    </Svg>
  );
}

export function IconSearch(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="10.5" cy="10.5" r="5.75" />
      <path {...stroke} d="M14.85 14.85L18.75 18.75" />
    </Svg>
  );
}

export function IconHome(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M4.75 10.25L12 4.75L19.25 10.25" />
      <path {...stroke} d="M6.25 9.25V18.25H17.75V9.25" />
      <path {...stroke} d="M9.75 18.25V13.25H14.25V18.25" />
    </Svg>
  );
}

/**
 * A pulse, for the Feed: what the team has been shipping, as it lands.
 *
 * Two glyphs came before it. Three dots beside three lines was the picture
 * Tasks wears (IconListCircles) one row below it. Broadcast arcs replaced
 * that, and they say RSS: a stream you subscribe to from somewhere else,
 * when this page is your own team's merges. They also carry all their ink in
 * one corner, so the row sat off the glyph column its neighbours share.
 *
 * A pulse is centred on the grid, reads as activity rather than a source, and
 * is the one silhouette in the rail that isn't nodes, boxes or bars.
 */
export function IconFeed(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M4.75 12H7.75L10 5.75L13.75 18.25L16 12H19.25" />
    </Svg>
  );
}

export function IconPeople(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="9.75" cy="9.25" r="3.5" />
      <path
        {...stroke}
        d="M4.75 18.75C4.75 15.85 6.99 14.25 9.75 14.25C12.51 14.25 14.75 15.85 14.75 18.75"
      />
      <circle {...stroke} cx="17" cy="8.5" r="2.5" />
      <path {...stroke} d="M16.5 13.6C18.35 13.85 19.75 15.45 19.75 17.75" />
    </Svg>
  );
}

// One person rather than IconPeople's group: a single owner, as on a support
// ticket's assignee.
export function IconPerson(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M14.25 7C14.25 8.24264 13.2426 9.25 12 9.25C10.7574 9.25 9.75 8.24264 9.75 7C9.75 5.75736 10.7574 4.75 12 4.75C13.2426 4.75 14.25 5.75736 14.25 7Z"
      />
      <path
        {...stroke}
        d="M12 9.75C8.6 9.75 7.75 11.5 7.75 14.25H9.75V17.25C9.75 18.3546 10.6454 19.25 11.75 19.25H12.25C13.3546 19.25 14.25 18.3546 14.25 17.25V14.25H16.25C16.25 11.5 15.4 9.75 12 9.75Z"
      />
    </Svg>
  );
}

export function IconUser(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="12" cy="8" r="3.25" />
      <path
        {...stroke}
        d="M6.8475 19.25H17.1525C18.2944 19.25 19.174 18.2681 18.6408 17.2584C17.8563 15.7731 16.068 14 12 14C7.93201 14 6.14367 15.7731 5.35924 17.2584C4.82597 18.2681 5.70558 19.25 6.8475 19.25Z"
      />
    </Svg>
  );
}

export function IconBadge(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M14.25 8.75L18.25 4.75H5.75L9.75 8.75" />
      <circle {...stroke} cx="12" cy="14" r="5.25" />
    </Svg>
  );
}

// Flag on a pole: priority, the way every ticket tool draws it.
export function IconFlag(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M4.75 5.75V19.25" />
      <path
        {...stroke}
        d="M19.25 15.25V5.75C19.25 5.75 18.5 6.25 16 6.25C13.5 6.25 12 4.75 9 4.75C6 4.75 4.75 5.75 4.75 5.75V15.25C4.75 15.25 6.5 14.25 9 14.25C11.5 14.25 13.5 16.25 16 16.25C18.5 16.25 19.25 15.25 19.25 15.25Z"
      />
    </Svg>
  );
}

export function IconTag(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="15" cy="9" r="1" fill="currentColor" />
      <path
        {...stroke}
        d="M12 4.75H19.25V12L12.5535 18.6708C11.7544 19.4668 10.4556 19.445 9.68369 18.6226L5.28993 13.941C4.54041 13.1424 4.57265 11.8895 5.36226 11.1305L12 4.75Z"
      />
    </Svg>
  );
}

export function IconGlobe(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="12" cy="12" r="7.25" />
      <path {...stroke} d="M4.75 12H19.25" />
      <path
        {...stroke}
        d="M12 4.75C13.6569 4.75 15 7.99594 15 12C15 16.0041 13.6569 19.25 12 19.25C10.3431 19.25 9 16.0041 9 12C9 7.99594 10.3431 4.75 12 4.75Z"
      />
    </Svg>
  );
}

export function IconSparkle(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M12 4.75C12.75 8.5 15.5 11.25 19.25 12C15.5 12.75 12.75 15.5 12 19.25C11.25 15.5 8.5 12.75 4.75 12C8.5 11.25 11.25 8.5 12 4.75Z"
      />
    </Svg>
  );
}

export function IconPin(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M8.75 7.75L7.75 4.75H16.25L15.25 7.75V10C18.25 11 18.25 14.25 18.25 14.25H5.75C5.75 14.25 5.75 11 8.75 10V7.75Z"
      />
      <path {...stroke} d="M12 14.5V19.25" />
    </Svg>
  );
}

export function IconFolder(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M4.75 16.25V7.75C4.75 6.64543 5.64543 5.75 6.75 5.75H9.68934C9.88823 5.75 10.079 5.82902 10.2197 5.96967L12 7.75H17.25C18.3546 7.75 19.25 8.64543 19.25 9.75V16.25C19.25 17.3546 18.3546 18.25 17.25 18.25H6.75C5.64543 18.25 4.75 17.3546 4.75 16.25Z"
      />
    </Svg>
  );
}

export function IconFolderPlus(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M4.75 16.25V7.75C4.75 6.64543 5.64543 5.75 6.75 5.75H9.68934C9.88823 5.75 10.079 5.82902 10.2197 5.96967L12 7.75H17.25C18.3546 7.75 19.25 8.64543 19.25 9.75V16.25C19.25 17.3546 18.3546 18.25 17.25 18.25H6.75C5.64543 18.25 4.75 17.3546 4.75 16.25Z"
      />
      <path {...stroke} d="M12 10.75V15.25" />
      <path {...stroke} d="M9.75 13H14.25" />
    </Svg>
  );
}

export function IconGear(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M13.1191 5.61336C13.0508 5.11856 12.6279 4.75 12.1285 4.75H11.8715C11.3721 4.75 10.9492 5.11856 10.8809 5.61336L10.7938 6.24511C10.7382 6.64815 10.4403 6.96897 10.0622 7.11922C10.006 7.14156 9.95021 7.16484 9.89497 7.18905C9.52217 7.3524 9.08438 7.3384 8.75876 7.09419L8.45119 6.86351C8.05307 6.56492 7.49597 6.60451 7.14408 6.9564L6.95641 7.14408C6.60452 7.49597 6.56492 8.05306 6.86351 8.45118L7.09419 8.75876C7.33841 9.08437 7.3524 9.52216 7.18905 9.89497C7.16484 9.95021 7.14156 10.006 7.11922 10.0622C6.96897 10.4403 6.64815 10.7382 6.24511 10.7938L5.61336 10.8809C5.11856 10.9492 4.75 11.372 4.75 11.8715V12.1285C4.75 12.6279 5.11856 13.0508 5.61336 13.1191L6.24511 13.2062C6.64815 13.2618 6.96897 13.5597 7.11922 13.9378C7.14156 13.994 7.16484 14.0498 7.18905 14.105C7.3524 14.4778 7.3384 14.9156 7.09419 15.2412L6.86351 15.5488C6.56492 15.9469 6.60451 16.504 6.9564 16.8559L7.14408 17.0436C7.49597 17.3955 8.05306 17.4351 8.45118 17.1365L8.75876 16.9058C9.08437 16.6616 9.52216 16.6476 9.89496 16.811C9.95021 16.8352 10.006 16.8584 10.0622 16.8808C10.4403 17.031 10.7382 17.3519 10.7938 17.7549L10.8809 18.3866C10.9492 18.8814 11.3721 19.25 11.8715 19.25H12.1285C12.6279 19.25 13.0508 18.8814 13.1191 18.3866L13.2062 17.7549C13.2618 17.3519 13.5597 17.031 13.9378 16.8808C13.994 16.8584 14.0498 16.8352 14.105 16.8109C14.4778 16.6476 14.9156 16.6616 15.2412 16.9058L15.5488 17.1365C15.9469 17.4351 16.504 17.3955 16.8559 17.0436L17.0436 16.8559C17.3955 16.504 17.4351 15.9469 17.1365 15.5488L16.9058 15.2412C16.6616 14.9156 16.6476 14.4778 16.811 14.105C16.8352 14.0498 16.8584 13.994 16.8808 13.9378C17.031 13.5597 17.3519 13.2618 17.7549 13.2062L18.3866 13.1191C18.8814 13.0508 19.25 12.6279 19.25 12.1285V11.8715C19.25 11.3721 18.8814 10.9492 18.3866 10.8809L17.7549 10.7938C17.3519 10.7382 17.031 10.4403 16.8808 10.0622C16.8584 10.006 16.8352 9.95021 16.8109 9.89496C16.6476 9.52216 16.6616 9.08437 16.9058 8.75875L17.1365 8.4512C17.4351 8.05308 17.3955 7.49599 17.0436 7.1441L16.8559 6.95642C16.504 6.60453 15.9469 6.56494 15.5488 6.86353L15.2412 7.09419C14.9156 7.33841 14.4778 7.3524 14.105 7.18905C14.0498 7.16484 13.994 7.14156 13.9378 7.11922C13.5597 6.96897 13.2618 6.64815 13.2062 6.24511L13.1191 5.61336Z"
      />
      <path
        {...stroke}
        d="M13.25 12C13.25 12.6904 12.6904 13.25 12 13.25C11.3096 13.25 10.75 12.6904 10.75 12C10.75 11.3096 11.3096 10.75 12 10.75C12.6904 10.75 13.25 11.3096 13.25 12Z"
      />
    </Svg>
  );
}

export function IconLogOut(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M9.25 5.25h-2.5a2 2 0 0 0-2 2v9.5a2 2 0 0 0 2 2h2.5"
      />
      <path {...stroke} d="M14.25 8.25 18 12l-3.75 3.75" />
      <path {...stroke} d="M18 12H9.25" />
    </Svg>
  );
}

// Drawn 10.5 x 14.5 on the grid, centred on (12, 12): a narrow object at the
// set's full height, the same proportions as IconBolt. It used to be 8.5 x 11.5
// sitting 1.5 units low, which is why it read a size smaller than the glyph
// beside it in a menu and why call sites kept scaling it up by hand.
export function IconPlug(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M6.75 8.5H17.25V10.5C17.25 13.3995 14.8995 15.75 12 15.75C9.10051 15.75 6.75 13.3995 6.75 10.5V8.5Z"
      />
      <path {...stroke} d="M9.25 8.25V4.75" />
      <path {...stroke} d="M14.75 8.25V4.75" />
      <path {...stroke} d="M12 15.75V19.25" />
    </Svg>
  );
}

// Share-nodes glyph (one node linked to two) — matches the Connections nav
// item. Drawn on the 24-grid so it carries the same visual weight as the
// other composer icons (the old IconPlug read visibly smaller).
export function IconConnections(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="7" cy="12" r="2.25" fill="none" />
      <circle {...stroke} cx="16.5" cy="6.75" r="2.25" fill="none" />
      <circle {...stroke} cx="16.5" cy="17.25" r="2.25" fill="none" />
      <path {...stroke} d="M8.95 10.9L14.55 7.85" />
      <path {...stroke} d="M8.95 13.1L14.55 16.4" />
    </Svg>
  );
}

export function IconBook(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M5.75 19.25V6.75C5.75 5.64543 6.64543 4.75 7.75 4.75H18.25V16.25H7.5C6.5335 16.25 5.75 17.0335 5.75 18V19.25Z"
      />
      <path {...stroke} d="M5.75 19.25H18.25" />
    </Svg>
  );
}

export function IconBranches(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="7" cy="7" r="1.75" />
      <circle {...stroke} cx="7" cy="17" r="1.75" />
      <circle {...stroke} cx="17" cy="7" r="1.75" />
      <path {...stroke} d="M7 9V15.25" />
      <path
        {...stroke}
        d="M17 9C17 12 14 12.75 12 13C10 13.25 8.5 14 7.75 15"
      />
    </Svg>
  );
}

export function IconNewBranch(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M6.75 9.5V14.5M10.75 12.25H15.25C16.3546 12.25 17.25 11.3546 17.25 10.25V9.5M9.25 7C9.25 8.24264 8.24264 9.25 7 9.25C5.75736 9.25 4.75 8.24264 4.75 7C4.75 5.75736 5.75736 4.75 7 4.75C8.24264 4.75 9.25 5.75736 9.25 7ZM19.25 7C19.25 8.24264 18.2426 9.25 17 9.25C15.7574 9.25 14.75 8.24264 14.75 7C14.75 5.75736 15.7574 4.75 17 4.75C18.2426 4.75 19.25 5.75736 19.25 7ZM9.25 17C9.25 18.2426 8.24264 19.25 7 19.25C5.75736 19.25 4.75 18.2426 4.75 17C4.75 15.7574 5.75736 14.75 7 14.75C8.24264 14.75 9.25 15.7574 9.25 17Z"
      />
    </Svg>
  );
}

/**
 * Checklist glyph: an open circle per item, not a tick. Three ticks at 20px
 * (the tool-row size) collapse into a smudge, and they also read as "all
 * done", which a plan in progress is not.
 */
export function IconListCircles(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="6.25" cy="6.5" r="1.75" />
      <circle {...stroke} cx="6.25" cy="12" r="1.75" />
      <circle {...stroke} cx="6.25" cy="17.5" r="1.75" />
      <path {...stroke} d="M11.5 6.5H19.25" />
      <path {...stroke} d="M11.5 12H19.25" />
      <path {...stroke} d="M11.5 17.5H19.25" />
    </Svg>
  );
}

export function IconWrench(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M13.5 6.5C14.5 5.5 16.5 5 17.5 5.5L14.75 8.25L15.75 9.25L18.5 6.5C19 7.5 18.5 9.5 17.5 10.5C16.6 11.4 15.1 11.7 14 11.25L7.75 17.5C7.19772 18.0523 6.30228 18.0523 5.75 17.5C5.19772 16.9477 5.19772 16.0523 5.75 15.5L12 9.25C11.8 8.15 12.6 7.4 13.5 6.5Z"
      />
    </Svg>
  );
}

export function IconServer(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="4.75" y="4.75" width="14.5" height="5.5" rx="1" />
      <rect {...stroke} x="4.75" y="13.75" width="14.5" height="5.5" rx="1" />
      <path {...stroke} d="M16.25 5V10M16.25 14V19" />
    </Svg>
  );
}

export function IconDatabase(p: IconProps) {
  return (
    <Svg {...p}>
      <ellipse {...stroke} cx="12" cy="7" rx="7.25" ry="2.25" />
      <path
        {...stroke}
        d="M19.25 12C19.25 13.1046 15.866 14.25 12 14.25C8.13401 14.25 4.75 13.1046 4.75 12M19.25 7V17C19.25 18.1046 15.866 19.25 12 19.25C8.13401 19.25 4.75 18.1046 4.75 17V7"
      />
    </Svg>
  );
}

export function IconGauge(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M16.75 17.25H17.25C18.3546 17.25 19.25 16.3546 19.25 15.25V8.75C19.25 7.64543 18.3546 6.75 17.25 6.75H6.75C5.64543 6.75 4.75 7.64543 4.75 8.75V15.25C4.75 16.3546 5.64543 17.25 6.75 17.25H7.25M11 16L8.75 11.75M12 9.75V10.25M15.625 10.7213L15.375 11.1543"
      />
      <circle {...stroke} cx="12" cy="17" r="1.25" />
    </Svg>
  );
}

const EXPAND_PATHS = [
  "M14.75 4.75H19.25V9.25",
  "M19.25 4.75L13.75 10.25",
  "M9.25 19.25H4.75V14.75",
  "M4.75 19.25L10.25 13.75",
];

export function IconExpand(p: IconProps) {
  return (
    <Svg {...p}>
      {EXPAND_PATHS.map((d) => (
        <path key={d} {...stroke} d={d} />
      ))}
    </Svg>
  );
}

// ── Glyphs as markup ───────────────────────────────────────────────────────
// A few controls are built as an innerHTML string rather than as JSX, because
// the surface they sit on is itself injected HTML with no element for React to
// own: the expand button on a rendered mermaid diagram and the copy button on
// a code fence, both created by MarkdownBody (see there, and lib/code-copy.ts).
// Each shares its path data with the JSX icon above it, so there is still one
// drawing per glyph.

const STROKE_MARKUP =
  `stroke="currentColor" stroke-width="${stroke.strokeWidth}"` +
  ` stroke-linecap="${stroke.strokeLinecap}" stroke-linejoin="${stroke.strokeLinejoin}"`;

function iconMarkup(inner: string, size: number): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"` +
    ` aria-hidden="true">${inner}</svg>`
  );
}

function pathsMarkup(paths: readonly string[]): string {
  return paths.map((d) => `<path d="${d}" ${STROKE_MARKUP}/>`).join("");
}

/** <IconExpand> as markup. */
export function expandIconMarkup(size = MIN_ICON_SIZE): string {
  return iconMarkup(pathsMarkup(EXPAND_PATHS), size);
}

/** <IconCopy> as markup. */
export function copyIconMarkup(size = MIN_ICON_SIZE): string {
  return iconMarkup(
    `<rect x="8.75" y="8.75" width="10.5" height="10.5" rx="2" ${STROKE_MARKUP}/>` +
      pathsMarkup([COPY_SHEET_PATH]),
    size,
  );
}

/** <IconSliders> as markup. */
export function slidersIconMarkup(size = MIN_ICON_SIZE): string {
  return iconMarkup(
    pathsMarkup(SLIDERS_PATHS) +
      SLIDERS_CIRCLES.map(
        ({ cx, cy }) =>
          `<circle cx="${cx}" cy="${cy}" r="2.25" fill="none" ${STROKE_MARKUP}/>`,
      ).join(""),
    size,
  );
}

/** <IconCheck> as markup. */
export function checkIconMarkup(size = MIN_ICON_SIZE): string {
  return iconMarkup(pathsMarkup([CHECK_PATH]), size);
}

export function IconTrash(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M6.75 7.75L7.59115 17.4233C7.68102 18.4568 8.54622 19.25 9.58363 19.25H14.4164C15.4538 19.25 16.319 18.4568 16.4088 17.4233L17.25 7.75"
      />
      <path
        {...stroke}
        d="M9.75 7.5V6.75C9.75 5.64543 10.6454 4.75 11.75 4.75H12.25C13.3546 4.75 14.25 5.64543 14.25 6.75V7.5"
      />
      <path {...stroke} d="M5 7.75H19" />
    </Svg>
  );
}

export function IconX(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M17.25 6.75L6.75 17.25" />
      <path {...stroke} d="M6.75 6.75L17.25 17.25" />
    </Svg>
  );
}

// Circle-slash: blocked, as in a customer marked spam. Distinct from IconX,
// which dismisses the thing in front of you.
export function IconForbid(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="12" cy="12" r="7.25" />
      <path {...stroke} d="M7 7L17 17" />
    </Svg>
  );
}

export function IconStopSquare(p: IconProps) {
  return (
    <Svg {...p}>
      <rect
        x="7.25"
        y="7.25"
        width="9.5"
        height="9.5"
        rx="2"
        fill="currentColor"
      />
    </Svg>
  );
}

export function IconClock(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="12" cy="12" r="7.25" />
      <path {...stroke} d="M12 8.25V12L14.75 14.25" />
    </Svg>
  );
}

export function IconTarget(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="12" cy="12" r="7.25" />
      <circle {...stroke} cx="12" cy="12" r="4.25" />
      <circle {...stroke} cx="12" cy="12" r="1.25" />
    </Svg>
  );
}

export function IconShieldCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M12 4.75L4.75 8C4.75 8 4 19.25 12 19.25C20 19.25 19.25 8 19.25 8L12 4.75Z"
      />
      <path {...stroke} d="M9.75 12.75L11 14.25L14.25 9.75" />
    </Svg>
  );
}

export function IconRocket(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M13.4556 6.85504C14.9314 5.50111 16.8613 4.74994 18.864 4.74994H19.2501V5.13607C19.2501 7.1388 18.4989 9.0687 17.145 10.5444L10.9948 17.2478L6.7522 13.0052L13.4556 6.85504Z"
      />
      <path
        {...stroke}
        d="M7.25 16.75L4.75 19.25M9.25 18.75L8.75 19.25M5.25 14.75L4.75 15.25M13 19.25L14.24 14L11 17.25L13 19.25ZM6.75 13L10 9.75L4.75 10.75L6.75 13Z"
      />
    </Svg>
  );
}

export function IconBandAid(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M19.25 14L10 4.75H8.75C6.54086 4.75 4.75 6.54086 4.75 8.75V10L14 19.25H15.25C17.4591 19.25 19.25 17.4591 19.25 15.25V14Z"
      />
      <path {...stroke} d="M11 10L10 11L13 14L14 13L11 10Z" />
    </Svg>
  );
}

export function IconCalendar(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M4.75 8.75C4.75 7.64543 5.64543 6.75 6.75 6.75H17.25C18.3546 6.75 19.25 7.64543 19.25 8.75V17.25C19.25 18.3546 18.3546 19.25 17.25 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V8.75Z"
      />
      <path {...stroke} d="M4.75 10.75H19.25" />
      <path {...stroke} d="M8.75 4.75V6.75" />
      <path {...stroke} d="M15.25 4.75V6.75" />
    </Svg>
  );
}

export function IconMessage(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M6.75 5.25H17.25C18.3546 5.25 19.25 6.14543 19.25 7.25V14.25C19.25 15.3546 18.3546 16.25 17.25 16.25H11.25L7.25 19.25V16.25H6.75C5.64543 16.25 4.75 15.3546 4.75 14.25V7.25C4.75 6.14543 5.64543 5.25 6.75 5.25Z"
      />
    </Svg>
  );
}

export function IconMessages(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M5.75 5.25H14.25C15.3546 5.25 16.25 6.14543 16.25 7.25V12.25C16.25 13.3546 15.3546 14.25 14.25 14.25H10.25L6.75 17V14.25H5.75C4.64543 14.25 3.75 13.3546 3.75 12.25V7.25C3.75 6.14543 4.64543 5.25 5.75 5.25Z"
      />
      <path
        {...stroke}
        d="M17.25 8.75H18.25C19.3546 8.75 20.25 9.64543 20.25 10.75V15.25C20.25 16.3546 19.3546 17.25 18.25 17.25H17.25V19.5L14.25 17.25H12.75"
      />
    </Svg>
  );
}

export function IconMessageQuestion(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M6.75 5.25H17.25C18.3546 5.25 19.25 6.14543 19.25 7.25V14.25C19.25 15.3546 18.3546 16.25 17.25 16.25H11.25L7.25 19.25V16.25H6.75C5.64543 16.25 4.75 15.3546 4.75 14.25V7.25C4.75 6.14543 5.64543 5.25 6.75 5.25Z"
      />
      <path
        {...stroke}
        d="M10 9.25C10.35 8.35 11.15 7.75 12.15 7.75C13.35 7.75 14.25 8.55 14.25 9.65C14.25 10.55 13.75 11.05 12.9 11.55C12.3 11.9 12 12.25 12 13"
      />
      <path {...stroke} d="M12 14.75H12.01" />
    </Svg>
  );
}

/** Crescent moon for snoozed workspaces (quiet-until-later). */
export function IconMoon(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M18.25 15.03C17.3 15.49 16.24 15.75 15.11 15.75C11.13 15.75 7.9 12.52 7.9 8.54C7.9 7.16 8.29 5.87 8.96 4.77C6.48 5.97 4.75 8.52 4.75 11.47C4.75 15.58 8.08 18.9 12.18 18.9C14.79 18.9 17.08 17.56 18.25 15.03Z"
      />
    </Svg>
  );
}

export function IconBell(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M17.25 12V10C17.25 7.1 14.9 4.75 12 4.75C9.1 4.75 6.75 7.1 6.75 10V12L4.75 16.25H19.25L17.25 12Z"
      />
      <path
        {...stroke}
        d="M9.75 16.5C9.75 17.74 10.76 18.75 12 18.75C13.24 18.75 14.25 17.74 14.25 16.5"
      />
    </Svg>
  );
}

export function IconInbox(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M5.25 10.25L7.05 5.85C7.357 5.121 8.07 4.75 8.861 4.75H15.139C15.93 4.75 16.643 5.121 16.95 5.85L18.75 10.25V17.25C18.75 18.3546 17.8546 19.25 16.75 19.25H7.25C6.14543 19.25 5.25 18.3546 5.25 17.25V10.25Z"
      />
      <path
        {...stroke}
        d="M5.25 10.25H9.25L10.25 12.25H13.75L14.75 10.25H18.75"
      />
    </Svg>
  );
}

export function IconStack(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="8.25" y="4.75" width="11" height="11" rx="2" />
      <path
        {...stroke}
        d="M15.75 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V8.25"
      />
    </Svg>
  );
}

// Isometric cube (a sealed container) — the sandbox glyph: the session-create
// "Run in sandbox" toggle and the sandbox badge on sandboxed sessions.
export function IconBox(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M12 4.75L18.75 8.5V15.5L12 19.25L5.25 15.5V8.5L12 4.75Z"
      />
      <path {...stroke} d="M5.5 8.75L12 12.25L18.5 8.75" />
      <path {...stroke} d="M12 12.5V19" />
    </Svg>
  );
}

// A drawn region, which is what the screenshot markup tool makes. IconBox is
// a 3D carton and reads as a package; this is the rectangle you drag around
// the thing that is wrong. Corners span the set's 4.75 → 19.25 on the wide
// axis, with the shorter axis inset so it reads as a frame rather than a
// square button.
export function IconRectangle(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="4.75" y="6.75" width="14.5" height="10.5" rx="2" />
    </Svg>
  );
}

// A handset for mobile experiences. Narrow body plus a home indicator, so it
// reads as a phone rather than as a card or a vertical panel.
export function IconPhone(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="8.25" y="4.75" width="7.5" height="14.5" rx="2" />
      <path {...stroke} d="M10.75 16.75H13.25" />
    </Svg>
  );
}

// Friendly machine face for automation-owned sessions. Kept geometric and
// neutral so it reads as origin, not as a chat persona or assistant avatar.
export function IconRobot(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M12 4.75V7.25" />
      <circle {...stroke} cx="12" cy="4.75" r="1" />
      <rect {...stroke} x="5.25" y="7.25" width="13.5" height="11.5" rx="3" />
      <path {...stroke} d="M5.25 11H3.75V15H5.25M18.75 11H20.25V15H18.75" />
      <circle cx="9" cy="12.25" r="1" fill="currentColor" />
      <circle cx="15" cy="12.25" r="1" fill="currentColor" />
      <path {...stroke} d="M9.5 15.75H14.5" />
    </Svg>
  );
}

// Archive box (lidded crate with a pull slot), redrawn to this set's 24×24
// grammar — the reversible sibling of IconTrash.
export function IconArchive(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="4" y="4.75" width="16" height="4" rx="1" />
      <path
        {...stroke}
        d="M5.5 8.75V17.25C5.5 18.3546 6.39543 19.25 7.5 19.25H16.5C17.6046 19.25 18.5 18.3546 18.5 17.25V8.75"
      />
      <path {...stroke} d="M10 12.25H14" />
    </Svg>
  );
}

// The archive crate with its contents lifting back out — the exact mirror of
// IconArchive, whose pull slot becomes an up arrow.
export function IconUnarchive(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="4" y="4.75" width="16" height="4" rx="1" />
      <path
        {...stroke}
        d="M5.5 8.75V17.25C5.5 18.3546 6.39543 19.25 7.5 19.25H16.5C17.6046 19.25 18.5 18.3546 18.5 17.25V8.75"
      />
      <path {...stroke} d="M12 16.25V11.75M9.75 14L12 11.75L14.25 14" />
    </Svg>
  );
}

// Octicon-style git-pull-request, redrawn to this set's 24×24 stroke grammar.
export function IconPullRequest(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="7" cy="6.5" r="1.75" />
      <circle {...stroke} cx="7" cy="17.5" r="1.75" />
      <circle {...stroke} cx="17" cy="17.5" r="1.75" />
      <path {...stroke} d="M7 8.25V15.75" />
      <path {...stroke} d="M12.25 6.5H15C16.1046 6.5 17 7.39543 17 8.5V15.75" />
    </Svg>
  );
}

// iconic-pro rotate-anti-clockwise — the ⟲ "restore" glyph.
export function IconRestore(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M13 18.25A6.25 6.25 0 1 0 6.75 12v2.385m2.5-1.635L7 15.25l-2.25-2.5"
      />
    </Svg>
  );
}

// The restore arc plus clock hands: session history.
export function IconHistory(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M13 18.25A6.25 6.25 0 1 0 6.75 12v2.385m2.5-1.635L7 15.25l-2.25-2.5"
      />
      <path {...stroke} d="M12 9.25V12l2 1.5" />
    </Svg>
  );
}

// Revert / undo: a curved arrow doubling back on itself.
export function IconUndo(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M9 14.25L5.75 11L9 7.75" />
      <path {...stroke} d="M5.75 11H14.25a4 4 0 0 1 0 8H12" />
    </Svg>
  );
}

// Octicon-style git-merge: branch line curving into the merge target.
export function IconGitMerge(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="7" cy="6.5" r="1.75" />
      <circle {...stroke} cx="7" cy="17.5" r="1.75" />
      <circle {...stroke} cx="17" cy="13" r="1.75" />
      <path {...stroke} d="M7 8.25V15.75" />
      <path {...stroke} d="M7 9C7 11.5 10 13 15.25 13" />
    </Svg>
  );
}

// Octicon-style git-commit: one node on the line of history. Same 24-grid and
// node radius as the PR and merge glyphs above, so a commit reads as a sibling
// of those rather than a different family.
export function IconGitCommit(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="12" cy="12" r="3.5" />
      <path {...stroke} d="M12 4.75V8.5M12 15.5V19.25" />
    </Svg>
  );
}

// An eye — "needs your eyes" / review. Distinct from the git-node PR glyphs.
export function IconEye(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M3.25 12C3.25 12 7 5.75 12 5.75C17 5.75 20.75 12 20.75 12C20.75 12 17 18.25 12 18.25C7 18.25 3.25 12 3.25 12Z"
      />
      <circle {...stroke} cx="12" cy="12" r="2.25" />
    </Svg>
  );
}

/** IconEye with a slash — "hidden from view" (the sidebar's Hide action). */
export function IconEyeOff(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M9.75 6.15C10.47 5.89 11.22 5.75 12 5.75C17 5.75 20.75 12 20.75 12C20.75 12 19.79 13.6 18.25 15.09"
      />
      <path
        {...stroke}
        d="M15.4 17.66C14.35 18.05 13.21 18.25 12 18.25C7 18.25 3.25 12 3.25 12C3.25 12 4.72 9.55 7.11 7.86"
      />
      <path {...stroke} d="M10.41 10.41A2.25 2.25 0 0 0 13.59 13.59" />
      <path {...stroke} d="M4.75 4.75L19.25 19.25" />
    </Svg>
  );
}

const COPY_SHEET_PATH =
  "M15.25 4.75H6.75C5.64543 4.75 4.75 5.64543 4.75 6.75V15.25";

export function IconCopy(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="8.75" y="8.75" width="10.5" height="10.5" rx="2" />
      <path {...stroke} d={COPY_SHEET_PATH} />
    </Svg>
  );
}

// iconic-pro `link` — two chain hooks joined by a diagonal bar: copy/share a
// link. (Was a hand-drawn two-path variant, which read heavier and rounder
// than the rest of the set next to it in the session header.)
export function IconLink(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M16.75 13.25L18 12C19.6569 10.3431 19.6569 7.65685 18 6V6C16.3431 4.34315 13.6569 4.34315 12 6L10.75 7.25"
      />
      <path
        {...stroke}
        d="M7.25 10.75L6 12C4.34315 13.6569 4.34315 16.3431 6 18V18C7.65685 19.6569 10.3431 19.6569 12 18L13.25 16.75"
      />
      <path {...stroke} d="M14.25 9.75L9.75 14.25" />
    </Svg>
  );
}

// Envelope — "mark as unread".
export function IconMail(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="3.75" y="5.75" width="16.5" height="12.5" rx="2.5" />
      <path {...stroke} d="M4.5 7.5l6.6 4.9a1.5 1.5 0 0 0 1.8 0l6.6-4.9" />
    </Svg>
  );
}

// Dashed ring — "set status" (the status-lane dot, unfilled).
export function IconStatusRing(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="12" cy="12" r="7.25" strokeDasharray="2.6 2.6" />
    </Svg>
  );
}

// iconic-pro `trending-up` glyph, used for Analytics.
export function IconChart(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M4.75 11.25L10.25 5.75" />
      <path
        {...stroke}
        d="M5.75 19.2502H6.25C6.80229 19.2502 7.25 18.8025 7.25 18.2502V15.75C7.25 15.1977 6.80229 14.75 6.25 14.75H5.75C5.19772 14.75 4.75 15.1977 4.75 15.75V18.2502C4.75 18.8025 5.19772 19.2502 5.75 19.2502Z"
      />
      <path
        {...stroke}
        d="M11.75 19.2502H12.25C12.8023 19.2502 13.25 18.8025 13.25 18.2502V12.75C13.25 12.1977 12.8023 11.75 12.25 11.75H11.75C11.1977 11.75 10.75 12.1977 10.75 12.75V18.2502C10.75 18.8025 11.1977 19.2502 11.75 19.2502Z"
      />
      <path
        {...stroke}
        d="M17.75 19.2502H18.25C18.8023 19.2502 19.25 18.8025 19.25 18.2502V5.75C19.25 5.19772 18.8023 4.75 18.25 4.75H17.75C17.1977 4.75 16.75 5.19772 16.75 5.75V18.2502C16.75 18.8025 17.1977 19.2502 17.75 19.2502Z"
      />
      <path {...stroke} d="M11.25 8.25V4.75H7.75" />
    </Svg>
  );
}

export function IconShapes(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M15 5.75C15 7.5 13.5 9 11.75 9C13.5 9 15 10.5 15 12.25C15 10.5 16.5 9 18.25 9C16.5 9 15 7.5 15 5.75ZM8 13.75C8 16 8 16 5.75 16C8 16 8 16 8 18.25C8 16 8 16 10.25 16C8 16 8 16 8 13.75ZM17 14.75L14.75 17L17 19.25L19.25 17L17 14.75ZM7 5.75L5.75 7L7 8.25L8.25 7L7 5.75Z"
      />
    </Svg>
  );
}

// ⋯ more options. Deliberately NOT iconic-pro's `dots-horizontal` geometry
// (8/12/16 at r=1): that spans only 10 of the 24 grid and renders visibly
// smaller than the stroke glyphs beside it, which draw ~14.5.
//
// Sized against the text `⋯` this replaced in the session header, measured by
// rasterising it at 20px in the app font: 15.5px total span, ~2.4px dots. An
// ellipsis carries far less ink than a stroke glyph, so it needs to run
// slightly WIDER than their 14.5 units to hold equal presence — matching
// their span makes it look shrunken.
//
// r=1.5 puts each dot at 3 units, 2× the set's 1.5 stroke. A filled dot reads
// lighter than a continuous stroke of the same width (there's simply less of
// it), so matching the stroke width 1:1 leaves the mark looking thin next to
// the glyphs beside it.
export function IconDotsHorizontal(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" />
    </Svg>
  );
}

// Six raised dots, the handle for a row that can be reordered.
export function IconGripVertical(p: IconProps) {
  return (
    <Svg {...p}>
      {[8, 12, 16].flatMap((cy) => [
        <circle key={`l-${cy}`} cx="9" cy={cy} r="1.1" fill="currentColor" />,
        <circle key={`r-${cy}`} cx="15" cy={cy} r="1.1" fill="currentColor" />,
      ])}
    </Svg>
  );
}

// The Desk: a desk lamp — the same object the native app puts on this surface
// (SF Symbols `lamp.desk`), so the two clients name the Desk with one mark.
// Traced from that symbol onto the 24 grid: shade up and to the right, its
// mouth open down-right; the arm folds back down-left over an elbow to a base
// bar. The elbow is what separates a desk lamp from a funnel at 24px — a
// straight arm reads as a watering can. The shade's two sides bow outward for
// the same reason: drawn as a flat triangle it reads as a pennant on a pole,
// and the mouth has to run ~1.6× the cone's length (the symbol's own ratio) or
// the lamp looks folded shut.
export function IconDesk(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M10.9 4.4Q15.9 4.15 19.4 5.05L11.8 11.9Q9.75 8.1 10.9 4.4Z"
      />
      <path {...stroke} d="M10.9 4.4L5.2 11.9L8.35 15.4L8.9 19.25" />
      <path {...stroke} d="M4.75 19.25H14.1" />
    </Svg>
  );
}

// The two sidebar densities, drawn as the thing they change: rows in a list.
// Both fill the same 6.75–17.25 band, so the pair differs in how many lines
// fit it and how much air each one gets — which is exactly what the setting
// does to the rail. Reading the count is what makes them legible side by side;
// spacing alone is too fine a difference at 20px.
//
// Four lines is the floor for the compact mark. At five the 1.5 stroke leaves
// about a pixel of air between rows once the glyph is scaled to 20px, and the
// whole thing sinters into a grey block.
export function IconDensityDefault(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M4.75 6.75H19.25" />
      <path {...stroke} d="M4.75 12H19.25" />
      <path {...stroke} d="M4.75 17.25H19.25" />
    </Svg>
  );
}

export function IconDensityCompact(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M4.75 6.75H19.25" />
      <path {...stroke} d="M4.75 10.25H19.25" />
      <path {...stroke} d="M4.75 13.75H19.25" />
      <path {...stroke} d="M4.75 17.25H19.25" />
    </Svg>
  );
}

// Diff layouts: one shared column for unified, two parallel columns for split.
export function IconDiffUnified(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="4.75" y="5.25" width="14.5" height="13.5" rx="1.5" />
      <path {...stroke} d="M8 9H16" />
      <path {...stroke} d="M8 12H14" />
      <path {...stroke} d="M8 15H16" />
    </Svg>
  );
}

export function IconDiffSplit(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="4.75" y="5.25" width="14.5" height="13.5" rx="1.5" />
      <path {...stroke} d="M12 5.25V18.75" />
      <path {...stroke} d="M7.25 9H9.5M14.5 9H16.75" />
      <path {...stroke} d="M7.25 12H9.5M14.5 12H16.75" />
      <path {...stroke} d="M7.25 15H9.5M14.5 15H16.75" />
    </Svg>
  );
}

// Asset layouts: four tiles for the pictures, named rows for the list. Both
// draw the SAME set, so the pair has to differ in shape rather than in count:
// the grid is all tile, the list is a small tile with its name beside it,
// which is what each mode actually puts on screen.
export function IconViewGrid(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="4.75" y="4.75" width="6" height="6" rx="1.5" />
      <rect {...stroke} x="13.25" y="4.75" width="6" height="6" rx="1.5" />
      <rect {...stroke} x="4.75" y="13.25" width="6" height="6" rx="1.5" />
      <rect {...stroke} x="13.25" y="13.25" width="6" height="6" rx="1.5" />
    </Svg>
  );
}

export function IconViewList(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} x="4.75" y="5.25" width="3.5" height="3.5" rx="1" />
      <path {...stroke} d="M11.25 7H19.25" />
      <rect {...stroke} x="4.75" y="10.25" width="3.5" height="3.5" rx="1" />
      <path {...stroke} d="M11.25 12H19.25" />
      <rect {...stroke} x="4.75" y="15.25" width="3.5" height="3.5" rx="1" />
      <path {...stroke} d="M11.25 17H19.25" />
    </Svg>
  );
}
