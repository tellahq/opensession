/**
 * Warm dep templates — per-repo prebuilt node_modules kept fresh from the
 * default branch on a schedule, so a fresh worktree gets its deps ~instantly
 * instead of paying a cold bun install (~20-25s) at create time.
 *
 * (Until 2026-07-21 this also seeded preview build artifacts — .next,
 * ReScript output, WASM — and verified each refresh by booting the dev
 * server and warming routes. That "warm preview" concept never proved out:
 * zero host preview boots across 148 seeds in its last 3 days, while the
 * seeding itself churned ~16s of disk per create and raced the engine's
 * turn-start git snapshot. Now it's deps only.)
 *
 * How it works:
 *  - Each enabled repo gets ONE template worktree at
 *    `<worktreesDir>/<wtPrefix>-warm-template`, checked out DETACHED at
 *    `origin/<defaultBranch>`. Detached is deliberate: listWorktrees() only
 *    surfaces worktrees with a branch line, so the template can never be
 *    adopted by workspaces/sessions, and there's no branch to accidentally
 *    push.
 *  - A refresh (scheduled every `intervalHours`, or via the Settings
 *    "Refresh now" button) fetches + `reset --hard origin/<defaultBranch>`,
 *    installs deps, and captures a MANIFEST of the template's node_modules
 *    trees (`git ls-files -o -i --exclude-standard --directory`, filtered to
 *    node_modules entries).
 *  - SPARES: hardlinking a 253k-file node_modules farm takes ~15s (`cp -al`;
 *    parallel linking is slower still — ext4 serializes the journal), so the
 *    link cost is paid in the background instead of at create time. A small
 *    pool of pre-linked spares sits next to the worktrees; seeding a fresh
 *    worktree ADOPTS one via rename(2) (~instant, same fs), then the pool
 *    replenishes itself. Pool empty (burst of creates, first boot) → fall
 *    back to a direct cp -al from the template, exactly the old behavior.
 *
 * Config (Settings → Warm previews): `<sessions>/warm-templates/config.json`
 *   { "repos": { "app": { "enabled": true, "intervalHours": 6 } } }
 * State per repo: `<sessions>/warm-templates/<repoId>.state.json` (+ the
 * manifest at `<repoId>.manifest`, only rewritten on a SUCCESSFUL refresh so
 * a failed refresh keeps seeding from the last good one).
 *
 * Everything here is host-side (covers host previews AND docker bind-mode
 * sandboxes, whose workspaces are these same worktrees). The remote-sandbox
 * warm path (pre-cloning the repo inside a daytona prewarm) lives in
 * sandbox/adapters/bootstrap.ts and reads the same config.
 */
import { $ } from "bun";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { configuredPaths, configuredRepos, type Repo } from "./config";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";

// ── Config ───────────────────────────────────────────────────────────────────

export interface WarmTemplateRepoConfig {
  enabled: boolean;
  /** Refresh cadence in hours (default 6). */
  intervalHours: number;
  /** Legacy (warm-preview era): routes curled after a template dev-server
   *  boot. Refresh no longer boots anything; kept so stored configs and the
   *  Settings API shape stay valid. */
  warmRoutes: string[];
}

const WARM_DEFAULTS: Omit<WarmTemplateRepoConfig, "enabled"> = {
  intervalHours: 6,
  warmRoutes: ["/", "/api/session"],
};

function warmDir(): string {
  return join(OPENSESSION_SESSIONS_DIR, "warm-templates");
}

function configFile(): string {
  return join(warmDir(), "config.json");
}

/** Per-repo warm config, read fresh per call (Settings PUTs rewrite it).
 *  warmRoutes precedence: explicit instance config → the repo's committed
 *  `.agents/preview.json` (read from the template worktree, so the repo
 *  itself declares which routes to pre-compile) → defaults. */
