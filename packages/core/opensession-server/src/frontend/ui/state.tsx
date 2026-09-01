import { mergeStylexProps, mergeStylexOverrideClassName } from "./cn";
import { utilityClassName } from "./cn";
import * as React from "react";
import { IconX } from "../components/icons";
import { cn } from "./cn";
import { PageLoader } from "./page-loader";
import { Spinner } from "./spinner";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  textFaint: {
    color: "var(--text-faint)",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  inlineFlex: {
    display: "inline-flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  AnimationGhostInVarDurVarEase180msBoth: {
    animation: "ghost-in var(--dur) var(--ease) 180ms both",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  h25: {
    height: "calc(4px * 2.5)",
  },
  w26: {
    width: "26%",
  },
  mxAuto: {
    marginInline: "auto",
  },
  mb45: {
    marginBottom: "calc(4px * 4.5)",
  },
  flex: {
    display: "flex",
  },
  wFull: {
    width: "100%",
  },
  maxWVarSessionCol: {
    maxWidth: "var(--session-col)",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  shrink0: {
    flexShrink: "0",
  },
  selfCenter: {
    alignSelf: "center",
  },
  whitespaceNowrap: {
    whiteSpace: "nowrap",
  },
  underline: {
    textDecorationLine: "underline",
  },
  underlineOffset2: {
    textUnderlineOffset: "2px",
  },
  opacity80: {
    opacity: "80%",
  },
  transitionOpacity: {
    transitionProperty: "opacity",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  hoverOpacity100: {
    "@media (hover: hover)": {
      ":hover": {
        opacity: "100%",
      },
    },
  },
  relative: {
    position: "relative",
  },
  Mr1: {
    marginRight: "calc(4px * -1)",
  },
  size6: {
    width: "calc(4px * 6)",
    height: "calc(4px * 6)",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  opacity60: {
    opacity: "60%",
  },
  beforeAbsolute: {
    "::before": {
      content: '""',
      position: "absolute",
    },
  },
  beforeInset2: {
    "::before": {
      content: '""',
      inset: "calc(4px * -2)",
    },
  },
  beforeContent: {
    "::before": {
      content: "''",
    },
  },
});

/**
 * Async-state primitives — one language for "nothing here yet", "fetching"
 * and "that went wrong".
 *
 * These three states were saying the same thing four different ways: the
 * `.loading`/`.empty` classes (centred, faint, 40px of air), one-off inline
 * divs (`px-4 py-3 text-dim text-supporting`), the `.form-error` box, and
 * bespoke bordered panels. Same meaning, four appearances — so a surface
 * looked different depending on which one its author reached for.
 *
 * The shapes are unchanged; what's shared now is the vocabulary:
 *
 *  - `placement` decides the frame, not the meaning. A state that stands in
 *    for a whole region gets air and centring (`block`); one standing in for
 *    a card draws that card's surface (`card`); one living *inside* a card's
 *    row list just takes the row's padding and stays left-aligned (`row`), so
 *    it lines up with the rows it replaces instead of floating in the middle.
 *  - loading is the quietest register, and its mark follows the placement: a
 *    `block` stands in for a whole region and wears the larger waiting ring
 *    (`PageLoader`), while a `row` or `card` uses the smaller `Spinner`. Never
 *    the PixelSpinner, which means a model is generating,
 *    empty sits one step up (dim, with an optional title/icon/action when
 *    there's something to *do* about it), and alerts are the only state that
 *    gets a surface and a hue.
 *  - a mark is what waiting looks like when the shape ISN'T known. When it is,
 *    prefer a ghost (`Skeleton` and the shapes built on it): a label with a
 *    spinner says the app is busy, while rows in the shape of the rows that
 *    are coming say what is arriving and land it without moving the page.
 *
 * So `LoadingState` is for a thing WORKING — a probe, a sign-in being
 * prepared, a save — and a skeleton is for content ARRIVING. Reach for the
 * mark only when there is no shape to stand in for.
 *
 * `ui/notice.tsx` (ErrorNotice + its own LoadingState) is the earlier, partial
 * take on this; prefer these.
 */

/** Where the state sits — decides padding, alignment and whether it draws its
 * own surface. Never the meaning: the same state reads the same everywhere. */
export type StatePlacement = "block" | "card" | "row";

const placements: Record<StatePlacement, string> = {
  // Stands in for a whole region: the `.loading`/`.empty` look (40px of air,
  // centred) so it reads as "this area is empty", not "this row is".
  block: utilityClassName(
    "flex flex-col items-center justify-center gap-2 py-10 text-center",
  ),
  // Stands in for a card: borrows SettingCard's surface so the page's rhythm
  // survives the emptiness.
  card: utilityClassName("rounded-2xl bg-raised px-5 py-4"),
  // Lives inside a card's row list: matches SettingRow's padding so it lands
  // on the same left edge as the rows it replaces.
  row: utilityClassName("px-5 py-4"),
};

export function EmptyState({
  icon,
  title,
  action,
  placement = "block",
  className,
  children,
  ...props
}: Omit<React.ComponentPropsWithoutRef<"div">, "title"> & {
  /** 22px glyph from components/icons.tsx. Block placement only — in a row
   *  or card it would out-weigh the sentence beside it. */
  icon?: React.ReactNode;
  title?: React.ReactNode;
  /** Usually a <Button size="sm">: the one thing that fills the emptiness. */
  action?: React.ReactNode;
  placement?: StatePlacement;
}) {
  const block = placement === "block";
  return (
    <div className={cn(placements[placement], className)} {...props}>
      {block && icon && <span {...stylex.props(sx.textFaint)}>{icon}</span>}
      {title && (
        <div
          {...stylex.props(sx.fontMedium, sx.textFg, typography.controlLabel)}
        >
          {title}
        </div>
      )}
      {children && (
        <div
          className={cn(
            utilityClassName("text-supporting leading-snug text-dim"),
            block && utilityClassName("max-w-[46ch]"),
          )}
        >
          {children}
        </div>
      )}
      {action && (
        <div
          className={cn(
            block ? utilityClassName("mt-1") : utilityClassName("mt-2"),
          )}
        >
          {action}
        </div>
      )}
    </div>
  );
}

export function LoadingState({
  placement = "block",
  spinner = true,
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & {
  placement?: StatePlacement;
  spinner?: boolean;
}) {
  // The mark follows the placement, because the placement is already the
  // answer to "how much is waiting". A `block` stands in for a whole region,
  // which is what the launch wave is for, and it sits ABOVE the label there —
  // the splash's own arrangement, and the one that reads as a page rather than
  // as a sentence with a mark in front of it. A `row` or a `card` is a small
  // thing working inside a page that has already arrived, so it keeps the ring
  // on the label's line, where bars would be illegible anyway.
  const block = placement === utilityClassName("block");
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(placements[placement], className)}
      {...props}
    >
      {block && spinner && (
        <PageLoader className={mergeStylexOverrideClassName("", sx.textDim)} />
      )}
      <div
        {...stylex.props(
          sx.inlineFlex,
          sx.itemsCenter,
          sx.gap2,
          sx.textFaint,
          typography.supporting,
        )}
      >
        {!block && spinner && <Spinner />}
        {children}
      </div>
    </div>
  );
}

/**
 * The frame every skeleton wears, so a ghost is one thing in this app rather
 * than a shape each surface re-derives: it announces itself to a reader, it
 * breathes, and it holds itself back a beat before it shows.
 *
 * The hold-back is the part worth stating. Most of what these stand in for
 * arrives fast enough that a placeholder would flash and go, which is more
 * distracting than the gap it filled, so only a wait long enough to notice
 * gets stood in for. It is spelled as a delayed CSS fade (`ghost-in`, base.css)
 * rather than a mounted-later component, which is what keeps the shape in
 * layout from the first paint: the height is reserved while the ghost is still
 * invisible, so real rows replace it in place instead of dropping the page
 * down as they land.
 *
 * Two elements, and they cannot be collapsed into one: the fade and the breath
 * both animate opacity, so the delay sits on the outside and the pulse on the
 * inside. `className` styles the inner box — the one that IS the ghost.
 */
export function Skeleton({
  label = "Loading",
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      {...stylex.props(sx.AnimationGhostInVarDurVarEase180msBoth)}
      {...props}
    >
      <div className={cn(utilityClassName("animate-pulse"), className)}>
        {children}
      </div>
    </div>
  );
}

/**
 * One bar of ghost ink — a line of text that hasn't arrived. The height is a
 * title's; pass `h-2.5` for the supporting line under it. Every skeleton draws
 * with this so they share a weight and a corner, and so a change to what a
 * placeholder is made of is one edit.
 */
export function SkeletonBar({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(utilityClassName("h-3 rounded-sm bg-hover"), className)}
      {...props}
    />
  );
}

/**
 * Ragged on purpose — a column of equal bars reads as a component, and a
 * component that never resolves reads as a bug. Uneven ones read as titles
 * about to arrive. Literal utilities rather than a built string or an inline
 * width: Tailwind only compiles class names it can find in the source.
 */
const SKELETON_WIDTHS = [
  utilityClassName("w-[62%]"),
  utilityClassName("w-[41%]"),
  utilityClassName("w-[73%]"),
  utilityClassName("w-[52%]"),
  utilityClassName("w-[35%]"),
  utilityClassName("w-[66%]"),
  utilityClassName("w-[47%]"),
  utilityClassName("w-[58%]"),
];

/**
 * A list that hasn't arrived, standing in for the rows it will become.
 *
 * The alternative — showing the empty state until data lands — is what makes a
 * slow load read as data loss rather than as waiting: "Nothing archived yet"
 * is a confident, false statement about a list that is merely in flight.
 *
 * One slow breath across the whole block, not a travelling sheen: the rows are
 * the message, and a shimmer would drag the eye along them. Under
 * prefers-reduced-motion base.css stops it after a cycle, which is the right
 * amount of "gentler, not zero" for a placeholder.
 */
export function ListSkeleton({
  rows = 6,
  variant = "cards",
  rowClassName,
  label = "Loading",
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & {
  rows?: number;
  /**
   * Which list this stands in for. `cards` is a column of separate panels;
   * `rows` is the divided list inside one `CardList`; `bare` is a quiet,
   * borderless navigation list. Standing in for the wrong one is its own kind
   * of lie — the placeholder should be the shape that replaces it.
   */
  variant?: "cards" | "rows" | "bare";
  /** Match the geometry of the row this stands in for. */
  rowClassName?: string;
  label?: string;
}) {
  const cards = variant === "cards";
  const divided = variant === "rows";
  return (
    <Skeleton
      label={label}
      className={cn(
        utilityClassName("flex flex-col"),
        cards
          ? utilityClassName("gap-1.5")
          : divided
            ? "[&>*+*]:border-t [&>*+*]:border-line"
            : utilityClassName("gap-0.5"),
        className,
      )}
      {...props}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={cn(
            cards
              ? utilityClassName(
                  "rounded-control border border-line bg-panel px-3.5 py-[11px]",
                )
              : utilityClassName("px-3.5 py-[13px]"),
            rowClassName,
          )}
        >
          <SkeletonBar
            className={SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}
          />
          {cards && (
            <SkeletonBar
              className={mergeStylexOverrideClassName(
                "",
                sx.mt2,
                sx.h25,
                sx.w26,
              )}
            />
          )}
        </div>
      ))}
    </Skeleton>
  );
}

