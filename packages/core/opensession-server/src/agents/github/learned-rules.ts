/**
 * Learned review rules — the cross-PR learning channel for the PR reviewer.
 * A small per-repo JSON file (~/.opensession-github/learned-rules-<key>.json)
 * of human-readable calibration rules, injected into every review prompt and
 * periodically re-distilled by a model from the feedback store's outcome
 * signals: ignored/dismissed findings (stop flagging that), missed bugs
 * (start checking for that), addressed/upvoted findings (keep doing that).
 *
 * CodeRabbit-shaped rather than Greptile-shaped on purpose: rules are plain
 * English in an editable file, so a human can audit, tweak, or delete what the
 * distiller learned. The lexical suppression filter (feedback-gates.ts) stays
 * as the output-side backstop; this is the input-side lesson.
 *
 * Pure decision logic (validation, due-check) lives in learned-rules-gates.ts.
 */
import { existsSync, readFileSync } from "fs";
import { stateDir } from "../../server/paths";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import { audit } from "../../server/audit";
import { configuredRepos, defaultRepo } from "../../server/config";
import { oneShot } from "../../server/one-shot";
import { repoForFullName } from "./constants";
import { readFeedback } from "./feedback";
import {
  isNegativeSignal,
  isPositiveSignal,
  type FeedbackRecord,
} from "./feedback-gates";
import {
  distillDue,
  validateDistilledRules,
  MAX_RULES,
  type LearnedRulesFile,
} from "./learned-rules-gates";

const STATE_DIR = stateDir("github");
/** Distillation is judgment work (which patterns generalize, which are noise) —
 *  it runs at most twice a day per repo, so use a frontier model. */
const DISTILL_MODEL = "pi/anthropic/claude-fable-5-1";
const TICK_MS = 60 * 60 * 1000;

function repoKey(ghRepo?: string): string {
  return !ghRepo || ghRepo.toLowerCase() === defaultRepo().ghRepo.toLowerCase()
    ? "default"
    : repoForFullName(ghRepo)?.id || ghRepo.replace(/[^A-Za-z0-9._-]/g, "_");
}

function rulesPath(ghRepo?: string): string {
  return `${STATE_DIR}/learned-rules-${repoKey(ghRepo)}.json`;
}

export function readLearnedRules(ghRepo?: string): LearnedRulesFile | null {
  const path = rulesPath(ghRepo);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as LearnedRulesFile;
    return Array.isArray(parsed?.rules) ? parsed : null;
  } catch {
    return null;
  }
}

/** Prompt section for review runs; "" until rules exist. */
export function learnedRulesSection(ghRepo?: string): string {
  const file = readLearnedRules(ghRepo);
  if (!file?.rules.length) return "";
  const lines = file.rules.map((r) => `- (${r.kind}) ${r.text}`);
  return `## Learned calibration for this repo (distilled from reader feedback on your past reviews)

${lines.join("\n")}

These are advisory tuning, not new hard rules: "calibration" entries tell you which finding patterns readers here reject as noise, "focus" entries are bug classes you have actually missed. They adjust how you flag — they never override the correctness bar, and never justify suppressing or inventing a P0/P1.`;
}

/** A record carries signal once a reader outcome landed on it. */
function hasSignal(r: FeedbackRecord): boolean {
  return !!(
    r.outcome ||
    r.falseNegative ||
    r.replySignal ||
    (r.plus || 0) > 0 ||
    (r.minus || 0) > 0
  );
}

function clip(text: string, cap: number): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