export function warmTemplateConfig(repoId: string): WarmTemplateRepoConfig {
  const raw = readWarmConfigRaw()[repoId];
  const explicitRoutes =
    Array.isArray(raw?.warmRoutes) && raw.warmRoutes.length
      ? raw.warmRoutes.filter(
          (r: unknown): r is string => typeof r === "string",
        )
      : null;
  return {
    enabled: raw?.enabled === true,
    intervalHours:
      typeof raw?.intervalHours === "number" && raw.intervalHours >= 1
        ? Math.floor(raw.intervalHours)
        : WARM_DEFAULTS.intervalHours,
    warmRoutes:
      explicitRoutes || repoWarmRoutes(repoId) || WARM_DEFAULTS.warmRoutes,
  };
}

/** `warmRoutes` from the repo's committed `.agents/preview.json`, read out of
 *  the template worktree when it exists. Null = the repo doesn't declare any. */
function repoWarmRoutes(repoId: string): string[] | null {
  const repo = configuredRepos()[repoId];
  if (!repo) return null;
  try {
    const f = join(warmTemplateDir(repo), ".agents", "preview.json");
    if (!existsSync(f)) return null;
    const routes = JSON.parse(readFileSync(f, "utf-8"))?.warmRoutes;
    if (Array.isArray(routes)) {
      const out = routes.filter(
        (r: unknown): r is string => typeof r === "string",
      );
      if (out.length) return out;
    }
  } catch {}
  return null;
}

function readWarmConfigRaw(): Record<string, any> {
  try {
    const f = configFile();
    if (!existsSync(f)) return {};
    const parsed = JSON.parse(readFileSync(f, "utf-8"));
    return parsed?.repos && typeof parsed.repos === "object"
      ? parsed.repos
      : {};
  } catch {
    return {};
  }
}

export function setWarmTemplateConfig(
  repoId: string,
  patch: Partial<
    Pick<WarmTemplateRepoConfig, "enabled" | "intervalHours" | "warmRoutes">
  >,
): WarmTemplateRepoConfig {
  mkdirSync(warmDir(), { recursive: true });
  const repos = readWarmConfigRaw();
  repos[repoId] = { ...repos[repoId], ...patch };
  writeJsonAtomic(configFile(), { repos });
  const cfg = warmTemplateConfig(repoId);
  // Turning a repo on shouldn't wait for the next sweep tick.
  if (patch.enabled) void refreshWarmTemplate(repoId).catch(() => {});
  return cfg;
}

// ── State ────────────────────────────────────────────────────────────────────

export interface WarmTemplateState {
  repoId: string;
  dir: string;
  /** origin/<defaultBranch> sha the template was last built at. */
  sha?: string;
  refreshedAt?: string;
  /** Last refresh wall time (ms). */
  lastDurationMs?: number;
  /** Whether the last refresh completed (deps installed + manifest captured). */
  ok?: boolean;
  lastError?: string;
  /** Artifact entries in the manifest (informational, for the UI). */
  manifestEntries?: number;
}

function stateFile(repoId: string): string {
  return join(warmDir(), `${repoId}.state.json`);
}

function manifestFile(repoId: string): string {
  return join(warmDir(), `${repoId}.manifest`);
}

function warmTemplateState(repoId: string): WarmTemplateState | null {
  try {
    const f = stateFile(repoId);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf-8")) as WarmTemplateState;
  } catch {
    return null;
  }
}

function writeState(state: WarmTemplateState): void {
  try {
    mkdirSync(warmDir(), { recursive: true });
    writeJsonAtomic(stateFile(state.repoId), state);
  } catch (e) {
    console.warn(`[warm-template] persist(${state.repoId}) failed:`, e);
  }
}

/** The template worktree path for a repo (whether or not it exists yet). */
function warmTemplateDir(repo: Repo): string {
  return `${configuredPaths().worktreesDir}/${repo.wtPrefix}-warm-template`;
}

// In-flight refreshes (repoId → completion promise), parked on globalThis so
// --hot reloads can't double-refresh a repo.
const g = globalThis as unknown as {
  __warmTemplateRefreshing?: Map<string, Promise<void>>;
  __warmTemplateSeeding?: Set<string>;
  __warmTemplateSweepTimer?: ReturnType<typeof setInterval>;
  __warmSpareReplenishing?: Map<string, Promise<void>>;
};
const refreshing: Map<string, Promise<void>> = (g.__warmTemplateRefreshing ??=
  new Map());
