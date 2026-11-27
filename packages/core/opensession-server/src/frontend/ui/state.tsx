import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import {
  IconInfoCircle,
  IconWarningTriangle,
  IconX,
} from "../components/icons";
import { cn } from "./cn";
import { SELECTABLE } from "./dialog-styles";
import { focusStyles } from "./focus-styles";
import { PageLoader } from "./page-loader";
import { Spinner } from "./spinner";
import { sx } from "./sx";
import {
  color,
  corner,
  geometry,
  leading,
  media,
  motion,
  opacity,
  radius,
  space,
  text,
  weight,
} from "./tokens.stylex";

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

/** A tone's ink at a fixed strength over whatever is behind it. */
const ink = (c: string, pct: number) =>
  `color-mix(in oklab, ${c} ${pct}%, transparent)`;

const pulse = stylex.keyframes({ "50%": { opacity: 0.5 } });

const styles = stylex.create({
  // Stands in for a whole region: the `.loading`/`.empty` look (40px of air,
  // centred) so it reads as "this area is empty", not "this row is".
  block: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s8,
    paddingBlock: space.s40,
    textAlign: "center",
  },
  // Stands in for a card: borrows SettingCard's surface so the page's rhythm
  // survives the emptiness.
  card: {
    borderRadius: radius.xxl,
    ["cornerShape"]: corner.squircle,
    backgroundColor: color.raised,
    paddingInline: space.s20,
    paddingBlock: space.s16,
  },
  // Lives inside a card's row list: matches SettingRow's padding so it lands
  // on the same left edge as the rows it replaces.
  row: { paddingInline: space.s20, paddingBlock: space.s16 },

  emptyIcon: { color: color.faint },
  emptyTitle: {
    fontSize: text.label,
    fontWeight: weight.medium,
    color: color.fg,
  },
  emptyBody: {
    fontSize: text.label,
    fontWeight: weight.regular,
    lineHeight: leading.snug,
    color: color.dim,
  },
  measure: { maxWidth: "46ch" },
  actionBlock: { marginTop: space.s4 },
  actionInline: { marginTop: space.s8 },
  loadingLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s8,
    fontSize: text.label,
    fontWeight: weight.regular,
    color: color.faint,
  },
  dim: { color: color.dim },

  // The delay sits on the outside and the breath on the inside: both
  // animate opacity, so they cannot share an element.
  ghostFrame: {
    animationName: "ghost-in",
    animationDuration: motion.standard,
    animationTimingFunction: motion.ease,
    animationDelay: motion.ghostDelay,
    animationFillMode: "both",
  },
  ghost: {
    animationName: pulse,
    animationDuration: motion.breath,
    animationTimingFunction: motion.breathEase,
    animationIterationCount: "infinite",
  },
  bar: {
    height: space.s12,
    borderRadius: radius.sm,
    ["cornerShape"]: corner.squircle,
    backgroundColor: color.hover,
  },
  barSupporting: { marginTop: space.s8, height: space.s10 },
  barWidth: (width: string) => ({ width }),

  column: { display: "flex", flexDirection: "column" },
  cardsGap: { gap: space.s6 },
  bareGap: { gap: space.s2 },
  ghostCard: {
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    borderWidth: geometry.hairline,
    borderStyle: "solid",
    borderColor: color.line,
    backgroundColor: color.panel,
    paddingInline: space.s14,
    paddingBlock: geometry.ghostCardPadBlock,
  },
  ghostRow: {
    paddingInline: space.s14,
    paddingBlock: geometry.ghostRowPadBlock,
  },
  ghostRowDivided: {
    borderTopWidth: geometry.hairline,
    borderTopStyle: "solid",
    borderTopColor: color.line,
  },
  turn: {
    marginInline: "auto",
    marginBottom: geometry.turnGap,
    display: "flex",
    width: "100%",
    maxWidth: geometry.sessionColumn,
    flexDirection: "column",
  },
  turnLines: { gap: space.s10 },
  bubble: (height: string, width: string) => ({ height, width }),
  bubbleBar: {
    alignSelf: "flex-end",
    borderRadius: radius.lg,
  },

  plain: {
    display: "flex",
    alignItems: "center",
    gap: space.s8,
    fontSize: text.label,
    fontWeight: weight.regular,
    color: color.dim,
  },
  shrinkable: { minWidth: 0 },
  noShrink: { flexShrink: 0 },
  plainTitle: { fontWeight: weight.medium, color: color.fg },
  plainRetry: {
    flexShrink: 0,
    whiteSpace: "nowrap",
    borderRadius: radius.sm,
    ["cornerShape"]: corner.squircle,
    fontWeight: weight.medium,
    color: color.fg,
    textUnderlineOffset: geometry.underlineOffset,
    textDecorationLine: {
      default: null,
      ":hover": { default: null, [media.hover]: "underline" },
    },
  },
  dismiss: {
    position: "relative",
    display: "flex",
    width: space.s24,
    height: space.s24,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    "::before": {
      content: "''",
      position: "absolute",
      inset: `calc(-1 * ${space.s8})`,
    },
  },
  plainDismiss: {
    marginInlineStart: "auto",
    color: {
      default: color.faint,
      ":hover": { default: null, [media.hover]: color.fg },
    },
    transitionProperty:
      "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
  },

  box: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s8,
    borderRadius: radius.md,
    ["cornerShape"]: corner.squircle,
    borderWidth: geometry.hairline,
    borderStyle: "solid",
    paddingInline: space.s12,
    paddingBlock: space.s10,
    fontSize: text.label,
    lineHeight: leading.label,
  },
  error: {
    borderColor: ink(color.red, 40),
    backgroundColor: color.redSoft,
    color: color.red,
  },
  warn: {
    borderColor: ink(color.yellow, 40),
    backgroundColor: color.yellowSoft,
    color: color.yellow,
  },
  info: {
    borderColor: ink(color.blue, 40),
    backgroundColor: color.blueSoft,
    color: color.blue,
  },
  errorInk: { color: color.red },
  warnInk: { color: color.yellow },
  infoInk: { color: color.blue },
  pressable: { cursor: "pointer" },
  boxBody: { minWidth: 0, flex: "1 1 0%" },
  boxTitle: { fontWeight: weight.medium },
  boxTitled: { marginTop: space.s2, opacity: opacity.secondary },
  boxRetry: {
    flexShrink: 0,
    alignSelf: "center",
    whiteSpace: "nowrap",
    fontSize: text.label,
    fontWeight: weight.medium,
    textDecorationLine: "underline",
    textUnderlineOffset: geometry.underlineOffset,
  },
  // Visually 24px so it sits inside the box's 10px padding; the
  // pseudo-element takes the hit area out to 40px.
  boxDismiss: { marginInlineEnd: `calc(-1 * ${space.s4})` },
  fades: {
    opacity: {
      default: opacity.glyphOnTone,
      ":hover": { default: null, [media.hover]: 1 },
    },
    transitionProperty: "opacity",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
  },
  fadesMore: {
    opacity: {
      default: opacity.glyphMuted,
      ":hover": { default: null, [media.hover]: 1 },
    },
  },
});

