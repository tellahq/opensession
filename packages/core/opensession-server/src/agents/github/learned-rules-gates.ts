/**
 * Pure decision logic for the learned-review-rules distiller — zero imports
 * (feedback-gates.ts pattern) so its tests never touch server modules.
 *
 * Learned rules are the cross-PR learning channel (CodeRabbit-style): a small,
 * human-readable set of per-repo calibration rules distilled by a model from
 * the feedback store's outcome signals (ignored/dismissed findings, missed
 * bugs, addressed/upvoted findings). This module owns validating the model's
 * output and deciding when a re-distill is due; learned-rules.ts owns the I/O
 * and the model call.
 */

export interface LearnedRule {
  /** Imperative, specific instruction, e.g. "Don't flag missing null checks on
   *  values the ReScript type system already proves non-null." */
  text: string;
  /** calibration = adjust/stop a flagging pattern readers reject;
   *  focus = a check to add, typically from a missed bug. */
  kind: "calibration" | "focus";
  /** One-line pointer at the signals that justify the rule. */
  evidence?: string;
}

export interface LearnedRulesFile {
  updatedAt: string;
  /** Feedback-signal count at distill time — the due-check's progress marker. */
  signalCount: number;
  rules: LearnedRule[];
}

export const MAX_RULES = 10;
const MIN_RULE_LEN = 20;
const MAX_RULE_LEN = 300;
/** New settled signals required before a re-distill is worth a model call. */
const MIN_NEW_SIGNALS = 5;
/** First distill needs a real corpus; tiny histories produce overfit rules. */
const MIN_FIRST_SIGNALS = 15;
const MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * Validate the distiller model's parsed output into a clean rule list.
 * Returns null when the output is unusable (caller keeps the previous rules —
 * a failed distill must never blank the store).
 */
export function validateDistilledRules(parsed: unknown): LearnedRule[] | null {
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as any).rules)
      ? (parsed as any).rules
      : null;
  if (!arr) return null;
  const out: LearnedRule[] = [];
  for (const r of arr) {
    if (!r || typeof r !== "object" || typeof r.text !== "string") continue;
    const text = r.text.replace(/\s+/g, " ").trim();
    if (text.length < MIN_RULE_LEN || text.length > MAX_RULE_LEN) continue;
    out.push({
      text,
      kind: r.kind === "focus" ? "focus" : "calibration",
      ...(typeof r.evidence === "string" && r.evidence.trim()
        ? { evidence: r.evidence.replace(/\s+/g, " ").trim().slice(0, 200) }
        : {}),
    });
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

/** Is a distill run worth it, given the store state and current signal count? */
export function distillDue(
  file: LearnedRulesFile | null,
  signalCount: number,
  now: number,
): boolean {
  if (!file) return signalCount >= MIN_FIRST_SIGNALS;
  if (signalCount - file.signalCount < MIN_NEW_SIGNALS) return false;
  const last = Date.parse(file.updatedAt);
  return !Number.isFinite(last) || now - last >= MIN_INTERVAL_MS;
}
