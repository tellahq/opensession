import type { PrTone } from "./pr-refs";

/**
 * The PR glyph's color language, shared by every surface that paints a pull
 * request's state: purple = merged, faint = closed or draft, red = blocked
 * (conflict / failing checks / changes requested), yellow = checks running,
 * green = open and healthy.
 *
 * Callers normalize their own row shape into `PrStatusInput` — the sidebar's
 * `WsPrStatusMark` still carries its own copy for session-shaped input, since it
 * additionally paints "no PR" rows.
 */
export interface PrStatusInput {
  state?: "OPEN" | "MERGED" | "CLOSED" | null;
  isDraft?: boolean | null;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | "" */
  reviewDecision?: string | null;
  /** MERGEABLE | CONFLICTING | UNKNOWN — GitHub's async conflict probe. */
  mergeable?: string | null;
  checks?: { failed?: number; pending?: number } | null;
}

/**
 * The wash a surface paints behind the glyph when the state is a chip rather
 * than a bare mark. Same tones as the status strip's band (PR_BAR_BG), so a
 * PR's colour is the same wherever it is filled rather than drawn: purple and
 * yellow have no soft token and mix from their own variable, and the muted
 * states take translucent ink instead of a hue.
 */
const MARK_BG = {
  purple: "bg-[color-mix(in_srgb,var(--purple)_10%,transparent)]",
  muted: "bg-hover",
  red: "bg-red-soft",
  yellow: "bg-[color-mix(in_srgb,var(--yellow)_9%,transparent)]",
  green: "bg-green-soft",
} as const;

export function prStatusMark(pr: PrStatusInput): {
  className: string;
  bgClassName: string;
  label: string;
  tone: PrTone;
  /**
   * The resting state: open, healthy, and waiting on nobody in particular.
   *
   * A list of open pull requests is almost entirely this, so a surface that
   * paints hundreds of rows can render the mark as structure rather than as
   * signal and keep hue for the rows that have something to say. On a surface
   * showing one PR the green is welcome, so this is a hint, not a colour.
   */
  quiet: boolean;
} {
  if (pr.state === "MERGED")
    return {
      className: "text-purple",
      bgClassName: MARK_BG.purple,
      label: "PR merged",
      tone: "purple",
      quiet: false,
    };
  if (pr.state === "CLOSED")
    return {
      className: "text-faint",
      bgClassName: MARK_BG.muted,
      label: "PR closed",
      tone: "muted",
      quiet: false,
    };

  const conflicting = pr.mergeable === "CONFLICTING";
  const failed = (pr.checks?.failed || 0) > 0;
  const pending = (pr.checks?.pending || 0) > 0;
  const decision = (pr.reviewDecision || "").toUpperCase();
  const changesRequested = decision === "CHANGES_REQUESTED";

  if (conflicting)
    return {
      className: "text-red",
      bgClassName: MARK_BG.red,
      label: "PR has conflicts",
      tone: "red",
      quiet: false,
    };
  if (changesRequested)
    return {
      className: "text-red",
      bgClassName: MARK_BG.red,
      label: "PR changes requested",
      tone: "red",
      quiet: false,
    };
  if (failed)
    return {
      className: "text-red",
      bgClassName: MARK_BG.red,
      label: "PR checks failing",
      tone: "red",
      quiet: false,
    };
  if (pending)
    return {
      className: "text-yellow",
      bgClassName: MARK_BG.yellow,
      label: "PR checks running",
      tone: "yellow",
      quiet: false,
    };
  if (pr.isDraft)
    return {
      className: "text-faint",
      bgClassName: MARK_BG.muted,
      label: "Draft PR",
      tone: "muted",
      quiet: false,
    };
  if (decision === "APPROVED")
    return {
      className: "text-green",
      bgClassName: MARK_BG.green,
      label: "PR approved",
      tone: "green",
      quiet: false,
    };
  return {
    className: "text-green",
    bgClassName: MARK_BG.green,
    label: "PR open",
    tone: "green",
    quiet: true,
  };
}

const STATUS_TEXT: Record<string, string> = {
  "PR has conflicts": "Conflicts",
  "PR changes requested": "Changes requested",
  "PR checks failing": "Checks failing",
  "PR checks running": "Checks running",
  "Draft PR": "Draft",
};

/** Short status copy shared by compact PR references and their hover cards. */
export function prStatusDisplay(pr: PrStatusInput): {
  label: string;
  state: string;
  tone: PrTone;
} {
  const mark = prStatusMark(pr);
  const label =
    mark.label === "PR open" && pr.mergeable === "MERGEABLE"
      ? "Mergeable"
      : (STATUS_TEXT[mark.label] ??
        mark.label.replace(/^PR /, "").replace(/^./, (c) => c.toUpperCase()));
  return {
    label,
    state: label.toLowerCase().replaceAll(" ", "-"),
    tone: mark.tone,
  };
}