const placements = {
  block: styles.block,
  card: styles.card,
  row: styles.row,
} satisfies Record<StatePlacement, StyleXStyles>;

export function EmptyState({
  icon,
  title,
  action,
  placement = "block",
  className,
  style,
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
    <div {...props} {...sx(placements[placement], className, style)}>
      {block && icon && <span {...stylex.props(styles.emptyIcon)}>{icon}</span>}
      {title && <div {...stylex.props(styles.emptyTitle)}>{title}</div>}
      {children && (
        <div {...sx([styles.emptyBody, block && styles.measure], SELECTABLE)}>
          {children}
        </div>
      )}
      {action && (
        <div
          {...stylex.props(block ? styles.actionBlock : styles.actionInline)}
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
  style,
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
  const block = placement === "block";
  return (
    <div
      role="status"
      aria-live="polite"
      {...props}
      {...sx(placements[placement], className, style)}
    >
      {block && spinner && (
        <PageLoader className={stylex.props(styles.dim).className} />
      )}
      <div {...sx(styles.loadingLabel, SELECTABLE)}>
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
  style,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      {...stylex.props(styles.ghostFrame)}
      {...props}
    >
      <div {...sx(styles.ghost, className, style)}>{children}</div>
    </div>
  );
}

/**
 * One bar of ghost ink — a line of text that hasn't arrived. The height is a
 * title's; `line="supporting"` is the shorter line under one, with the space
 * above it. Every skeleton draws with this so they share a weight and a
 * corner, and so a change to what a placeholder is made of is one edit.
 */
export function SkeletonBar({
  width,
  line = "title",
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & {
  /** How much of the row the line it stands in for takes, e.g. `"62%"`. */
  width?: string;
  line?: "title" | "supporting";
}) {
  return (
    <div
      {...props}
      {...sx(
        [
          styles.bar,
          line === "supporting" && styles.barSupporting,
          width !== undefined && styles.barWidth(width),
        ],
        className,
        style,
      )}
    />
  );
}

/**
 * Ragged on purpose — a column of equal bars reads as a component, and a
 * component that never resolves reads as a bug. Uneven ones read as titles
 * about to arrive.
 */
const SKELETON_WIDTHS = [
  "62%",
  "41%",
  "73%",
  "52%",
  "35%",
  "66%",
  "47%",
  "58%",
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
  style,
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
      {...props}
      {...sx(
        [
          styles.column,
          cards && styles.cardsGap,
          !cards && !divided && styles.bareGap,
        ],
        className,
        style,
      )}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          {...sx(
            [
              cards ? styles.ghostCard : styles.ghostRow,
              divided && i > 0 && styles.ghostRowDivided,
            ],
            rowClassName,
          )}
        >
          <SkeletonBar width={SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]} />
          {cards && <SkeletonBar width="26%" line="supporting" />}
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
 * turns, bubbles right-aligned and rounded-xs like `msgBubbleUser`. So the ghosts
 * sit where the real rows will, and nothing jumps when they land. What it does
 * NOT reuse is `msgRow` itself — that string carries the `.msg` hook
 * `useSessionScroll` queries to find turn boundaries, and a placeholder is not
 * a turn to scroll to.
 */
const TRANSCRIPT_GHOST_TURNS: {
  bubble: { height: string; width: string };
  lines: string[];
}[] = [
  { bubble: { height: "42px", width: "42%" }, lines: ["68%", "84%", "51%"] },
  { bubble: { height: "32px", width: "28%" }, lines: ["76%", "38%"] },
];

export function TranscriptSkeleton({
  className,
  style,
  label = "Loading conversation",
  ...props
}: React.ComponentPropsWithoutRef<"div"> & { label?: string }) {
  return (
    <Skeleton label={label} {...props} {...sx(styles.column, className, style)}>
      {TRANSCRIPT_GHOST_TURNS.map(({ bubble, lines }) => (
        <React.Fragment key={bubble.width}>
          <div {...stylex.props(styles.turn)}>
            <div
              {...stylex.props(
                styles.bar,
                styles.bubbleBar,
                styles.bubble(bubble.height, bubble.width),
              )}
            />
          </div>
          <div {...stylex.props(styles.turn, styles.turnLines)}>
            {lines.map((width) => (
              <SkeletonBar key={width} width={width} />
            ))}
          </div>
        </React.Fragment>
      ))}
    </Skeleton>
  );
}

type AlertVariant = "error" | "warn" | "info";

// Border at 40% of the hue over its soft fill — the `.form-error` recipe,
// generalised, with the same `ink` mix `Badge`'s outline set uses.
const alertVariants = {
  error: styles.error,
  warn: styles.warn,
  info: styles.info,
} satisfies Record<AlertVariant, StyleXStyles>;

// The plain appearance drops the box for one quiet line led by a tinted glyph,
// for a note under a control (a composer) where a filled box would outweigh
// the control itself.
const alertGlyphs: Record<
  AlertVariant,
  (p: React.ComponentProps<typeof IconInfoCircle>) => React.ReactElement
> = {
  error: IconWarningTriangle,
  warn: IconWarningTriangle,
  info: IconInfoCircle,
};

const alertTextColors = {
  error: styles.errorInk,
  warn: styles.warnInk,
  info: styles.infoInk,
} satisfies Record<AlertVariant, StyleXStyles>;

export function InlineAlert({
  variant = "error",
  appearance = "box",
  title,
  onDismiss,
  onRetry,
  retryLabel = "Try again",
  className,
  style,
  children,
  onClick,
  ...props
}: Omit<React.ComponentPropsWithoutRef<"div">, "title"> & {
  variant?: AlertVariant;
  appearance?: "box" | "plain";
  title?: React.ReactNode;
  /** Renders a × and, preserving how these boxes have always behaved, makes
   *  the whole box dismiss on click — the × is what makes that discoverable
   *  and reachable from the keyboard. */
  onDismiss?: () => void;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  if (appearance === "plain") {
    const Glyph = alertGlyphs[variant];
    return (
      <div
        role="alert"
        onClick={onClick}
        {...props}
        {...sx(styles.plain, cn(SELECTABLE, className), style)}
      >
        <Glyph
          aria-hidden
          className={
            stylex.props(styles.noShrink, alertTextColors[variant]).className
          }
        />
        <div {...stylex.props(styles.shrinkable)}>
          {title && <span {...stylex.props(styles.plainTitle)}>{title} </span>}
          {children}
        </div>
        {onRetry && (
          <button
            type="button"
            {...stylex.props(styles.plainRetry, focusStyles.ring)}
            onClick={onRetry}
          >
            {retryLabel}
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            aria-label="Dismiss"
            {...stylex.props(
              styles.dismiss,
              styles.plainDismiss,
              focusStyles.ring,
            )}
            onClick={onDismiss}
          >
            <IconX size={20} />
          </button>
        )}
      </div>
    );
  }
  return (
    <div
      role="alert"
      onClick={(e) => {
        onClick?.(e);
        onDismiss?.();
      }}
      {...props}
      {...sx(
        [styles.box, alertVariants[variant], onDismiss && styles.pressable],
        className,
        style,
      )}
    >
      <div {...stylex.props(styles.boxBody)}>
        {title && <div {...stylex.props(styles.boxTitle)}>{title}</div>}
        <div
          {...stylex.props(
            styles.shrinkable,
            Boolean(title) && styles.boxTitled,
          )}
        >
          {children}
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          {...stylex.props(styles.boxRetry, styles.fades, focusStyles.ring)}
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
          {...stylex.props(
            styles.dismiss,
            styles.boxDismiss,
            styles.fades,
            styles.fadesMore,
            focusStyles.ring,
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
