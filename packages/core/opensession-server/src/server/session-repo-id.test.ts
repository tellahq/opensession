import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { repoForPath, repoForPathOrNull, sessionRepoId } from "./worktree";

/**
 * `sessionRepoId` — the one predicate every repo-derivation call site asks.
 *
 * The behavior that matters: repo-less-ness comes from the PATH, not from
 * `mode === "scratch"`. These cases pin both halves — that a scratch session
 * still resolves exactly as it did under the old mode test (undefined, so the
 * caller's `?? defaultRepo().id` decides), and that a repo-less session of
 * any OTHER mode now resolves the same way instead of silently claiming the
 * default repo.
 *
 * Same config seam as worktree-selfdev.test.ts: no git side effects, since
 * every assertion is on the pure path→repo decision.
 */

const ENV_KEYS = ["OPENSESSION_CONFIG", "OPENSESSION_WORKTREES_DIR"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

const dirs: string[] = [];
const WT_DIR = "/repoid-test/worktrees";
const APP_REPO = "/repoid-test/app-main";

function withConfig(): void {
  const dir = mkdtempSync(join(tmpdir(), "os-repoid-test-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      paths: { worktreesDir: WT_DIR },
      repos: {
        app: {
          repo: APP_REPO,
          wtPrefix: "app",
          defaultBranch: "main",
          default: true,
        },
        lib: { repo: "/repoid-test/lib-main", wtPrefix: "lib" },
      },
    }),
  );
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.OPENSESSION_CONFIG = path;
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("repoForPathOrNull", () => {
  test("owns main checkouts and their worktrees", () => {
    withConfig();
    expect(repoForPathOrNull(APP_REPO)?.id).toBe("app");
    expect(repoForPathOrNull(`${WT_DIR}/app-feat-x`)?.id).toBe("app");
    expect(repoForPathOrNull(`${WT_DIR}/lib-feat-x`)?.id).toBe("lib");
  });

  test("undefined instead of throwing for a path no repo owns", () => {
    withConfig();
    expect(
      repoForPathOrNull("/var/lib/opensession/scratch/os-123"),
    ).toBeUndefined();
    // repoForPath keeps throwing — callers that require a repo still get a
    // loud failure rather than a silent default.
    expect(() => repoForPath("/var/lib/opensession/scratch/os-123")).toThrow(
      /No registered repo/,
    );
  });
});

describe("sessionRepoId", () => {
  test("an explicit repo wins over the path", () => {
    withConfig();
    expect(
      sessionRepoId({ repo: "lib", worktreeDir: `${WT_DIR}/app-feat-x` }),
    ).toBe("lib");
  });

  test("derives from worktreeDir for sessions stored before the repo field", () => {
    withConfig();
    expect(sessionRepoId({ worktreeDir: `${WT_DIR}/app-feat-x` })).toBe("app");
    expect(sessionRepoId({ worktreeDir: APP_REPO })).toBe("app");
  });

  test("no worktree, no repo → undefined", () => {
    withConfig();
    expect(sessionRepoId({})).toBeUndefined();
    expect(sessionRepoId({ worktreeDir: "" })).toBeUndefined();
    expect(sessionRepoId({ worktreeDir: null })).toBeUndefined();
  });

  test("repo-less sessions resolve by path, whatever their mode", () => {
    withConfig();
    const scratchDir = "/var/lib/opensession/scratch/ws-1";
    // Scratch: unchanged from the old `mode !== "scratch"` test.
    expect(sessionRepoId({ worktreeDir: scratchDir })).toBeUndefined();
    // A repo-less ask session sits in the same kind of dir. Under the old
    // mode test this returned the DEFAULT repo, which pointed diff, PR and
    // git routes at a checkout the session had nothing to do with.
    expect(
      sessionRepoId({ repo: undefined, worktreeDir: scratchDir }),
    ).toBeUndefined();
  });
});
