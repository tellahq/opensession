/**
 * Deterministic test-fails-on-base check (Cognition "Frontier Code" style):
 * a NEW or CHANGED test that already passes on the merge base can't be
 * guarding this PR's change — it asserts pre-existing behavior (or nothing).
 * Unlike model judgment this has a real oracle: copy the PR's changed test
 * files onto a merge-base checkout and run them; exit 0 there is unambiguous.
 *
 * Scope is deliberately narrow so the signal stays deterministic:
 * - Only bun-runnable `.test.ts(x)` files (compiled ReScript `__Test.bs.js`
 *   needs a build on base — skipped).
 * - Only PASS on base is flagged. A failure OR a broken import both exit
 *   non-zero and count as "exercises the change" — conservative by design.
 * - Shared-checkout repos (opensession) are excluded: running their tests on
 *   this host can rebind live server sockets (the bun-test/run-rpc trap).
 *
 * Runs concurrently with the model review in a throwaway detached worktree
 * next to the review worktree; node_modules are symlinked in from the repo's
 * dependency-installed main checkout.
 */
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { audit } from "../../server/audit";
import { runCommand } from "../../server/run-command";

export interface TestOnBaseResult {
  /** Changed test files run against the merge base. */
  checked: string[];
  /** Files that PASSED on the base unchanged — they don't test this change. */
  vacuous: string[];
  /** Non-empty when the check didn't run, with the reason. */
  skipped: string;
}

const MAX_TEST_FILES = 5;
const GIT_TIMEOUT_MS = 30_000;
const PER_FILE_TIMEOUT_MS = 90_000;

const isRunnableTest = (path: string): boolean => /\.test\.tsx?$/.test(path);

export async function runTestOnBaseCheck(opts: {
  /** Review worktree pinned to the PR head. */
  cwd: string;
  baseRefName: string;
  /** The repo's dependency-installed main checkout (node_modules source). */
  mainCheckout: string;
  /** Shared-checkout repos are excluded (their tests can grab live sockets). */
  sharedCheckout?: boolean;
  prNumber: number;
  ghRepo?: string;
}): Promise<TestOnBaseResult> {
  const done = (result: TestOnBaseResult): TestOnBaseResult => {
    audit({
      msg: "review_test_on_base",
      pr_number: opts.prNumber,
      repo: opts.ghRepo,
      checked: result.checked.length,
      vacuous: result.vacuous.length,
      ...(result.skipped ? { skipped: result.skipped } : {}),
    });
    return result;
  };
  const skip = (reason: string) =>
    done({ checked: [], vacuous: [], skipped: reason });

  if (opts.sharedCheckout) return skip("shared-checkout repo");

  const mb = await runCommand(
    ["git", "merge-base", "HEAD", `origin/${opts.baseRefName}`],
    {
      cwd: opts.cwd,
      timeoutMs: GIT_TIMEOUT_MS,
    },
  );
  const mergeBase = mb.stdout.trim();
  if (mb.status !== 0 || !mergeBase)
    return skip(`merge-base failed: ${mb.stderr.trim().slice(0, 200)}`);

  const diff = await runCommand(
    ["git", "diff", "--name-only", "--diff-filter=AM", mergeBase, "HEAD"],
    { cwd: opts.cwd, timeoutMs: GIT_TIMEOUT_MS },
  );
  if (diff.status !== 0)
    return skip(`diff failed: ${diff.stderr.trim().slice(0, 200)}`);
  const testFiles = diff.stdout
    .split("\n")
    .filter((f) => f && isRunnableTest(f));
  if (!testFiles.length) return skip("no new/changed bun-runnable test files");
  const checked = testFiles.slice(0, MAX_TEST_FILES);

  const baseDir = `${opts.cwd}-tob`;
  await runCommand(["git", "worktree", "remove", "--force", baseDir], {
    cwd: opts.cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  rmSync(baseDir, { recursive: true, force: true });
  const add = await runCommand(
    ["git", "worktree", "add", "--detach", "--force", baseDir, mergeBase],
    {
      cwd: opts.cwd,
      timeoutMs: GIT_TIMEOUT_MS,
    },
  );
  if (add.status !== 0)
    return skip(`base worktree failed: ${add.stderr.trim().slice(0, 200)}`);

  try {
    const vacuous: string[] = [];
    for (const file of checked) {
      // Copy the PR's version of the test onto the base tree, and link in
      // node_modules from the main checkout at every ancestor level that has
      // one (monorepo packages resolve their own).
      for (let dir = dirname(file); ; dir = dirname(dir)) {
        const rel = dir === "." ? "node_modules" : join(dir, "node_modules");
        if (
          existsSync(join(opts.mainCheckout, rel)) &&
          !existsSync(join(baseDir, rel))
        ) {
          try {
            symlinkSync(join(opts.mainCheckout, rel), join(baseDir, rel));
          } catch {}
        }
        if (dir === ".") break;
      }
      mkdirSync(dirname(join(baseDir, file)), { recursive: true });
      cpSync(join(opts.cwd, file), join(baseDir, file));

      // Run from the nearest package dir so workspace-relative config applies.
      let pkgDir = dirname(file);
      while (
        pkgDir !== "." &&
        !existsSync(join(baseDir, pkgDir, "package.json"))
      )
        pkgDir = dirname(pkgDir);
      const cwd = pkgDir === "." ? baseDir : join(baseDir, pkgDir);
      const relFile = pkgDir === "." ? file : file.slice(pkgDir.length + 1);
      const run = await runCommand(["bun", "test", relFile], {
        cwd,
        timeoutMs: PER_FILE_TIMEOUT_MS,
      });
      // Exit 0 on the base = the test proves nothing about this change.
      // Failures and errors (broken imports on base) both count as exercising
      // the change — only a clean pass is flagged.
      if (run.status === 0) vacuous.push(file);
    }
    return done({ checked, vacuous, skipped: "" });
  } finally {
    await runCommand(["git", "worktree", "remove", "--force", baseDir], {
      cwd: opts.cwd,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    rmSync(baseDir, { recursive: true, force: true });
  }
}

/** Summary-comment section for a check that found vacuous tests ("" when clean). */
export function testOnBaseSection(result: TestOnBaseResult | null): string {
  if (!result || result.skipped || !result.vacuous.length) return "";
  const files = result.vacuous.map((f) => `- \`${f}\``).join("\n");
  return [
    `\n\n⚠️ **Test-on-base check** — ${result.vacuous.length} of ${result.checked.length} new/changed test file(s) already pass on the merge base unchanged, so they don't exercise what this PR changes:`,
    files,
    "_A test that passes without the change can't guard it — assert on the new behavior. (Deterministic check: the PR's test files were run on a merge-base checkout.)_",
  ].join("\n");
}
