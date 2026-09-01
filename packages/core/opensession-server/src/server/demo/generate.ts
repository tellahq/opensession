/**
 * Synthetic demo dataset generator — pure disk writes, no server graph, no
 * network. Everything resolves through the SAME resolvers the server reads
 * with (paths.ts OPENSESSION_SESSIONS_DIR live binding, rename-compat stateDir(),
 * pi-transcript PI_TRANSCRIPTS_DIR live binding, statePath() for the
 * PR snapshot caches), so the dataset lands in whatever scratch state the
 * instance is pointed at — never a hardcoded home path.
 *
 * Idempotent via a marker file in the sessions dir (written LAST, so a failed
 * partial run regenerates on the next attempt). Callers: startDemo() at boot
 * under OPENSESSION_DEMO=1, and scripts/demo-data.ts standalone.
 *
 * Import discipline: only leaf modules (paths/rename-compat/pi-transcript
 * line builders). Never import sessions/agent-runner/automations here — the
 * standalone CLI must not drag in modules with tickers or socket binds.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { OPENSESSION_SESSIONS_DIR } from "../paths";
import { stateDir, statePath } from "../paths";
import { configPath } from "../config";
import {
  DEMO_BRANCH,
  DEMO_COMMITTED_CHANGE,
  DEMO_GH_REPO,
  DEMO_MARKER_FILE,
  DEMO_REPO_FILES,
  DEMO_REPO_ID,
  DEMO_REPO_WT_PREFIX,
  DEMO_UNCOMMITTED_CHANGE,
  DEMO_UNTRACKED_FILE,
  demoAuditLines,
  demoAutomations,
  demoGoal,
  demoPrDetails,
  demoPrInfo,
  demoSessions,
} from "./fixtures";

export interface DemoGenerateOpts {
  /**
   * Also seed the HOME-rooted stores (automations/audit/goals via
   * stateDir(), plus the two PR snapshot caches). Default true — demo
   * instances run with their state root (HOME) redirected. The standalone
   * CLI passes false when only the sessions dir was redirected, so nothing ever
   * lands in the invoking user's real ~/.opensession-* stores.
   */
  homeStores?: boolean;
}

export interface DemoGenerateResult {
  /** false = the marker was already present; nothing was written. */
  created: boolean;
  sessionsDir: string;
  transcriptsDir: string;
  markerPath: string;
  worktreeDir: string;
  sessionIds: string[];
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Run git with author/committer pinned and host git config isolated, so the
 *  generated repo is reproducible and never inherits signing/hooks settings. */
function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Open Session Demo",
      "-c",
      "user.email=demo@opensession.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `[demo] git ${args.join(" ")} failed in ${cwd}: ${proc.stderr.toString().trim()}`,
    );
  }
}

/** Real git repo (main) + worktree (DEMO_BRANCH) with a committed fix, a
 *  dirty edit and an untracked file — what the Diff panel needs to render. */
function buildDemoRepo(repoDir: string, worktreeDir: string): void {
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(dirname(worktreeDir), { recursive: true });
  git(repoDir, "init", "-b", "main");
  for (const [rel, content] of Object.entries(DEMO_REPO_FILES)) {
    writeText(join(repoDir, rel), content);
  }
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-m", "acme-todo: initial import");
  git(repoDir, "worktree", "add", worktreeDir, "-b", DEMO_BRANCH);
  for (const [rel, content] of Object.entries(DEMO_COMMITTED_CHANGE)) {
    writeText(join(worktreeDir, rel), content);
  }
  git(worktreeDir, "add", "-A");
  git(
    worktreeDir,
    "commit",
    "-m",
    "fix: honor the full retry budget in uploadChunk",
  );
  for (const [rel, content] of Object.entries(DEMO_UNCOMMITTED_CHANGE)) {
    writeText(join(worktreeDir, rel), content);
  }
  for (const [rel, content] of Object.entries(DEMO_UNTRACKED_FILE)) {
    writeText(join(worktreeDir, rel), content);
  }
}

export function demoMarkerPath(): string {
  return join(OPENSESSION_SESSIONS_DIR, DEMO_MARKER_FILE);
}

/**
 * Register the demo repo in the instance config so the repo registry actually
 * owns the generated checkout: `repoForPath()` resolves a path either by
 * equality with `repo.repo` or by the `<worktreesDir>/<wtPrefix>-` prefix, so
 * BOTH have to point into the demo dataset. Without this the seeded PR cache
 * was unreachable, the Changes tab 500'd ("No registered repo owns path …")
 * and Home's PR-worktree list stayed empty.
 *
 * Merges into an existing config rather than replacing it, and is only called
 * for demo instances that own their state root (never the standalone CLI with
 * `homeStores: false`, which would write the invoking user's real config).
 */
