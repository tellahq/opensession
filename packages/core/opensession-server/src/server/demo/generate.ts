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

import { access, mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { OPENSESSION_SESSIONS_DIR } from "../paths";
import { stateDir, statePath } from "../paths";
import { configPath, publishConfigSnapshot } from "../config";
import {
  DEMO_BRANCH,
  DEMO_COMMITTED_CHANGE,
  DEMO_GH_REPO,
  DEMO_MARKER_FILE,
  DEMO_RENDER_ASSET,
  DEMO_RENDER_SESSION_ID,
  DEMO_SCRIPT_RENDER_SESSION_ID,
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
import { encodePng, type PngRect, type Rgb } from "./png";
import { MONITOR_FIT_PAGE } from "./monitor-fit-page";
import { injectBootstrap } from "../html-render/document";

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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** Run git with author/committer pinned and host git config isolated, so the
 *  generated repo is reproducible and never inherits signing/hooks settings. */
async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(
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
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `[demo] git ${args.join(" ")} failed in ${cwd}: ${stderr.trim()}`,
    );
  }
}

/** Real git repo (main) + worktree (DEMO_BRANCH) with a committed fix, a
 *  dirty edit and an untracked file — what the Diff panel needs to render. */
/**
 * A 960x540 "retry timeline" still: three attempt bars on a light card.
 * Before the fix the third attempt never runs (an empty slot and a red
 * failure bar); after it, all three run and the third succeeds. Fixture
 * art, not product UI, so the colours are literal.
 */
function retryStill(build: "before" | "after"): Uint8Array {
  const bg: Rgb = [244, 244, 246];
  const card: Rgb = [255, 255, 255];
  const ink: Rgb = [38, 38, 42];
  const track: Rgb = [228, 228, 232];
  const ran: Rgb = [58, 120, 240];
  const ok: Rgb = [46, 160, 96];
  const failed: Rgb = [220, 64, 64];
  const rects: PngRect[] = [
    { x: 60, y: 50, w: 840, h: 440, color: card },
    { x: 100, y: 90, w: 260, h: 14, color: ink },
  ];
  const attempts = build === "before" ? [1, 1, 0] : [1, 1, 1];
  attempts.forEach((ranIt, i) => {
    const y = 160 + i * 100;
    rects.push({ x: 100, y, w: 90, h: 12, color: ink });
    rects.push({ x: 220, y: y - 12, w: 640, h: 36, color: track });
    if (ranIt) rects.push({ x: 220, y: y - 12, w: 420, h: 36, color: ran });
  });
  const result =
    build === "before"
      ? { x: 220, y: 428, w: 640, h: 24, color: failed }
      : { x: 640, y: 348, w: 220, h: 36, color: ok };
  rects.push(result);
  return encodePng(960, 540, bg, rects);
}

