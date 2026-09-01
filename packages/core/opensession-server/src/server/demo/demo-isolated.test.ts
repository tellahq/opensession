/**
 * Demo dataset generator tests — CHILD HALF. Runs ONLY inside the isolated
 * child process demo.test.ts spawns (OS_DEMO_TEST_CHILD=1, scratch HOME set
 * before any module loads); in the main `bun test` process every test here is
 * skipped. The hook-based seams below are NOT enough on their own: bun test
 * runs all files in one process, so module-eval snapshots (SESSIONS_DIR,
 * WORKSPACES_DIR, PR_CACHE_FILE) and ensureSessionWorkspaces' fire-and-forget
 * persists outlive afterAll's restore and would file demo sessions into the
 * operator's LIVE stores (observed 2026-08-04: bks-demo-* stubs + a minted
 * workspace in prod). In the child, HOME is scratch from first instruction to
 * process exit, so even deferred writes land in scratch.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CHILD = process.env.OS_DEMO_TEST_CHILD === "1";

let home: string;
let priorHome: string | undefined;
let priorSessionsDir: string | undefined;
let priorConfig: string | undefined;
let priorGhBackoff: number | undefined;

beforeAll(async () => {
  if (!CHILD) return;
  priorHome = process.env.HOME;
  // demo.test.ts already launches this process with an isolated HOME. Reuse
  // it instead of tmpdir(): the live VPS points TMPDIR under /home/ubuntu,
  // which made the "no operator-home literals" assertion fail on its own path.
  home =
    process.env.HOME || join("/tmp", `demo-data-test-${crypto.randomUUID()}`);
  process.env.HOME = home;
  priorConfig = process.env.OPENSESSION_CONFIG;
  // Point the config at a nonexistent scratch path so configuredRepos()
  // serves the built-in defaults regardless of the host's real config.
  process.env.OPENSESSION_CONFIG = join(home, "config.json");
  // stateDir()/statePath() cache per (HOME, name) — forget resolutions made
  // for the real HOME by other test files.
  const paths = await import("../paths");
  priorSessionsDir = paths.__setSessionsDirForTest(join(home, "sessions"));
  // Close the GitHub gate: getAllSessions' PR enrichment must serve the
  // seeded snapshot, not fire a real `gh` refresh from a unit test.
  priorGhBackoff = (await import("../github-limit")).__setGhBackoffForTest(
    Date.now() + 60 * 60_000,
  );
  (await import("../session-cache")).invalidateSessionsCache();
});

afterAll(async () => {
  if (!CHILD) return;
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (priorConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = priorConfig;
  if (priorGhBackoff !== undefined) {
    (await import("../github-limit")).__setGhBackoffForTest(priorGhBackoff);
  }
  if (priorSessionsDir !== undefined) {
    (await import("../paths")).__setSessionsDirForTest(priorSessionsDir);
  }
  // Drop the session cache built against the scratch dirs: bun test runs every
  // file in ONE process, and a later file's getAllSessions within the cache
  // TTL would otherwise serve the DEMO list against the restored real dirs —
  // ensureSessionWorkspaces then files demo sessions into the operator's live
  // sessions/workspaces stores (observed 2026-08-04: bks-demo-* stubs in prod).
  (await import("../session-cache")).invalidateSessionsCache();
  const { rmSync } = await import("node:fs");
  rmSync(home, { recursive: true, force: true });
});

/** Every generated text artifact (sessions, transcripts, stores) — the demo
 *  git repo's own files are included; .git internals are not. */
function generatedTextFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(json|jsonl|md|ts)$/.test(name)) out.push(path);
    }
  };
  walk(root);
  return out;
}