// Worktrees with a seed in flight (one seed per worktree — see seedWorktree…).
const seeding: Set<string> = (g.__warmTemplateSeeding ??= new Set());

// Cross-PROCESS refresh marker: the in-memory `refreshing` map can't be seen
// by other processes (a CLI-triggered refresh vs the live server's seeds —
// exactly the race that fed a mid-reset template into a session seed on
// 2026-07-09). doRefresh holds this file; seeds wait for / bail on it.
function refreshLockFile(repoId: string): string {
  return join(warmDir(), `${repoId}.refresh.lock`);
}

function refreshLockHeld(repoId: string): boolean {
  try {
    const f = refreshLockFile(repoId);
    if (!existsSync(f)) return false;
    // A crashed refresh must not wedge seeding forever — stale locks expire.
    return Date.now() - statSync(f).mtimeMs < 20 * 60_000;
  } catch {
    return false;
  }
}

// ── Manifest ─────────────────────────────────────────────────────────────────

/** Runtime junk that must never be seeded into a fresh worktree: per-worktree
 *  port allocations, preview tunnels contract, logs, env files (seedWebappEnv
 *  owns .env.local), and editor/tool droppings. */
const MANIFEST_EXCLUDES: RegExp[] = [
  /^\.ports(\.conf|\/)/,
  /^\.tunnels\.env$/,
  /(^|\/)[^/]*\.log$/,
  /(^|\/)\.env(\..+)?$/,
  /^\.direnv\//,
  /(^|\/)\.DS_Store$/,
];

/** Filter raw `git ls-files -o -i --directory` output into seedable entries.
 *  Exported for tests. */
export function filterManifest(lines: string[]): string[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !MANIFEST_EXCLUDES.some((re) => re.test(l)));
}

/** True when a manifest entry is a node_modules tree — safe (and important,
 *  it's multi-GB) to hardlink rather than copy. Exported for tests. */
export function isNodeModulesEntry(entry: string): boolean {
  return /(^|\/)node_modules\/$/.test(entry);
}

/** What actually gets seeded: node_modules trees only. Applied at BOTH
 *  capture and seed time, so manifests from the warm-preview era (which also
 *  listed .next/ReScript/WASM artifacts) seed identically to fresh ones.
 *  Exported for tests. */
export function seedableManifest(lines: string[]): string[] {
  return filterManifest(lines).filter(isNodeModulesEntry);
}

// ── Template status ──────────────────────────────────────────────────────────

/**
 * The one answer to "is this repo's template usable right now".
 *
 * `state.ok` alone was never enough: a recreated template worktree (an
 * external cleanup deleted the original, which the hourly closed-worktree
 * cron did 180 times until it learned to skip `-warm-template`) satisfies the
 * sha check while carrying zero node_modules, and treating that as warm
 * wedged the template empty forever and produced husk spares. So "warm" means
 * state + manifest + every dep tree verified on disk, and it is the ONLY
 * variant carrying the entry list: no caller can link from a template it did
 * not verify.
 *
 * "refreshing" folds BOTH refresh guards: the in-memory map (this process)
 * and the `*.refresh.lock` file (any process). A template being reset under
 * us is neither warm nor stale, so callers must not link from it, and must
 * not queue a second rebuild of it.
 */
export type TemplateStatus =
  | { kind: "warm"; dir: string; sha: string; entries: string[] }
  | { kind: "refreshing" }
  | { kind: "stale"; reason: string }
  | { kind: "absent" };

export function templateStatus(repoId: string): TemplateStatus {
  if (refreshing.has(repoId) || refreshLockHeld(repoId))
    return { kind: "refreshing" };
  return templateWarmth(repoId);
}

/** templateStatus minus the refresh guards, for doRefresh: it holds both of
 *  them itself and still needs to know whether the tree is already warm. */
