/**
 * Transcript message classes — what used to be the `msg-*` family in
 * legacy.css.
 *
 * A message row is rendered from four surfaces (MessageBubble, SessionViewer's
 * optimistic and streaming bubbles, TurnBlock's intermediate replies, the Desk
 * pane), so the shared shapes live here instead of being re-typed — and
 * re-drifted — at each call site.
 *
 * A handful of `msg-*` names survive on the markup as bare hooks with no
 * styling of their own, because things OUTSIDE this migration name them:
 *
 *   · base.css's selection policy (`chrome isn't selectable, content is`)
 *     names .msg, .msg-label, .msg-body and .msg-system-text;
 *   · base.css owns the streaming caret animation that hangs off the
 *     `.msg-streaming` ancestor and names it again in reduced-motion rules;
 *   · useSessionScroll queries `.msg` and `.msg-user` to find turn boundaries.
 *
 * Dropping one of those class names breaks copy/paste or scroll-to-turn
 * behaviour silently, so they stay.
 */

/**
 * The shared reading column every row sits in. Flex — not block — because
 * WebKit paints selection as full-width bands across block gaps; a flex column
 * makes the highlight hug the words (same reason as .viewer-messages).
 */
const msgRowBase =
  "msg mx-auto flex w-full max-w-[var(--session-col)] flex-col";

/** A normal turn: assistant answer, user bubble, teammate reply. */
export const msgRow = `${msgRowBase} mb-4.5`;

/**
 * A centered notice pill. Tighter bottom margin than a turn, and no top margin
 * at all: flex margins don't collapse, so the previous row's 18px is the gap.
 */
export const msgSystemRow = `${msgRowBase} mb-3 text-center`;

/**
 * Your own and a teammate's turns start 4px lower — the old 22px collapsed
 * against the previous sibling's bottom margin, which flex margins don't do.
 */
export const msgOwnTurn = "mt-1";

/**
 * Speaker label. Right-aligned (row-reverse) so the identity dot lands on the
 * outer edge, mirroring the assistant side. The ::selection masks are WebKit
 * only: it paints a highlight over unselectable label text caught inside a
 * selection range, and a fully transparent background is ignored — 1% sticks.
 *
 * Teammate labels put a UserAvatar on the outer edge. The identity mark used
 * to be `.msg-label::before`; that rule is gone from legacy.css.
 */
export const msgLabel =
  "msg-label mb-1.25 flex flex-row-reverse items-center gap-1.75 text-meta font-semibold tracking-[-0.01em] text-faint selection:bg-[rgba(0,0,0,0.01)] [&_*::selection]:bg-[rgba(0,0,0,0.01)]";

/** A teammate's reply routed back into the session — a warm teal, so it reads
 *  as someone else stepping in rather than the driver's own words. */
export const msgLabelHuman = "text-[#1f9e8a]";

/**
 * Prose body. Flex column for the same WebKit selection-band reason as the row.
 * Bubbles use `msgBubbleUser` / `msgBubbleHuman` instead, which stay block —
 * they have a surface of their own, so there is no gap to band-paint.
 */
export const msgBody =
  "msg-body flex flex-col items-stretch text-body leading-6 break-words";

/** Bubble bodies: shrink-wrapped to their words and hugging the right edge,
 *  capped short of the column so a long message still reads right-aligned. */
const msgBubble =
  "msg-body block max-w-[min(600px,90%)] self-end text-body leading-6 break-words text-fg";
export const msgBubbleUser = `${msgBubble} rounded-lg bg-panel px-3.5 py-2.5`;
export const msgBubbleHuman = `${msgBubble} rounded-row bg-[rgba(31,158,138,0.12)] px-3.5 py-2.25`;

/**
 * The row a live turn streams into. `overflow-anchor: none` keeps the browser's
 * scroll anchoring off the growing tail, which would otherwise fight a
 * glued-to-bottom follow as tokens append.
 */
export const msgStreamingRow = "msg-streaming [overflow-anchor:none]";

/** Assistant prose. Block while streaming so the caret ::after (base.css, with
 *  the reduced-motion exception that keeps it blinking) stays on the text's
 *  line — as a flex child it would wrap onto its own row. */
export const msgBodyStreaming =
  "msg-body msg-body-assistant block text-body leading-6 break-words text-fg";

