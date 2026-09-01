import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { repoForPathOrNull } from "./worktree";

/**
 * Which repo owns a worktree path, when two registered repos have
 * prefix-overlapping ids.
 *
 * `wtPrefix` defaults to the repo id (config.ts) and ids are only checked for
 * exact-equality uniqueness, so registering `app` and `app-web` is legal and
 * every `<wt>/app-web-<branch>` dir matches BOTH conventions. The old scan
 * returned the first config entry that matched, i.e. the answer depended on
 * key order in the config file, and a wrong answer propagates into the
 * reaper's irreversible per-slug cleanup.
 */

const ENV_KEYS = ["OPENSESSION_CONFIG", "OPENSESSION_WORKTREES_DIR"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

const dirs: string[] = [];

/** Config with both repos, in the given key order. Returns the temp root so
 *  tests can put a real worktree on disk under it. */
function withConfig(order: ("app" | "app-web")[]): string {
  const root = mkdtempSync(join(tmpdir(), "os-wtpath-test-"));
  dirs.push(root);
  const entries: Record<string, unknown> = {};
  for (const id of order) {
    entries[id] = {
      repo: join(root, `${id}-main`),
      defaultBranch: "main",
      ...(id === "app" ? { default: true } : {}),
    };
  }
  const path = join(root, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      paths: { worktreesDir: join(root, "worktrees") },
      repos: entries,
    }),
  );
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.OPENSESSION_CONFIG = path;
  return root;
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("repoForPathOrNull with prefix-overlapping repo ids", () => {
  for (const order of [
    ["app", "app-web"],
    ["app-web", "app"],
  ] as const) {
    test(`resolves by longest prefix, config order ${order.join(",")}`, () => {
      const root = withConfig([...order]);
      const wt = join(root, "worktrees");
      // Nothing on disk: the path fallback decides, and it must pick the
      // most specific prefix rather than the first-registered one.
      expect(repoForPathOrNull(join(wt, "app-web-feat-x"))?.id).toBe("app-web");
      expect(repoForPathOrNull(join(wt, "app-feat-x"))?.id).toBe("app");
      expect(repoForPathOrNull(join(root, "app-web-main"))?.id).toBe("app-web");
      expect(repoForPathOrNull(join(root, "app-main"))?.id).toBe("app");
      expect(repoForPathOrNull(join(root, "scratch", "ws-1"))).toBeUndefined();
    });
  }

  test("a live worktree's .git pointer beats the path convention", () => {
    const root = withConfig(["app", "app-web"]);
    // `app` with a branch called `web-x` lands on a dir the `app-web`
    // convention also claims. Git knows which checkout cut it.
    const dir = join(root, "worktrees", "app-web-x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, ".git"),
      `gitdir: ${join(root, "app-main", ".git", "worktrees", "web-x")}\n`,
    );
    expect(repoForPathOrNull(dir)?.id).toBe("app");
    // Reaped: the dir is gone, the persisted worktreeDir is not, and the
    // fallback still answers rather than losing the session's repo id.
    rmSync(dir, { recursive: true, force: true });
    expect(repoForPathOrNull(dir)?.id).toBe("app-web");
  });
});