/**
 * A conversation that hasn't arrived, in the shape it will take: two turns of
 * ghost prose with a ghost bubble above each.
 *
 * The alternative is a spinner in the middle of the canvas, and in this app a
 * spinner says the wrong thing — the PixelSpinner is what a session wears while
 * an agent is WORKING, so wearing it to fetch a transcript reads as "the model
 * is generating" for a session that finished hours ago. Ghost rows can only
 * mean "the words are on their way".
 *
 * The geometry is the transcript's own: the reading column, `mb-4.5` between
 * turns, bubbles right-aligned and rounded like `msgBubbleUser`. So the ghosts
 * sit where the real rows will, and nothing jumps when they land. What it does
 * NOT reuse is `msgRow` itself — that string carries the `.msg` hook
 * `useSessionScroll` queries to find turn boundaries, and a placeholder is not
 * a turn to scroll to.
 */
const TRANSCRIPT_GHOST_TURNS: {
  bubble: string;
  lines: string[];
}[] = [
  { bubble: "h-[42px] w-[42%]", lines: ["w-[68%]", "w-[84%]", "w-[51%]"] },
  { bubble: "h-[32px] w-[28%]", lines: ["w-[76%]", "w-[38%]"] },
];

export function TranscriptSkeleton({
  className,
  label = "Loading conversation",
  ...props
}: React.ComponentPropsWithoutRef<"div"> & { label?: string }) {
  return (
    <Skeleton
      label={label}
      className={cn(utilityClassName("flex flex-col"), className)}
      {...props}
    >
      {TRANSCRIPT_GHOST_TURNS.map((turn) => (
        <React.Fragment key={turn.bubble}>
          <div
            {...stylex.props(
              sx.mxAuto,
              sx.mb45,
              sx.flex,
              sx.wFull,
              sx.maxWVarSessionCol,
              sx.flexCol,
            )}
          >
            <SkeletonBar
              className={cn(
                utilityClassName("self-end rounded-lg"),
                turn.bubble,
              )}
            />
          </div>
          <div
            {...stylex.props(
              sx.mxAuto,
              sx.mb45,
              sx.flex,
              sx.wFull,
              sx.maxWVarSessionCol,
              sx.flexCol,
              sx.gap25,
            )}
          >
            {turn.lines.map((width) => (
              <SkeletonBar key={width} className={width} />
            ))}
          </div>
        </React.Fragment>
      ))}
    </Skeleton>
  );
}