function templateWarmth(
  repoId: string,
): Exclude<TemplateStatus, { kind: "refreshing" }> {
  const state = warmTemplateState(repoId);
  if (!state) return { kind: "absent" };
  if (!state.ok || !state.sha) {
    return {
      kind: "stale",
      reason: state.lastError || "last refresh did not complete",
    };
  }
  if (!existsSync(state.dir))
    return { kind: "stale", reason: "template worktree missing" };
  const mf = manifestFile(repoId);
  if (!existsSync(mf)) return { kind: "stale", reason: "no manifest" };
  let entries: string[];
  try {
    entries = seedableManifest(readFileSync(mf, "utf-8").split("\n"));
  } catch (e) {
    return {
      kind: "stale",
      reason: `manifest unreadable: ${String((e as any)?.message || e)}`,
    };
  }
  if (!entries.length)
    return { kind: "stale", reason: "manifest lists no dep trees" };
  const missing = entries.find(
    (e) => !existsSync(join(state.dir, e.replace(/\/$/, ""))),
  );
  if (missing)
    return { kind: "stale", reason: `dep tree ${missing} missing on disk` };
  return { kind: "warm", dir: state.dir, sha: state.sha, entries };
}

// ── Refresh ──────────────────────────────────────────────────────────────────

/**
 * Refresh a repo's warm template (idempotent; concurrent calls share one
 * run). `force` rebuilds even when origin's sha hasn't moved — the scheduled
 * sweep passes false so an unchanged main is a cheap fetch + no-op.
 */
export function refreshWarmTemplate(
  repoId: string,
  opts?: { force?: boolean },
): Promise<void> {
  const inflight = refreshing.get(repoId);
  if (inflight) return inflight;
  const run = doRefresh(repoId, opts?.force === true).finally(() => {
    if (refreshing.get(repoId) === run) refreshing.delete(repoId);
  });
  refreshing.set(repoId, run);
  // Rotate the spare pool AFTER the refresh settles — calling from inside
  // doRefresh trips replenish's own mid-refresh guard (refreshing map + lock
  // file are still held there) and silently no-ops. Harmless after a failed
  // refresh: the state.ok gate inside replenish handles that.
  void run.then(() => {
    const repo = configuredRepos()[repoId];
    if (repo) void replenishSpares(repo).catch(() => {});
  });
  return run;
}

