/**
 * Model inversion for PR reviews (Greptile, "model inversion", 2026): a model
 * is measurably worse at reviewing code it wrote itself — same instincts, same
 * blind spots (Claude recall on Claude-authored code 53.7% vs 62.0% on
 * Codex-authored; GPT mirrors it). So: if a Claude-family model wrote the code,
 * a GPT-family model reviews it, and vice versa.
 *
 * Authorship comes from what we already know: the live session that owns the
 * PR's branch (its `model` is the code's author), or the PR's own auto-fix
 * session when its loop pushed the current head. Human-authored PRs (no
 * session) keep the configured review model. Kill switch:
 * OPENSESSION_REVIEW_INVERSION=0.
 */
import { readFileSync } from "fs";
import { OPENSESSION_SESSIONS_DIR } from "../../server/paths";
import { defaultRepo } from "../../server/config";
import { tryGetSessionControl } from "../../server/session-control";
import { matchSessions, workspaceIdForRepo } from "./session-notify";
import { readPrState } from "./state";
import { bksIdFor } from "./run";
import type { PrRef } from "./review";

/** The two pools we can invert between (see src/server/models.ts). */
const OPENAI_REVIEWER = "pi/openai/gpt-5.6-sol";
const ANTHROPIC_REVIEWER = "pi/anthropic/claude-fable-5-1";

export type ModelFamily = "anthropic" | "openai";

export function inversionEnabled(): boolean {
  return process.env.OPENSESSION_REVIEW_INVERSION !== "0";
}

/** Coarse family classification across native and pi/<provider>/<model> ids. */
export function familyOf(model?: string): ModelFamily | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes("claude") || m.includes("anthropic")) return "anthropic";
  if (m.includes("gpt") || m.includes("codex") || m.includes("openai"))
    return "openai";
  return null;
}

function sessionFileModel(bksId: string): string | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(`${OPENSESSION_SESSIONS_DIR}/${bksId}.json`, "utf-8"),
    );
    return typeof parsed?.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

/** Which model family authored the PR's current head, and how we know. */
export function authorFamilyFor(
  pr: PrRef,
): { family: ModelFamily; source: string } | null {
  // 1. A live session owns the branch — its model wrote the code. Same
  //    resolution as the review handoff (handoff.ts), so the model that gets
  //    the findings is also the one whose reviewer is inverted.
  const control = tryGetSessionControl();
  if (control) {
    const workspaceId = workspaceIdForRepo(pr.ghRepo || defaultRepo().ghRepo);
    if (workspaceId) {
      const owners = matchSessions(control, workspaceId, pr.headRef)
        .filter((s) => !s.id.startsWith("bks-ghpr-"))
        .sort(
          (a, b) =>
            Date.parse(b.lastActivity || "0") -
            Date.parse(a.lastActivity || "0"),
        );
      for (const s of owners) {
        const family = familyOf(s.model);
        if (family) return { family, source: `owning session ${s.id}` };
      }
    }
  }
  // 2. The PR's auto-fix loop pushed the current head — the fixer session's
  //    model authored it (this is the reviewGate case, where inversion matters
  //    most: the gate must not share the fixer's blind spots).
  const state = readPrState(pr.number, pr.ghRepo);
  if (
    state?.autoFix?.lastPushedSha &&
    state.autoFix.lastPushedSha === pr.headSha
  ) {
    const model = sessionFileModel(bksIdFor(pr.number, "autofix", pr.ghRepo));
    // The fix pool defaults to Anthropic when the session never recorded a model.
    return { family: familyOf(model) || "anthropic", source: "auto-fix loop" };
  }
  return null; // human-authored / unknown — keep the configured reviewer
}

/**
 * The review model to use for this PR, or null to keep the configured one.
 * Returns a switch only when the reviewer that would otherwise run shares the
 * author's family.
 */
export function inverseReviewModel(
  pr: PrRef,
  configured?: string,
): { model: string; family: ModelFamily; source: string } | null {
  if (!inversionEnabled()) return null;
  const author = authorFamilyFor(pr);
  if (!author) return null;
  // Unset config runs on the Anthropic pool (session-file/runner default).
  const reviewerFamily = familyOf(configured) || "anthropic";
  if (reviewerFamily !== author.family) return null; // already cross-family
  return {
    model: author.family === "anthropic" ? OPENAI_REVIEWER : ANTHROPIC_REVIEWER,
    family: author.family,
    source: author.source,
  };
}
