/**
 * Reviewer false-negative detection (Greptile's post-merge regression signal):
 * when a merged PR that looks like a bug fix touches lines that a recently
 * reviewed PR introduced, the reviewer missed that bug. We blame the fix's
 * changed ranges at its base commit, map the blamed commits back to PR numbers
 * via the squash-merge "(#N)" subject suffix, and record any reviewed culprit
 * as a missed bug — the counterpart metric to the feedback store's noise
 * signals (audit: review_missed_bug; store: feedback.ts falseNegative).
 *
 * Best-effort and bounded: ≤20 files, ≤3 hunks/file, ≤30 blame calls; any git
 * or API failure just logs. Runs fire-and-forget from the merge webhook.
 */
import { $ } from "bun";
import { audit } from "../../server/audit";
import { defaultRepo } from "../../server/config";
import { githubRequest } from "./github-rest";
import { repoForFullName } from "./constants";
import { readPrState } from "./state";
import { recordFalseNegative } from "./feedback";

const FIX_TITLE_RE =
  /\b(fix(es|ed)?|bug|regress\w*|revert|hotfix|broken|crash)\b/i;
const MAX_FILES = 20;
const MAX_HUNKS_PER_FILE = 3;
const MAX_BLAMES = 30;
/** Only PRs we reviewed this recently count as culprits — older code is legacy. */
const CULPRIT_MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;

/** Old-side line ranges from a unified-diff patch (deleted/changed lines only —
 *  a pure addition blames nothing). Exported for tests. */
export function oldSideRanges(
  patch: string,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const start = parseInt(m[1], 10);
    const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
    if (count > 0) out.push({ start, end: start + count - 1 });
    if (out.length >= MAX_HUNKS_PER_FILE) break;
  }
  return out;
}

/** PR number from a squash-merge subject ("… (#1234)"), or null. Exported for tests. */
export function prNumberFromSubject(subject: string): number | null {
  const m = subject.match(/\(#(\d+)\)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

/** `pull_request` webhook payload with action=closed & merged=true. */
export async function analyzeMergedPrForMissedBugs(
  payload: any,
): Promise<void> {
  const pr = payload?.pull_request;
  if (!pr?.merged || typeof pr.number !== "number") return;
  const title: string = pr.title || "";
  if (!FIX_TITLE_RE.test(title)) return; // only PRs that present as fixes

  const repoFull: string =
    payload?.repository?.full_name || defaultRepo().ghRepo;
  const repo = repoForFullName(repoFull);
  if (!repo?.repo) return; // no local checkout to blame in
  const ghRepo =
    repoFull.toLowerCase() === defaultRepo().ghRepo.toLowerCase()
      ? undefined
      : repoFull;
  const baseSha: string = pr.base?.sha || "";
  const baseRef: string = pr.base?.ref || "";
  if (!baseSha) return;

  const filesResp = await githubRequest<any[]>(
    "GET",
    `/repos/${repoFull}/pulls/${pr.number}/files?per_page=100`,
  );
  if (!filesResp.ok || !Array.isArray(filesResp.data)) return;

  // Make sure the base commit is resolvable locally, then blame at it.
  try {
    await $`git -C ${repo.repo} fetch --quiet origin ${baseRef || baseSha}`.quiet();
    await $`git -C ${repo.repo} cat-file -e ${baseSha}`.quiet();
  } catch {
    console.warn(
      `[github] missed-bug: base ${baseSha.slice(0, 7)} unavailable in ${repo.repo}`,
    );
    return;
  }

  const blamedShas = new Set<string>();
  let blames = 0;
  for (const f of filesResp.data.slice(0, MAX_FILES)) {
    if (typeof f?.patch !== "string" || !f.filename) continue;
    for (const range of oldSideRanges(f.patch)) {
      if (blames >= MAX_BLAMES) break;
      blames++;
      try {
        const out =
          await $`git -C ${repo.repo} blame -l -s -L ${range.start},${range.end} ${baseSha} -- ${f.filename}`
            .quiet()
            .text();
        for (const line of out.split("\n")) {
          const sha = line.split(" ")[0]?.replace(/^\^/, "");
          if (sha && /^[0-9a-f]{40}$/.test(sha)) blamedShas.add(sha);
        }
      } catch {
        // renamed/deleted at base, or range off — skip this hunk
      }
    }
  }
  if (!blamedShas.size) return;

  const culprits = new Map<number, string[]>(); // culprit PR → blamed paths note
  for (const sha of [...blamedShas].slice(0, 30)) {
    try {
      const subject = (
        await $`git -C ${repo.repo} show -s --format=%s ${sha}`.quiet().text()
      ).trim();
      const culpritPr = prNumberFromSubject(subject);
      if (!culpritPr || culpritPr === pr.number) continue;
      const state = readPrState(culpritPr, ghRepo);
      if (!state || !state.reviewedShas?.length) continue; // we never reviewed it
      const age = Date.now() - Date.parse(state.updatedAt || "");
      if (!Number.isFinite(age) || age > CULPRIT_MAX_AGE_MS) continue;
      if (!culprits.has(culpritPr)) culprits.set(culpritPr, []);
      culprits.get(culpritPr)!.push(subject);
    } catch {}
  }

  for (const [culpritPr, subjects] of culprits) {
    console.log(
      `[github] missed bug: fix PR #${pr.number} touches code from reviewed PR #${culpritPr}`,
    );
    audit({
      msg: "review_missed_bug",
      fix_pr: pr.number,
      culprit_pr: culpritPr,
      repo: repoFull,
      fix_title: title.slice(0, 200),
    });
    recordFalseNegative(
      ghRepo,
      culpritPr,
      `Fix PR #${pr.number} "${title}" changed code introduced by reviewed PR #${culpritPr} (${subjects[0] || ""})`,
    );
  }
}
