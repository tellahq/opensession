/**
 * Pure decision logic for the review feedback filter — zero imports (like
 * handoff-gates.ts / autofix-gates.ts) so its tests never touch server modules.
 *
 * The mechanism is Greptile's "make LLMs shut up" result, minus the vector DB:
 * models can't be prompted out of nits without losing real findings, and
 * LLM-as-judge of its own output is near-random — but nits CLUSTER, so a
 * deterministic post-filter against past reader feedback works. We use token
 * Jaccard similarity instead of embeddings (no embedding infra here; nit
 * clusters are lexically tight — "missing semicolon", "consider extracting" —
 * so lexical similarity captures them; swap in embeddings later if it
 * underperforms). Block a candidate similar to ≥3 negative-outcome comments,
 * force-keep on ≥3 positives, and never filter P0/P1 (the caller enforces the
 * severity gate).
 */

export interface FeedbackRecord {
  pr: number;
  path: string;
  severity: string;
  title: string;
  text: string;
  postedAt: string;
  /** 👍 / 👎 reaction counts on the posted comment (polled from GitHub). */
  plus?: number;
  minus?: number;
  /** addressed = the thread resolved/outdated (author acted); ignored = still
   *  open and current when the PR closed (author didn't act). */
  outcome?: "addressed" | "ignored";
  /** A bug we missed: recorded when a later fix-PR blames a reviewed PR. */
  falseNegative?: boolean;
  /** Model-classified tone of human replies in the finding's thread:
   *  dismissive = the author pushed back ("intentional", "not a bug");
   *  positive = they valued it ("good catch"). Set by harvestReplySignals. */
  replySignal?: "positive" | "dismissive";
  /** How many human replies were classified so far (re-classify only on new ones). */
  repliesSeen?: number;
}

const TOKEN_RE = /[a-z0-9_]{3,}/g;
/** Function words that dilute Jaccard without carrying meaning — nit clusters
 *  are defined by their content words ("extract", "helper", "unused"). */
const STOPWORDS = new Set([
  "the",
  "this",
  "that",
  "these",
  "those",
  "into",
  "for",
  "with",
  "and",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "its",
  "can",
  "could",
  "should",
  "would",
  "will",
  "not",
  "but",
  "you",
  "your",
  "here",
  "there",
  "when",
  "then",
  "than",
  "from",
  "also",
  "may",
  "might",
  "been",
  "being",
]);

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of (text || "").toLowerCase().match(TOKEN_RE) || []) {
    if (!STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** Jaccard similarity of the two texts' token sets (0..1). */
export function similarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** The reader pushed back: an explicit dismissive reply or 👎, or silently
 *  ignored with no 👍. Words beat reactions beat silence. */
export function isNegativeSignal(r: FeedbackRecord): boolean {
  if (r.replySignal === "dismissive") return true;
  if (r.replySignal === "positive") return false;
  const plus = r.plus || 0;
  const minus = r.minus || 0;
  if (minus > plus) return true;
  return r.outcome === "ignored" && plus === 0;
}

/** The reader valued it: an explicit positive reply or 👍, or acted on it. */
export function isPositiveSignal(r: FeedbackRecord): boolean {
  if (r.replySignal === "positive") return true;
  if (r.replySignal === "dismissive") return false;
  const plus = r.plus || 0;
  const minus = r.minus || 0;
  if (plus > 0 && plus >= minus) return true;
  return r.outcome === "addressed" && minus === 0;
}

export interface SuppressOptions {
  /** Similarity at or above this counts as "the same kind of comment". */
  threshold?: number;
  /** How many similar negatives it takes to block (Greptile used 3). */
  needed?: number;
}

/**
 * Should this candidate finding be withheld? "suppress" when it resembles
 * `needed`+ negative-outcome comments AND does not resemble `needed`+
 * positive ones (force-keep wins ties — losing a real finding costs more
 * than one extra nit).
 */
export function suppressDecision(
  candidateText: string,
  records: FeedbackRecord[],
  opts: SuppressOptions = {},
): "suppress" | "keep" {
  const threshold = opts.threshold ?? 0.5;
  const needed = opts.needed ?? 3;
  let negatives = 0;
  let positives = 0;
  for (const r of records) {
    if (similarity(candidateText, `${r.title} ${r.text}`) < threshold) continue;
    if (isPositiveSignal(r)) positives++;
    else if (isNegativeSignal(r)) negatives++;
  }
  if (positives >= needed) return "keep";
  return negatives >= needed ? "suppress" : "keep";
}