describe.skipIf(!CHILD)("demo dataset generator", () => {
  it("generates a dataset the real session reader lists", async () => {
    const { generateDemoData } = await import("./generate");
    const result = generateDemoData();
    expect(result.created).toBe(true);
    expect(result.sessionIds.length).toBeGreaterThanOrEqual(8);

    // The real reader (cache-busted so it re-reads the repointed sessions dir).
    const { getAllSessions, loadPrCacheSnapshot } = await import(
      `../sessions.ts?test=${crypto.randomUUID()}`
    );
    // The PR bulk cache lives in pr-cache.ts, which the cache-busting query
    // does NOT reload — reseed it from the snapshot the generator just wrote
    // (the same explicit reseed the real demo boot does).
    loadPrCacheSnapshot();
    const sessions = getAllSessions();
    const byId = new Map(sessions.map((s: { id: string }) => [s.id, s]));
    for (const id of result.sessionIds) {
      expect(byId.has(id)).toBe(true);
    }

    // Failed session carries its terminal error on the file.
    const failed = JSON.parse(
      readFileSync(join(result.sessionsDir, "bks-demo-failed.json"), "utf-8"),
    );
    expect(failed.lastRunError?.message).toContain("Usage limit");

    // The hero session picks up the seeded v4 PR snapshot through the real
    // enrichment path (repo unset → default repo, branch match).
    const hero = byId.get("bks-demo-pr") as {
      prNumber?: number;
      prChecks?: { passed: number };
    };
    expect(hero?.prNumber).toBe(128);
    expect(hero?.prChecks?.passed).toBe(5);

    // The demo worktree is a real dirty git checkout on the demo branch.
    const status = Bun.spawnSync(["git", "status", "--porcelain"], {
      cwd: result.worktreeDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(status.exitCode).toBe(0);
    expect(status.stdout.toString().trim().length).toBeGreaterThan(0);
    const branch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: result.worktreeDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(branch.stdout.toString().trim()).toBe("demo/fix-flaky-upload");
  });

  it("writes transcripts that parse line-by-line and cover every rendered kind", async () => {
    const transcriptDir = join(home, ".claude/projects/-demo-engine");
    const { parseJsonlLines } = await import("../jsonl-parser");
    const files = readdirSync(transcriptDir).filter((f) =>
      f.endsWith(".jsonl"),
    );
    expect(files.length).toBeGreaterThanOrEqual(7);

    const kinds = new Set<string>();
    let sawError = false;
    let sawCompaction = false;
    let sawBigOutput = false;
    for (const file of files) {
      const raw = readFileSync(join(transcriptDir, file), "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());
      for (const line of lines) JSON.parse(line); // every line is valid JSON
      const entries = parseJsonlLines(lines);
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        kinds.add(e.type);
        if (e.isError) sawError = true;
        if (e.noticeKind === "compaction") sawCompaction = true;
        if (e.type === "tool_result" && e.content.length > 32 * 1024)
          sawBigOutput = true;
      }
    }
    expect([...kinds].sort()).toEqual(
      ["assistant", "system", "tool_use", "tool_result", "user"].sort(),
    );
    expect(sawError).toBe(true);
    expect(sawCompaction).toBe(true);
    expect(sawBigOutput).toBe(true);

    // The steered turn splits into two attributed bubbles.
    const steered = parseJsonlLines(
      readFileSync(join(transcriptDir, "ses_demo05.jsonl"), "utf-8")
        .split("\n")
        .filter((l) => l.trim()),
    );
    const attributed = steered.filter(
      (e) => e.type === "user" && /^\[(Alex|Sam)\] /.test(e.content),
    );
    expect(attributed.length).toBe(2);
  });

  it("is idempotent via the marker file", async () => {
    const { generateDemoData, demoMarkerPath } = await import("./generate");
    const { existsSync } = await import("node:fs");
    expect(existsSync(demoMarkerPath())).toBe(true);

    const snapshot = (dir: string) =>
      generatedTextFiles(dir)
        .map((p) => `${p}:${statSync(p).size}:${statSync(p).mtimeMs}`)
        .sort()
        .join("\n");
    const before = snapshot(home);
    const again = generateDemoData();
    expect(again.created).toBe(false);
    expect(again.sessionIds).toEqual([]);
    expect(snapshot(home)).toBe(before);
  });

  it("contains no absolute /home/ubuntu literals anywhere in the output", () => {
    const files = generatedTextFiles(home);
    expect(files.length).toBeGreaterThan(15);
    for (const path of files) {
      const text = readFileSync(path, "utf-8");
      expect(text.includes("/home/ubuntu")).toBe(false);
    }
  });
});
