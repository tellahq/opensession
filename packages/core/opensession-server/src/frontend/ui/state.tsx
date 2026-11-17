import * as React from "react";
import { IconX } from "../components/icons";
import { cn } from "./cn";
import { PageLoader } from "./page-loader";
import { Spinner } from "./spinner";

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
  block: "flex flex-col items-center justify-center gap-2 py-10 text-center",
  // Stands in for a card: borrows SettingCard's surface so the page's rhythm
  // survives the emptiness.
  card: "rounded-2xl bg-raised px-5 py-4",
  // Lives inside a card's row list: matches SettingRow's padding so it lands
  // on the same left edge as the rows it replaces.
  row: "px-5 py-4",
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
      {block && icon && <span className="text-faint">{icon}</span>}
      {title && (
        <div className="text-control-label font-medium text-fg">{title}</div>
      )}
      {children && (
        <div
          className={cn(
            "text-supporting leading-snug text-dim",
            block && "max-w-[46ch]",
          )}
        >
          {children}
        </div>
      )}
      {action && <div className={cn(block ? "mt-1" : "mt-2")}>{action}</div>}
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
  const block = placement === "block";
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(placements[placement], className)}
      {...props}
    >
      {block && spinner && <PageLoader className="text-dim" />}
      <div className="inline-flex items-center gap-2 text-supporting text-faint">
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
      className="[animation:ghost-in_var(--dur)_var(--ease)_180ms_both]"
      {...props}
    >
      <div className={cn("animate-pulse", className)}>{children}</div>
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
    <div className={cn("h-3 rounded-sm bg-hover", className)} {...props} />
  );
}

/**
 * Ragged on purpose — a column of equal bars reads as a component, and a
 * component that never resolves reads as a bug. Uneven ones read as titles
 * about to arrive. Literal utilities rather than a built string or an inline
 * width: Tailwind only compiles class names it can find in the source.
 */
const SKELETON_WIDTHS = [
  "w-[62%]",
  "w-[41%]",
  "w-[73%]",
  "w-[52%]",
  "w-[35%]",
  "w-[66%]",
  "w-[47%]",
  "w-[58%]",
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
        "flex flex-col",
        cards
          ? "gap-1.5"
          : divided
            ? "[&>*+*]:border-t [&>*+*]:border-line"
            : "gap-0.5",
        className,
      )}
      {...props}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={cn(
            cards
              ? "rounded-control border border-line bg-panel px-3.5 py-[11px]"
              : "px-3.5 py-[13px]",
            rowClassName,
          )}
        >
          <SkeletonBar
            className={SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}
          />
          {cards && <SkeletonBar className="mt-2 h-2.5 w-[26%]" />}
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
      className={cn("flex flex-col", className)}
      {...props}
    >
      {TRANSCRIPT_GHOST_TURNS.map((turn) => (
        <React.Fragment key={turn.bubble}>
          <div className="mx-auto mb-4.5 flex w-full max-w-[var(--session-col)] flex-col">
            <SkeletonBar className={cn("self-end rounded-lg", turn.bubble)} />
          </div>
          <div className="mx-auto mb-4.5 flex w-full max-w-[var(--session-col)] flex-col gap-2.5">
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
  error: "border-red/40 bg-red-soft text-red",
  warn: "border-yellow/40 bg-yellow-soft text-yellow",
  info: "border-blue/40 bg-blue-soft text-blue",
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
        "flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm",
        alertVariants[variant],
        onDismiss && "cursor-pointer",
        className,
      )}
      onClick={(e) => {
        onClick?.(e);
        onDismiss?.();
      }}
      {...props}
    >
      <div className="min-w-0 flex-1">
        {title && <div className="font-medium">{title}</div>}
        <div className={cn("min-w-0", title && "mt-0.5 opacity-90")}>
          {children}
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          className="focus-ring shrink-0 self-center whitespace-nowrap text-supporting font-medium underline underline-offset-2 opacity-80 transition-opacity hover:opacity-100"
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
          className="focus-ring relative -mr-1 flex size-6 shrink-0 items-center justify-center rounded-full opacity-60 transition-opacity hover:opacity-100 before:absolute before:-inset-2 before:content-['']"
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
