import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";
import { type as typography } from "../styles/typography.stylex";

const sx = stylex.create({
  flex: {
    display: "flex",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap1: {
    gap: "4px",
  },
  selfEnd: {
    alignSelf: "flex-end",
  },
  roundedLg: {
    borderRadius: "calc(14px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  px35: {
    paddingInline: "14px",
  },
  py25: {
    paddingBlock: "10px",
  },
  rounded2xl: {
    borderRadius: "calc(22px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  px4: {
    paddingInline: "16px",
  },
  py3: {
    paddingBlock: "12px",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  itemsBaseline: {
    alignItems: "baseline",
  },
  gapX2: {
    columnGap: "8px",
  },
  gapY05: {
    rowGap: "2px",
  },
  fontSemibold: {
    "--tw-font-weight": "var(--font-weight-semibold)",
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  breakWords: {
    overflowWrap: "break-word",
  },
  leadingRelaxed: {
    "--tw-leading": "var(--leading-relaxed)",
    lineHeight: "var(--leading-relaxed)",
  },

  maxWMin600px90: {
    maxWidth: "min(600px,90%)",
  },
});

/**
 * The support conversation's surfaces — a Plain thread as it renders in the
 * ticket pane, the workspace Conversation tab and the swipe deck.
 *
 * Every block here used to be drawn inside a hairline: a message, a note, an
 * attachment and each action all carried a box of their own, so a thread was
 * four nested outlines deep on a page whose only job is to be read.
 * `src/frontend/AGENTS.md` has the rule — a block sitting on its own fill is
 * already separated from the page, and an edge around it adds a second one. So
 * a message is a plate, a note takes the yellow wash the transcript already
 * gives a team note (lib/tinted-surface.ts), and the actions are the Button
 * primitive at its quiet weight.
 *
 * The two sides are deliberately not symmetrical, and a thread is read the way
 * a session transcript is. What you came here to read carries no surface at
 * all; your own half of the conversation is a bubble hugging the right edge.
 * Plating both sides put two facing walls of grey down the page and said who
 * spoke three times over — in the name, in the edge the message hugs, and
 * again in colour.
 */

/** A message: the head, then the message under it. Full width on both sides —
 *  which edge a message hugs is decided by the block inside, not by this row. */
export const plainEntryRow = mergeStylexClassName(
  "",
  sx.flex,
  sx.flexCol,
  sx.gap1,
);

/** A message from the customer. No surface: this is the page's content, not a
 *  card on it. */
export const plainEntryIn = mergeStylexClassName(
  "",
  sx.flex,
  sx.flexCol,
  sx.gap1,
);

/** A message from our side: a teammate's reply, the autoresponder, an agent.
 *  The transcript's own reply bubble, at the same cap, corner and padding
 *  (`msgBubbleUser`, lib/msg-classes.ts). */
export const plainEntryOut =
  mergeStylexClassName(
    "",
    sx.maxWMin600px90,
    sx.flex,
    sx.flexCol,
    sx.gap1,
    sx.selfEnd,
    sx.roundedLg,
    sx.bgPanel,
  ) +
  " " +
  mergeStylexClassName("", sx.px35, sx.py25);

/** An internal note. Full width and washed rather than plated, so it reads as
 *  an aside on the thread instead of another message in it. The wash itself is
 *  inline: `color-mix` on a token can't be a compiled utility. */
export const plainEntryNote = mergeStylexClassName(
  "",
  sx.flex,
  sx.flexCol,
  sx.gap1,
  sx.rounded2xl,
  sx.px4,
  sx.py3,
);

/** The name / channel / time line over a message. Mirrored on our own side so
 *  the name lands on the edge the message hugs — the transcript's own rule for
 *  a speaker label (lib/msg-classes.ts). */
export const plainEntryHead = mergeStylexClassName(
  "",
  sx.flex,
  sx.flexWrap,
  sx.itemsBaseline,
  sx.gapX2,
  sx.gapY05,
);

/** Who spoke. */
export const plainEntryName = mergeStylexClassName(
  "",
  typography.supporting,
  sx.fontSemibold,
  sx.textFg,
);

/** Channel and time, in one faint run: two separate spans read as two facts
 *  when they are one aside. */
export const plainEntryMeta = mergeStylexClassName(
  "",
  typography.meta,
  sx.textFaint,
);

/** The message itself, at the transcript's reading size — this is the page's
 *  content, not a preview of it. Rendered markdown, the same as a session
 *  message: a customer writing `**test**` means it, and a pasted stack trace
 *  belongs in a fence rather than in the prose. `breaks: true` on the shared
 *  renderer (lib/markdown.ts) keeps an email's hard line breaks, which is why
 *  this no longer needs `whitespace-pre-wrap`: that would double every one. */
export const plainEntryBody =
  mergeStylexClassName(
    "markdown",
    sx.breakWords,
    typography.body,
    sx.leadingRelaxed,
    sx.textFg,
  ) +
  " " +
  "[&>:first-child]:mt-0 [&>:last-child]:mb-0";