async function doRefresh(repoId: string, force: boolean): Promise<void> {
  const repo = configuredRepos()[repoId];
  if (!repo) return;
  if (repo.sharedCheckout) return; // opensession self-hosts; nothing to warm
  const cfg = warmTemplateConfig(repoId);
  if (!cfg.enabled && !force) return;
  const dir = warmTemplateDir(repo);
  const started = Date.now();
  const prev = warmTemplateState(repoId);
  const fail = async (msg: string) => {
    console.warn(`[warm-template] ${repoId}: ${msg}`);
    writeState({
      ...(prev || {}),
      repoId,
      dir,
      ok: false,
      lastError: msg.slice(0, 500),
      lastDurationMs: Date.now() - started,
    });
  };

  try {
    mkdirSync(warmDir(), { recursive: true });
    writeFileSync(
      refreshLockFile(repoId),
      `${process.pid} ${new Date().toISOString()}\n`,
    );
    // Lazy import: worktree.ts imports back into this module's consumers —
    // keep the static graph acyclic.
    const { withGitLock, installWorktreeDeps } = await import("./worktree");

    // 1. Ensure the detached template worktree exists.
    if (!existsSync(dir)) {
      console.log(
        `[warm-template] ${repoId}: creating template worktree at ${dir}`,
      );
      await withGitLock(async () => {
        await $`git -C ${repo.repo} worktree prune`.quiet().nothrow();
        if (existsSync(dir)) return;
        await $`git -C ${repo.repo} fetch origin ${repo.defaultBranch} --quiet`.nothrow();
        await $`git -C ${repo.repo} worktree add --detach ${dir} origin/${repo.defaultBranch}`;
      });
    }

    // 2. Fetch; skip the expensive rebuild when nothing moved and the last
    //    refresh was good.
    await $`git -C ${dir} fetch origin ${repo.defaultBranch} --quiet`.nothrow();
    const sha = (
      await $`git -C ${dir} rev-parse --short origin/${repo.defaultBranch}`
        .nothrow()
        .text()
    ).trim();
    if (!sha)
      return void (await fail(`can't resolve origin/${repo.defaultBranch}`));
    const current = templateWarmth(repoId); // not templateStatus: we hold both guards
    if (!force && current.kind === "warm" && current.sha === sha) {
      return; // already warm at this sha
    }
    console.log(
      `[warm-template] ${repoId}: refreshing template to ${sha} (${dir})`,
    );

    // Step logging + watchdog: a wedged subprocess await must FAIL the
    // refresh, not hang it forever (seen live 2026-07-21: an in-server
    // install await never settled while the same commands finished instantly
    // by hand). A timed-out step's work keeps running detached; fail() +
    // the finally below clear the lock so seeding/spares move on.
    const step = async <T>(
      name: string,
      ms: number,
      run: () => Promise<T>,
    ): Promise<T> => {
      console.log(`[warm-template] ${repoId}: ${name}…`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${name} timed out after ${Math.round(ms / 1000)}s`),
            ),
          ms,
        );
      });
      try {
        return await Promise.race([run(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    };

    // 3. Advance the tree. reset --hard touches TRACKED files only — the
    //    whole point is that gitignored build artifacts survive, so the
    //    rebuild below is incremental. This is our dedicated detached
    //    worktree; the shared-checkout no-reset rule doesn't apply here.
    await step("reset", 2 * 60_000, () =>
      $`git -C ${dir} reset --hard origin/${repo.defaultBranch}`
        .quiet()
        .then(() => {}),
    );

    // 4. Deps + env seeding (same helper the session worktrees use). This is
    //    also the verification: a template whose install fails is never
    //    marked ok.
    await step("install deps", 10 * 60_000, () =>
      installWorktreeDeps(repo, dir, `warm-template:${repoId}`),
    );

    // 5. Capture the seedable manifest (only on success, so a failed refresh
    //    keeps seeding from the last good state).
    const raw = await step("capture manifest", 2 * 60_000, () =>
      $`git -C ${dir} ls-files -o -i --exclude-standard --directory`.text(),
    );
    const manifest = seedableManifest(raw.split("\n"));
    if (!manifest.length)
      return void (await fail("refresh produced no node_modules to seed"));
    writeFileSync(manifestFile(repoId), manifest.join("\n") + "\n");

    writeState({
      repoId,
      dir,
      sha,
      refreshedAt: new Date().toISOString(),
      lastDurationMs: Date.now() - started,
      ok: true,
      manifestEntries: manifest.length,
    });
    console.log(
      `[warm-template] ${repoId}: template warm at ${sha} — ${manifest.length} dep trees, ${Math.round((Date.now() - started) / 1000)}s`,
    );

    // (Spare-pool rotation happens in refreshWarmTemplate once this promise
    // settles — from here the mid-refresh guards would still block it.)
  } catch (e) {
    await fail(String((e as any)?.message || e));
  } finally {
    try {
      unlinkSync(refreshLockFile(repoId));
    } catch {}
  }
}

// ── Seeding ──────────────────────────────────────────────────────────────────

/**
 * Seed a fresh worktree's node_modules from the warm template. Called right
 * after `git worktree add`, before the normal dep install (which then
 * becomes a fast no-op). Fast path: adopt a prebuilt spare via rename(2)
 * (~instant), so the engine's turn-start git snapshot never races a 253k-file
 * link farm. Best-effort: any failure logs and the worktree just installs
 * cold like today. Returns true when seeding actually ran.
 */
export async function seedWorktreeFromWarmTemplate(
  repo: Repo,
  wtPath: string,
): Promise<boolean> {
  try {
    const cfg = warmTemplateConfig(repo.id);
    if (!cfg.enabled) return false;
    if (wtPath === warmTemplateDir(repo)) return false; // never seed the template itself

    // One seed per worktree at a time: duplicate create paths racing two
    // seeds into the same node_modules produced "cannot create directory:
    // File exists" and killed the whole seed (bks-019f48d6, 2026-07-09).
    if (seeding.has(wtPath)) return false;
    seeding.add(wtPath);
    try {
      const started = Date.now();

      // Fast path: adopt a spare. Spares own their links (independent of the
      // template tree), so a template mid-refresh doesn't matter here.
      const spare = claimSpare(repo);
      if (spare) {
        try {
          const rels = readFileSync(join(spare, SPARE_PATHS_FILE), "utf-8")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          let moved = 0;
          for (const rel of rels) {
            const src = join(spare, rel);
            const dst = join(wtPath, rel);
            if (!existsSync(src) || existsSync(dst)) continue;
            mkdirSync(dirname(dst), { recursive: true });
            renameSync(src, dst);
            moved++;
          }
          console.log(
            `[warm-template] seeded ${wtPath} from ${repo.id} spare (${moved} dep trees) in ${Date.now() - started}ms`,
          );
          return moved > 0;
        } finally {
          rmSync(spare, { recursive: true, force: true });
          void replenishSpares(repo).catch(() => {});
        }
      }

      // Cold path (pool empty: first boot or a burst of creates): hardlink
      // straight from the template. A refresh mid-flight is rewriting the
      // template under us — in-process we can await it; a refresh in ANOTHER
      // process is visible only via the lock file — wait briefly, then bail
      // to a cold install rather than link from a tree being reset (that
      // race aborted a seed live on 2026-07-09).
      let status = templateStatus(repo.id);
      if (status.kind === "refreshing") {
        const inflight = refreshing.get(repo.id);
        if (inflight) {
          await Promise.race([inflight, Bun.sleep(60_000)]);
        }
        for (
          let waited = 0;
          refreshLockHeld(repo.id) && waited < 90_000;
          waited += 5000
        ) {
          await Bun.sleep(5000);
        }
        status = templateStatus(repo.id);
      }
      if (status.kind !== "warm") {
        console.log(
          `[warm-template] ${repo.id} template not usable (${status.kind === "stale" ? status.reason : status.kind}); ${wtPath} installs cold`,
        );
        return false;
      }

      // Hardlink farms (~free disk for multi-GB trees; package managers
      // replace files rather than editing in place, so shared inodes are
      // safe). Per-entry best-effort: a conflict with a concurrent writer
      // (e.g. an already-running bun install) must not abort the other
      // entries — bun install reconciles whatever landed.
      for (const entry of status.entries) {
        const src = join(status.dir, entry).replace(/\/$/, "");
        const dst = join(wtPath, entry).replace(/\/$/, "");
        if (!existsSync(src) || existsSync(dst)) continue;
        mkdirSync(dirname(dst), { recursive: true });
        const r = await $`cp -al ${src} ${dst}`.quiet().nothrow();
        if (r.exitCode !== 0) {
          console.warn(
            `[warm-template] hardlink of ${entry} into ${wtPath} was partial (exit ${r.exitCode}) — bun install will reconcile`,
          );
        }
      }
      void replenishSpares(repo).catch(() => {});

      console.log(
        `[warm-template] seeded ${wtPath} from ${repo.id} template (${status.sha}) in ${Math.round((Date.now() - started) / 1000)}s (no spare available)`,
      );
      return true;
    } finally {
      seeding.delete(wtPath);
    }
  } catch (e) {
    console.warn(
      `[warm-template] seeding ${wtPath} failed (worktree installs cold):`,
      e,
    );
    return false;
  }
}

// ── Spare dep pools ──────────────────────────────────────────────────────────
//
// A spare is a pre-hardlinked copy of the template's node_modules trees,
// built in the background so a fresh worktree can adopt its deps with a
// rename instead of paying the ~15s cp -al at create time (parallel linking
// is slower still — ext4 serializes the metadata journal, measured 27s at
// 8-way). Layout:
//   <worktreesDir>/.warm-spares/<wtPrefix>/spare-<sha>-<rand>/<rel paths...>
// plus a .spare-paths file listing the node_modules rel paths inside.
// Claiming renames the spare dir to *.claimed-<rand> — atomic; the loser's
// rename throws and tries the next spare. Same filesystem as the worktrees
// by construction (sibling of the template), so rename(2) always applies.

const SPARE_TARGET = 2;
const SPARE_PATHS_FILE = ".spare-paths";

function sparesDir(repo: Repo): string {
  return join(configuredPaths().worktreesDir, ".warm-spares", repo.wtPrefix);
}

function listSpares(repo: Repo): string[] {
  try {
    return readdirSync(sparesDir(repo))
      .filter((n) => n.startsWith("spare-") && !n.includes(".claimed-"))
      .map((n) => join(sparesDir(repo), n));
  } catch {
    return [];
  }
}

/** A spare is intact when every tree its .spare-paths lists is present. */
function spareIntact(spare: string): boolean {
  try {
    const rels = readFileSync(join(spare, SPARE_PATHS_FILE), "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return rels.length > 0 && rels.every((rel) => existsSync(join(spare, rel)));
  } catch {
    return false;
  }
}

function claimSpare(repo: Repo): string | null {
  for (const spare of listSpares(repo)) {
    const claimed = `${spare}.claimed-${Math.random().toString(36).slice(2, 8)}`;
    try {
      renameSync(spare, claimed);
      return claimed;
    } catch {} // lost the race to a concurrent create — try the next one
  }
  return null;
}

const replenishing: Map<string, Promise<void>> = (g.__warmSpareReplenishing ??=
  new Map());

/** Top the spare pool back up to SPARE_TARGET (serialized per repo). */
function replenishSpares(repo: Repo): Promise<void> {
  const inflight = replenishing.get(repo.id);
  if (inflight) return inflight;
  const run = doReplenish(repo).finally(() => {
    if (replenishing.get(repo.id) === run) replenishing.delete(repo.id);
  });
  replenishing.set(repo.id, run);
  return run;
}

async function doReplenish(repo: Repo): Promise<void> {
  if (!warmTemplateConfig(repo.id).enabled) return;
  const dir = sparesDir(repo);
  mkdirSync(dir, { recursive: true });
  // Sweep leftovers: half-built spares and claimed dirs that were never
  // consumed (consumption deletes its claim within seconds) are junk after
  // an hour.
  for (const n of readdirSync(dir)) {
    if (!n.startsWith(".building-") && !n.includes(".claimed-")) continue;
    const p = join(dir, n);
    try {
      if (Date.now() - statSync(p).mtimeMs > 3_600_000)
        rmSync(p, { recursive: true, force: true });
    } catch {}
  }
  for (;;) {
    // One predicate for everything: last refresh good, trees actually there,
    // and no refresh (this process or another) rewriting them under us — the
    // post-refresh rotate, or the next sweep tick, picks that back up.
    const status = templateStatus(repo.id);
    if (status.kind !== "warm") return;
    // Unclaimed spares from an older template link outdated deps, and husk
    // spares (built while the template was missing its trees) seed nothing —
    // drop both so sessions start current; the loop below rebuilds fresh ones.
    for (const p of listSpares(repo)) {
      if (!p.includes(`spare-${status.sha}-`) || !spareIntact(p)) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {}
      }
    }
    if (listSpares(repo).length >= SPARE_TARGET) return;
    const entries = status.entries.map((e) => e.replace(/\/$/, ""));
    const building = join(
      dir,
      `.building-${Math.random().toString(36).slice(2, 8)}`,
    );
    const buildStarted = Date.now();
    try {
      mkdirSync(building, { recursive: true });
      for (const rel of entries) {
        // templateStatus verified every tree at the top of this iteration; a
        // tree that vanishes mid-build fails its cp and aborts the spare, and
        // the sweep's own templateStatus check forces a re-refresh.
        const src = join(status.dir, rel);
        const dst = join(building, rel);
        mkdirSync(dirname(dst), { recursive: true });
        await $`cp -al ${src} ${dst}`.quiet();
      }
      writeFileSync(
        join(building, SPARE_PATHS_FILE),
        entries.join("\n") + "\n",
      );
      renameSync(
        building,
        join(
          dir,
          `spare-${status.sha}-${Math.random().toString(36).slice(2, 8)}`,
        ),
      );
      console.log(
        `[warm-template] built ${repo.id} dep spare (${entries.length} trees) in ${Math.round((Date.now() - buildStarted) / 1000)}s`,
      );
    } catch (e) {
      rmSync(building, { recursive: true, force: true });
      console.warn(`[warm-template] spare build for ${repo.id} failed:`, e);
      return;
    }
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 5 * 60_000;

async function sweepWarmTemplates(): Promise<void> {
  for (const repo of Object.values(configuredRepos())) {
    if (repo.sharedCheckout) continue;
    const cfg = warmTemplateConfig(repo.id);
    if (!cfg.enabled) continue;
    const status = templateStatus(repo.id);
    // Age is a freshness policy, not a usability question, so the state file
    // owns it. Everything else (including ok-but-gutted, i.e. the template
    // deleted/recreated externally) comes from templateStatus, so a gutted
    // template refreshes now rather than serving cold seeds until the
    // interval elapses. A refresh already in flight is left alone.
    const refreshedAt = warmTemplateState(repo.id)?.refreshedAt;
    const ageMs = refreshedAt ? Date.now() - Date.parse(refreshedAt) : Infinity;
    const due =
      status.kind === "absent" ||
      status.kind === "stale" ||
      (status.kind === "warm" && ageMs > cfg.intervalHours * 3_600_000);
    if (due) {
      // Serialized: one template rebuild at a time.
      await refreshWarmTemplate(repo.id).catch((e) =>
        console.warn(
          `[warm-template] scheduled refresh of ${repo.id} failed:`,
          e,
        ),
      );
    }
    // Keep the spare pool topped up (cheap no-op when full) — this is also
    // what fills it after a process boot.
    void replenishSpares(repo).catch(() => {});
  }
}

/** Arm the sweep once per process (globalThis-parked, unref'd — never keeps
 *  a test/CLI process alive). Cheap no-op every tick while nothing is enabled.
 *  Called once from opensession.ts's boot block — never at module load: a due
 *  sweep rebuilds docker templates and replenishes spares, which is the live
 *  server's job, not that of every script that imports this graph. */
export function ensureWarmTemplateScheduler(): void {
  if (g.__warmTemplateSweepTimer) return;
  const t = setInterval(() => {
    sweepWarmTemplates().catch((e) =>
      console.warn("[warm-template] sweep failed:", e),
    );
  }, SWEEP_INTERVAL_MS);
  (t as { unref?: () => void }).unref?.();
  g.__warmTemplateSweepTimer = t;
}

// ── Status (Settings API) ────────────────────────────────────────────────────

export interface WarmTemplateStatusEntry {
  repoId: string;
  enabled: boolean;
  intervalHours: number;
  refreshing: boolean;
  /** Template verified usable right now (state + manifest + trees on disk).
   *  `state.ok` on its own can be true for a gutted template. */
  warm: boolean;
  /** Prebuilt dep spares ready for instant adoption. */
  spares: number;
  state: WarmTemplateState | null;
}

export function warmTemplateStatus(): WarmTemplateStatusEntry[] {
  return Object.values(configuredRepos())
    .filter((r) => !r.sharedCheckout)
    .map((r) => {
      const cfg = warmTemplateConfig(r.id);
      const status = templateStatus(r.id);
      return {
        repoId: r.id,
        enabled: cfg.enabled,
        intervalHours: cfg.intervalHours,
        refreshing: status.kind === "refreshing",
        warm: status.kind === "warm",
        spares: listSpares(r).length,
        state: warmTemplateState(r.id),
      };
    });
}