function registerDemoRepo(repoDir: string, worktreesDir: string): void {
  const path = configPath();
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {}
  const repos = (config.repos as Record<string, unknown>) || {};
  const paths = (config.paths as Record<string, unknown>) || {};
  writeJson(path, {
    ...config,
    repos: {
      ...repos,
      [DEMO_REPO_ID]: {
        label: DEMO_REPO_ID,
        description: "Synthetic demo repo — nothing here is real.",
        repo: repoDir,
        wtPrefix: DEMO_REPO_WT_PREFIX,
        defaultBranch: "main",
        ghRepo: DEMO_GH_REPO,
        default: true,
        // Never let a demo instance try to refresh PRs against a repo that
        // does not exist on GitHub.
        prCache: false,
      },
    },
    paths: { ...paths, worktreesDir },
  });
}

export function generateDemoData(
  opts: DemoGenerateOpts = {},
): DemoGenerateResult {
  const homeStores = opts.homeStores !== false;
  const sessionsDir = OPENSESSION_SESSIONS_DIR;
  const transcriptsDir = statePath(".claude/projects/-demo-engine");
  const markerPath = demoMarkerPath();
  const demoRoot = join(sessionsDir, "demo");
  const repoDir = join(demoRoot, "repo");
  // Worktrees live under a demo-owned worktrees dir named the way the registry
  // expects (`<worktreesDir>/<wtPrefix>-<branch>`), which is what lets
  // repoForPath() attribute this checkout to the demo repo.
  const worktreesDir = join(demoRoot, "worktrees");
  const worktreeDir = join(
    worktreesDir,
    `${DEMO_REPO_WT_PREFIX}-${DEMO_BRANCH}`,
  );
  const now = Date.now();

  if (existsSync(markerPath)) {
    return {
      created: false,
      sessionsDir,
      transcriptsDir,
      markerPath,
      worktreeDir,
      sessionIds: [],
    };
  }

  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(transcriptsDir, { recursive: true });

  buildDemoRepo(repoDir, worktreeDir);

  // Sessions + their engine transcripts (claude-shape jsonl; the server
  // lazily imports these into transcripts.db on first watch).
  const sessions = demoSessions({ now, worktreeDir, repoDir });
  for (const s of sessions) {
    writeJson(join(sessionsDir, `${s.id}.json`), s.file);
    if (s.engineSessionId && s.lines.length) {
      writeText(
        join(transcriptsDir, `${s.engineSessionId}.jsonl`),
        `${s.lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
      );
    }
  }

  if (homeStores) {
    // Repo registry first: everything below (and every repo-derived UI
    // surface) keys off the demo repo being a real registered repo.
    registerDemoRepo(repoDir, worktreesDir);

    // PR snapshot caches (v4 bulk + detail; both boot-seeded, served stale —
    // sessions.ts / pr-info.ts), keyed under the demo repo just registered.
    writeJson(statePath(".opensession-pr-cache.json"), {
      version: 4,
      repos: {
        [DEMO_REPO_ID]: {
          [DEMO_BRANCH]: demoPrInfo(now, DEMO_GH_REPO, "bks-demo-pr"),
        },
      },
      recentLimits: { [DEMO_REPO_ID]: 500 },
      probeEtags: {},
      lastFullRefresh: {},
    });
    writeJson(statePath(".opensession-pr-details-cache.json"), {
      [`${DEMO_GH_REPO}\u0000${DEMO_BRANCH}`]: {
        data: demoPrDetails(now, DEMO_GH_REPO),
        ts: now,
      },
    });

    // Automations + run history.
    const automationsDir = stateDir("automations");
    for (const automation of demoAutomations(now)) {
      writeJson(join(automationsDir, `${automation.id}.json`), automation);
    }

    // Audit day file (today, UTC — the viewer's date picker defaults to today).
    const day = new Date(now).toISOString().slice(0, 10);
    writeText(
      join(stateDir("audit"), `audit-${day}.jsonl`),
      `${demoAuditLines(now)
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );

    // Goal + ledger (paused + far-future wake: never ticker-runnable).
    const goalsDir = stateDir("goals");
    const { goal, ledger } = demoGoal(now, goalsDir);
    writeJson(join(goalsDir, `${goal.id}.json`), goal);
    writeText(goal.stateFile, ledger);
  }

  // Marker LAST — a partial failure above leaves no marker, so the next run
  // regenerates. Has no `id`, so the session scanner skips it.
  writeJson(markerPath, {
    demo: true,
    version: 1,
    generatedAt: new Date(now).toISOString(),
    note: "Synthetic Open Session demo dataset — delete this file to regenerate.",
  });

  return {
    created: true,
    sessionsDir,
    transcriptsDir,
    markerPath,
    worktreeDir,
    sessionIds: sessions.map((s) => s.id),
  };
}