function buildDistillPrompt(
  ghRepo: string,
  records: FeedbackRecord[],
  current: LearnedRulesFile | null,
): string {
  const negatives = records
    .filter((r) => !r.falseNegative && isNegativeSignal(r))
    .slice(-30);
  const missed = records.filter((r) => r.falseNegative).slice(-15);
  const positives = records
    .filter((r) => !r.falseNegative && isPositiveSignal(r))
    .slice(-25);

  const fmt = (r: FeedbackRecord) =>
    `- [${r.severity || "?"}] ${clip(`${r.title}: ${r.text}`, 220)}${r.replySignal === "dismissive" ? " (author explicitly pushed back)" : ""}`;

  return `You maintain the learned calibration rules for an automated PR reviewer on ${ghRepo}. The reviewer's findings get outcome signals from readers: addressed (author acted), ignored (author didn't), explicit 👍/👎, author replies, and post-merge missed-bug detection (a later fix-PR touched code from a PR the reviewer approved).

Distill this history into at most ${MAX_RULES} rules the reviewer will read before every review.

REJECTED BY READERS (ignored, downvoted, or explicitly pushed back on — candidates for "calibration" rules that stop a noisy pattern):
${negatives.length ? negatives.map(fmt).join("\n") : "(none)"}

BUGS THE REVIEWER MISSED (candidates for "focus" rules that add a check):
${missed.length ? missed.map((r) => `- ${clip(r.text, 250)}`).join("\n") : "(none)"}

VALUED BY READERS (addressed or upvoted — patterns to keep; never write a calibration rule that would suppress these):
${positives.length ? positives.map((r) => `- [${r.severity || "?"}] ${clip(r.title, 120)}`).join("\n") : "(none)"}

CURRENT RULES (keep the ones the history still supports, refine wording, drop stale ones):
${current?.rules.length ? JSON.stringify(current.rules, null, 2) : "(none yet)"}

Rules for the rules:
- Each rule is 1-2 imperative sentences, concrete and generalizable — a pattern, never a specific PR, file, or one-off incident.
- Only write a rule supported by at least 2 independent signals above; a single data point is noise.
- "calibration" rules tune noisy flagging patterns; they must be scoped so they could never suppress a genuine P0/P1 bug.
- "focus" rules come from the missed-bug list: name the bug class and where to look for it.
- Fewer, sharper rules beat coverage. Return an empty list over inventing weak rules.

Output ONLY a JSON object, no prose: {"rules": [{"text": "...", "kind": "calibration" | "focus", "evidence": "one-line pointer at the supporting signals"}]}`;
}

/** Re-distill one repo's rules if enough new signal accumulated. */
export async function distillLearnedRules(
  ghRepo?: string,
  force = false,
): Promise<boolean> {
  const records = readFeedback(ghRepo);
  const signalCount = records.filter(hasSignal).length;
  const current = readLearnedRules(ghRepo);
  if (!force && !distillDue(current, signalCount, Date.now())) return false;

  const repoFull = ghRepo || defaultRepo().ghRepo;
  const text = await oneShot(buildDistillPrompt(repoFull, records, current), {
    label: "review-rules-distill",
    model: DISTILL_MODEL,
  });
  if (!text) return false;
  let parsed: unknown;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    console.warn(
      `[github] rules distill for ${repoFull}: unparseable model output — keeping previous rules`,
    );
    return false;
  }
  const rules = validateDistilledRules(parsed);
  if (!rules) {
    console.warn(
      `[github] rules distill for ${repoFull}: invalid shape — keeping previous rules`,
    );
    return false;
  }
  const file: LearnedRulesFile = {
    updatedAt: new Date().toISOString(),
    signalCount,
    rules,
  };
  writeJsonAtomic(rulesPath(ghRepo), file);
  console.log(
    `[github] distilled ${rules.length} learned review rule(s) for ${repoFull} (${signalCount} signals)`,
  );
  audit({
    msg: "review_rules_distilled",
    repo: repoFull,
    rules: rules.length,
    signal_count: signalCount,
  });
  return true;
}

async function distillSweep(): Promise<void> {
  const targets: Array<string | undefined> = [undefined];
  for (const repo of Object.values(configuredRepos())) {
    if (
      repo.ghRepo &&
      repo.ghRepo.toLowerCase() !== defaultRepo().ghRepo.toLowerCase()
    ) {
      targets.push(repo.ghRepo);
    }
  }
  for (const target of targets) {
    try {
      await distillLearnedRules(target);
    } catch (e) {
      console.warn(
        `[github] rules distill failed for ${target || "default repo"}:`,
        e,
      );
    }
  }
}

let armed = false;

/** Hourly due-check per configured repo (the due-gate makes most ticks no-ops).
 *  Called from the github agent's startup(), so no module-scope side effects. */
export function armLearnedRulesDistiller(): void {
  if (armed) return;
  armed = true;
  setTimeout(() => void distillSweep(), 5 * 60 * 1000);
  setInterval(() => void distillSweep(), TICK_MS);
}