/** Provider reasoning summaries are activity, not answer hierarchy. Codex
 * Desktop treats the generated `**title**` as chrome and keeps the body quiet;
 * these do the same while leaving every summary visible in the timeline. */
export const msgReasoningTitle =
  "whitespace-pre-line text-body font-normal leading-6 break-words text-dim";
// Reasoning is never answer emphasis. Keep provider-authored strong markers
// structurally intact for markdown while preventing them from becoming bold.
export const msgReasoningBody = `${msgBody} text-dim [&_strong]:font-normal`;

/** Active model text doubles as its loading indicator. Match ChatGPT's quieter
 * wash: the text rests at its normal secondary color while a short,
 * low-contrast band crosses the glyphs. TextShimmer sizes the sweep to this
 * inline label, and base.css freezes it for reduced motion. Shared by streamed
 * reasoning and the turn-level fallback, so a silent provider still leaves one
 * legible liveness signal. */
export const msgActivityShimmer =
  "text-dim [--text-shimmer-highlight:var(--reasoning-shimmer-contrast)] " +
  "[--text-shimmer-duration:3s] [--text-shimmer-easing:ease] [--text-shimmer-delay:0.5s]";

export const msgReasoningShimmer = msgActivityShimmer;

/**
 * Type and measure shared by every notice line, pill or not. The
 * `.msg-system-text` name stays on both variants: base.css's selection policy
 * names it.
 */
const msgSystemBase =
  "msg-system-text inline-block max-w-[min(560px,100%)] self-center py-1.5 text-center text-meta leading-[1.45] text-faint";

/** The centered notice pill itself. */
export const msgSystemText = `${msgSystemBase} rounded-row bg-panel px-3.5`;

/** A catch-up line, meaning a recap, reads as an aside in the transcript
 *  rather than as a card: the muted type, with no surface under it. It takes
 *  the full reading column rather than the pill's narrower cap, so a recap
 *  wraps on the same measure as the turns around it, inside the same row. */
export const msgSystemInline =
  "msg-system-text block w-full py-1.5 text-meta leading-[1.45] text-faint";

/**
 * A toned notice reads as a sentence, not a banner: everything the server and
 * the runner write lands in this one pill, so "switched account and retried"
 * and "your run died 40 minutes ago" used to be typographically identical.
 *
 * Every utility here is written as a `data-[tone…]:` variant, and that is
 * load-bearing rather than decorative. The pill it overrides sets `bg-panel`,
 * `inline-block` and `text-center` as plain single-class utilities, so a plain
 * tone utility only wins by Tailwind's OUTPUT ORDER — and it doesn't always:
 * deleting legacy.css's `.msg-system-text[data-tone="warn"]` (0,1,1, so it had
 * always won) dropped the warn pill straight back to the neutral panel wash,
 * measured, while the error pill happened to keep its red. Matching the
 * attribute restores the specificity legacy had, so which one wins stops
 * depending on where the compiler happened to emit them.
 */
export const msgSystemToned =
  "data-[tone]:inline-flex data-[tone]:items-start data-[tone]:gap-1.5 data-[tone]:text-left";

/**
 * The colour a toned notice wears — a LOOKUP of literal strings, never a built
 * `` `tone-${x}` ``: Tailwind only compiles class names it can find in the
 * source, so an assembled one compiles to nothing at all. Same shape as
 * `sourceChipTone` in lib/source-chip-classes.
 */
const SYSTEM_TONE = {
  error: "data-[tone=error]:bg-red-soft data-[tone=error]:text-red",
  warn:
    "data-[tone=warn]:bg-[color-mix(in_srgb,var(--yellow)_12%,transparent)] " +
    "data-[tone=warn]:text-yellow",
};

/** `info` deliberately resolves to nothing: it is the pill's resting look. */
export function msgSystemTone(tone: string): string {
  if (tone === "error" || tone === "warn") return SYSTEM_TONE[tone];
  return "";
}

/** Inline attachments under a turn. Right-aligned inside a bubble's column. */
export const msgMedia = "mt-1.5 flex flex-wrap gap-2";

/** Short relative time in a label row (hover for the real one). */
export const msgTime =
  "ml-1.5 cursor-default text-meta font-medium tracking-normal text-faint";