type AlertVariant = "error" | "warn" | "info";

// Border at 40% of the hue over its soft fill — the `.form-error` recipe,
// generalised. Spelled `border-<tone>/40`, the same way `Badge`'s outline set
// spells it; a hand-written color-mix here is a second vocabulary for one
// recipe.
const alertVariants: Record<AlertVariant, string> = {
  error: utilityClassName("border-red/40 bg-red-soft text-red"),
  warn: utilityClassName("border-yellow/40 bg-yellow-soft text-yellow"),
  info: utilityClassName("border-blue/40 bg-blue-soft text-blue"),
};

export function InlineAlert({
  variant = "error",
  title,
  onDismiss,
  onRetry,
  retryLabel = "Try again",
  className,
  children,
  onClick,
  ...props
}: Omit<React.ComponentPropsWithoutRef<"div">, "title"> & {
  variant?: AlertVariant;
  title?: React.ReactNode;
  /** Renders a × and, preserving how these boxes have always behaved, makes
   *  the whole box dismiss on click — the × is what makes that discoverable
   *  and reachable from the keyboard. */
  onDismiss?: () => void;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        utilityClassName(
          "flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm",
        ),
        alertVariants[variant],
        onDismiss && utilityClassName("cursor-pointer"),
        className,
      )}
      onClick={(e) => {
        onClick?.(e);
        onDismiss?.();
      }}
      {...props}
    >
      <div {...stylex.props(sx.minW0, sx.flex1)}>
        {title && <div {...stylex.props(sx.fontMedium)}>{title}</div>}
        <div
          className={cn(
            utilityClassName("min-w-0"),
            title && utilityClassName("mt-0.5 opacity-90"),
          )}
        >
          {children}
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          {...mergeStylexProps(
            "focus-ring",
            sx.shrink0,
            sx.selfCenter,
            sx.whitespaceNowrap,
            sx.fontMedium,
            sx.underline,
            sx.underlineOffset2,
            sx.opacity80,
            sx.transitionOpacity,
            sx.hoverOpacity100,
            typography.supporting,
          )}
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
        >
          {retryLabel}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          // Visually 24px so it sits inside the box's 10px padding; the
          // pseudo-element takes the hit area out to 40px.
          {...mergeStylexProps(
            "focus-ring",
            sx.relative,
            sx.Mr1,
            sx.flex,
            sx.size6,
            sx.shrink0,
            sx.itemsCenter,
            sx.justifyCenter,
            sx.roundedControl,
            sx.opacity60,
            sx.transitionOpacity,
            sx.hoverOpacity100,
            sx.beforeAbsolute,
            sx.beforeInset2,
            sx.beforeContent,
          )}
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          <IconX size={20} />
        </button>
      )}
    </div>
  );
}
