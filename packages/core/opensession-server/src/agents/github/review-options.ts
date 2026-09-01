/**
 * Per-repo review knobs, read from `.os-review.json` at the repo root (so
 * they're versioned with the code they tune). All fields optional; unknown
 * fields ignored; a missing or malformed file means pure defaults. Greptile's
 * `greptile.json` skip-matrix, sized down to what this bot needs:
 *
 *   {
 *     "ignoreGlobs": ["**\/*.lock", "generated/**"],   // never review these paths
 *     "minInlineSeverity": "P3",                        // post inline comments at or above this
 *     "summaryOnlyOverFiles": 80,                       // giant PRs get a summary, no inline noise
 *     "skipKeywords": ["[skip-review]"],                // in the PR title → no auto review
 *     "secretScan": true                                // TruffleHog scan of the PR's added lines
 *   }
 *
 * Auto-review gating (skipKeywords) reads the repo's MAIN checkout copy (the
 * webhook has no PR worktree yet — slight staleness is fine for a knob);
 * finding filters read the PR-head worktree copy for exactness.
 */
import { existsSync, readFileSync } from "fs";

export interface ReviewOptions {
  ignoreGlobs: string[];
  /** Findings BELOW this severity are withheld from inline comments (still
   *  counted in the summary). "P3" = post everything (default). */
  minInlineSeverity: "P0" | "P1" | "P2" | "P3";
  summaryOnlyOverFiles: number;
  skipKeywords: string[];
  /** Deterministic test-fails-on-base check on new/changed test files. */
  testOnBase: boolean;
  /** Deterministic TruffleHog secret scan on the PR's added lines. */
  secretScan: boolean;
}

export const REVIEW_OPTION_DEFAULTS: ReviewOptions = {
  ignoreGlobs: [],
  minInlineSeverity: "P3",
  summaryOnlyOverFiles: 80,
  skipKeywords: ["[skip-review]"],
  testOnBase: true,
  secretScan: true,
};

const OPTIONS_FILE = ".os-review.json";

export function loadReviewOptions(repoDir: string | undefined): ReviewOptions {
  if (!repoDir) return REVIEW_OPTION_DEFAULTS;
  const path = `${repoDir}/${OPTIONS_FILE}`;
  if (!existsSync(path)) return REVIEW_OPTION_DEFAULTS;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return normalizeReviewOptions(raw);
  } catch (e) {
    console.warn(`[github] malformed ${path} — using review defaults:`, e);
    return REVIEW_OPTION_DEFAULTS;
  }
}

/** Pure merge/validation (unit-tested separately from the fs read). */
export function normalizeReviewOptions(raw: any): ReviewOptions {
  const d = REVIEW_OPTION_DEFAULTS;
  if (!raw || typeof raw !== "object") return d;
  const sev =
    typeof raw.minInlineSeverity === "string"
      ? raw.minInlineSeverity.toUpperCase()
      : "";
  return {
    ignoreGlobs: Array.isArray(raw.ignoreGlobs)
      ? raw.ignoreGlobs.filter((g: any) => typeof g === "string" && g.trim())
      : d.ignoreGlobs,
    minInlineSeverity: (["P0", "P1", "P2", "P3"] as const).includes(sev as any)
      ? (sev as ReviewOptions["minInlineSeverity"])
      : d.minInlineSeverity,
    summaryOnlyOverFiles:
      Number.isFinite(raw.summaryOnlyOverFiles) && raw.summaryOnlyOverFiles > 0
        ? Math.floor(raw.summaryOnlyOverFiles)
        : d.summaryOnlyOverFiles,
    skipKeywords: Array.isArray(raw.skipKeywords)
      ? raw.skipKeywords.filter((k: any) => typeof k === "string" && k.trim())
      : d.skipKeywords,
    testOnBase:
      typeof raw.testOnBase === "boolean" ? raw.testOnBase : d.testOnBase,
    secretScan:
      typeof raw.secretScan === "boolean" ? raw.secretScan : d.secretScan,
  };
}

/** Lower = more severe. Unknown severities sort as P3 (least severe). */
export function severityRank(severity?: string): number {
  const s = (severity || "").toUpperCase();
  if (s === "P0" || s === "HIGH") return 0;
  if (s === "P1") return 1;
  if (s === "P2" || s === "MEDIUM") return 2;
  return 3;
}

export function titleHasSkipKeyword(
  title: string,
  opts: ReviewOptions,
): boolean {
  const t = (title || "").toLowerCase();
  return opts.skipKeywords.some((k) => t.includes(k.toLowerCase()));
}

export function pathIgnored(path: string, opts: ReviewOptions): boolean {
  return opts.ignoreGlobs.some((g) => {
    try {
      return new Bun.Glob(g).match(path);
    } catch {
      return false;
    }
  });
}