async function buildDemoRepo(
  repoDir: string,
  worktreeDir: string,
): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  await mkdir(dirname(worktreeDir), { recursive: true });
  await git(repoDir, "init", "-b", "main");
  for (const [rel, content] of Object.entries(DEMO_REPO_FILES)) {
    await writeText(join(repoDir, rel), content);
  }
  await git(repoDir, "add", "-A");
  await git(repoDir, "commit", "-m", "acme-todo: initial import");
  await git(repoDir, "worktree", "add", worktreeDir, "-b", DEMO_BRANCH);
  for (const [rel, content] of Object.entries(DEMO_COMMITTED_CHANGE)) {
    await writeText(join(worktreeDir, rel), content);
  }
  await git(worktreeDir, "add", "-A");
  await git(
    worktreeDir,
    "commit",
    "-m",
    "fix: honor the full retry budget in uploadChunk",
  );
  for (const [rel, content] of Object.entries(DEMO_UNCOMMITTED_CHANGE)) {
    await writeText(join(worktreeDir, rel), content);
  }
  for (const [rel, content] of Object.entries(DEMO_UNTRACKED_FILE)) {
    await writeText(join(worktreeDir, rel), content);
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
async function registerDemoRepo(
  repoDir: string,
  worktreesDir: string,
): Promise<void> {
  const path = configPath();
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(path, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {}
  const repos = (config.repos as Record<string, unknown>) || {};
  const paths = (config.paths as Record<string, unknown>) || {};
  const next = {
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
  };
  await writeJson(path, next);
  publishConfigSnapshot(path, JSON.stringify(next));
}

export async function generateDemoData(
  opts: DemoGenerateOpts = {},
): Promise<DemoGenerateResult> {
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

  const markerExists = await access(markerPath).then(
    () => true,
    () => false,
  );
  if (markerExists) {
    return {
      created: false,
      sessionsDir,
      transcriptsDir,
      markerPath,
      worktreeDir,
      sessionIds: [],
    };
  }

  await mkdir(sessionsDir, { recursive: true });
  await mkdir(transcriptsDir, { recursive: true });

  await buildDemoRepo(repoDir, worktreeDir);

  // The stills the hero session shows in place (OPENSESSION_IMAGE and
  // OPENSESSION_COMPARE lines in its transcript). Real files, because the
  // /media route streams from disk; under the sessions dir so the demo's
  // state directory owns them.
  const mediaDir = join(demoRoot, "media");
  await mkdir(mediaDir, { recursive: true });
  await writeFile(join(mediaDir, "retry-before.png"), retryStill("before"));
  await writeFile(join(mediaDir, "retry-after.png"), retryStill("after"));

  // Sessions + their engine transcripts (claude-shape jsonl; the server
  // lazily imports these into transcripts.db on first watch).
  const sessions = demoSessions({ now, worktreeDir, repoDir, mediaDir });
  for (const s of sessions) {
    await writeJson(join(sessionsDir, `${s.id}.json`), s.file);
    if (s.engineSessionId && s.lines.length) {
      await writeText(
        join(transcriptsDir, `${s.engineSessionId}.jsonl`),
        `${s.lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
      );
    }
  }

  // The page the HTML render session shows, stored where the local asset
  // store keeps that session's files and as html_render stores one.
  const renderPath = join(
    stateDir("assets"),
    DEMO_RENDER_SESSION_ID,
    DEMO_RENDER_ASSET,
  );
  await mkdir(dirname(renderPath), { recursive: true });
  await writeFile(renderPath, injectBootstrap(MONITOR_FIT_PAGE));
  const scriptRenderPath = join(
    stateDir("assets"),
    DEMO_SCRIPT_RENDER_SESSION_ID,
    DEMO_RENDER_ASSET,
  );
  await mkdir(dirname(scriptRenderPath), { recursive: true });
  await writeFile(scriptRenderPath, injectBootstrap(MONITOR_FIT_PAGE));

  if (homeStores) {
    // Repo registry first: everything below (and every repo-derived UI
    // surface) keys off the demo repo being a real registered repo.
    await registerDemoRepo(repoDir, worktreesDir);

    // PR snapshot caches (v4 bulk + detail; both boot-seeded, served stale —
    // sessions.ts / pr-info.ts), keyed under the demo repo just registered.
    await writeJson(statePath(".opensession-pr-cache.json"), {
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
    await writeJson(statePath(".opensession-pr-details-cache.json"), {
      [`${DEMO_GH_REPO}\u0000${DEMO_BRANCH}`]: {
        data: demoPrDetails(now, DEMO_GH_REPO),
        ts: now,
      },
    });

    // Automations + run history.
    const automationsDir = stateDir("automations");
    for (const automation of demoAutomations(now)) {
      await writeJson(
        join(automationsDir, `${automation.id}.json`),
        automation,
      );
    }

    // Audit day file (today, UTC — the viewer's date picker defaults to today).
    const day = new Date(now).toISOString().slice(0, 10);
    await writeText(
      join(stateDir("audit"), `audit-${day}.jsonl`),
      `${demoAuditLines(now)
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );

    // Goal + ledger (paused + far-future wake: never ticker-runnable).
    const goalsDir = stateDir("goals");
    const { goal, ledger } = demoGoal(now, goalsDir);
    await writeJson(join(goalsDir, `${goal.id}.json`), goal);
    await writeText(goal.stateFile, ledger);
  }

  // Marker LAST — a partial failure above leaves no marker, so the next run
  // regenerates. Has no `id`, so the session scanner skips it.
  await writeJson(markerPath, {
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
