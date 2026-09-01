/**
 * `opensession update` — pull upstream, reconcile, reinstall deps, deploy.
 *
 * Modelled on `openclaw update --channel`: one command that moves an install
 * forward and tells you what changed, rather than a documented sequence of git
 * incantations.
 *
 * Two checkout topologies (docs/self-development.md):
 *
 *  - origin-only: the checkout tracks one remote. Deliberately fast-forward
 *    only — a self-hosted install may carry local edits (that is half the
 *    point of shipping the source), and silently rebasing or resetting over
 *    them would be the worst possible failure mode. If the tree has diverged,
 *    update stops and says so.
 *  - fork: `origin` is the operator's own fork (self-development pushes land
 *    there) and a second remote points at the upstream project. Updates come
 *    FROM upstream and, once the instance has self-developed, can never
 *    fast-forward again — so here update performs an honest merge (a merge
 *    commit, never a rewrite; conflicts abort cleanly) and pushes the result
 *    back to the fork.
 *
 * The restart goes through deploy/self-deploy.sh when it can (service
 * installed + passwordless sudo): that buys the last-known-good pin, the
 * bootId-stable health gate, the watchdog window, and rollback posture —
 * with `--pin` set to the pre-update commit, since by then the merge has
 * already moved HEAD. Otherwise it falls back to a plain service restart.
 */

import { createHash } from "crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { ENV_PATH, OPENSESSION_HOME, REPO_ROOT } from "./paths";
import { readConfig } from "./config-edit";
import * as service from "./service";
import {
  bold,
  dim,
  fail,
  heading,
  info,
  ok,
  run,
  runInherit,
  warn,
} from "./ui";

export type UpdateOptions = {
  channel?: string;
  restart?: boolean;
  check?: boolean;
};

/** Where published releases are downloaded from (mirrors install.sh). */
const RELEASE_BASE =
  process.env.OPENSESSION_RELEASE_BASE ||
  "https://github.com/tellahq/opensession/releases/latest/download";

export function parseSha256Checksum(text: string): string | undefined {
  const expected = text.trim().split(/\s+/)[0]?.toLowerCase();
  return /^[0-9a-f]{64}$/.test(expected ?? "") ? expected : undefined;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface ReleaseManifest {
  version: string;
  commit?: string;
  os: string;
  arch: string;
}

/**
 * A release install, not a checkout: `release.json` at the root and a `src`
 * symlink into `releases/<name>`. Its update path is a download-and-swap, not
 * a git pull — there is no `.git`, and the tree is immutable by design.
 */
/**
 * The `src` symlink install swaps, which is not always `OPENSESSION_HOME/src`:
 * `install.sh --dir` puts it elsewhere. The shim at `OPENSESSION_HOME/bin/
 * opensession` always points at `<srcLink>/opensession`, so derive the real
 * location from it and only fall back to the default when the shim is absent.
 */
function releaseSrcLink(): string {
  try {
    const target = readlinkSync(join(OPENSESSION_HOME, "bin", "opensession"));
    const link = dirname(target);
    if (link && link !== ".") return link;
  } catch {}
  return join(OPENSESSION_HOME, "src");
}

function releaseInstall():
  | { manifest: ReleaseManifest; srcLink: string }
  | undefined {
  const manifestPath = join(REPO_ROOT, "release.json");
  const srcLink = releaseSrcLink();
  if (!existsSync(manifestPath)) return undefined;
  let isLink = false;
  try {
    isLink = lstatSync(srcLink).isSymbolicLink();
  } catch {}
  if (!isLink) return undefined;
  try {
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as ReleaseManifest;
    if (manifest.os && manifest.arch) return { manifest, srcLink };
  } catch {}
  return undefined;
}

/**
 * Update a release install: download the latest artefact for this OS/arch,
 * unpack it beside the current one, swap the `src` symlink atomically (rename
 * over a symlink is atomic on POSIX, so the running server never sees a
 * half-unpacked tree). The old release is kept for rollback. Restart is the
 * caller's, through the service.
 */
async function updateRelease(
  rel: { manifest: ReleaseManifest; srcLink: string },
  opts: UpdateOptions,
): Promise<number> {
  const url = opts.channel
    ? opts.channel
    : `${RELEASE_BASE}/opensession-${rel.manifest.os}-${rel.manifest.arch}.tar.gz`;
  info(dim(`current ${rel.manifest.version} (${rel.manifest.commit ?? "?"})`));
  info(dim(`fetching ${url} ...`));

  const tmp = mkdtempSync(join(tmpdir(), "opensession-update-"));
  const tarball = join(tmp, "release.tar.gz");
  const checksum = join(tmp, "release.tar.gz.sha256");
  try {
    if (
      (await run(["curl", "-fsSL", "--retry", "3", "-o", tarball, url]))
        .code !== 0
    ) {
      fail("could not download the release", url);
      return 1;
    }
    const configuredChecksum = process.env.OPENSESSION_ARTIFACT_SHA256;
    let expected = parseSha256Checksum(configuredChecksum ?? "");
    if (configuredChecksum && !expected) {
      fail(
        "OPENSESSION_ARTIFACT_SHA256 is invalid",
        "expected exactly 64 hexadecimal characters",
      );
      return 1;
    }
    if (!expected) {
      const checksumUrl = `${url}.sha256`;
      if (
        (
          await run([
            "curl",
            "-fsSL",
            "--retry",
            "3",
            "-o",
            checksum,
            checksumUrl,
          ])
        ).code !== 0
      ) {
        fail(
          "release downloaded but its SHA-256 checksum is unavailable",
          checksumUrl,
        );
        return 1;
      }
      expected = parseSha256Checksum(readFileSync(checksum, "utf8"));
      if (!expected) {
        fail("the release checksum is invalid", checksumUrl);
        return 1;
      }
    }
    const actual = sha256File(tarball);
    if (actual !== expected) {
      fail(
        "the release failed SHA-256 verification",
        `expected ${expected}, got ${actual}`,
      );
      return 1;
    }
    ok("verified release SHA-256", actual);

    // The tarball's single top dir is the release name. Take the first top
    // component that is not an AppleDouble sibling (`._name`, which a macOS
    // tar can emit as the first entry) or a dotfile.
    const listing = await run(["tar", "-tzf", tarball]);
    const relName =
      listing.stdout
        .split("\n")
        .map((l) => l.split("/")[0])
        .find((n) => n && !n.startsWith("._") && !n.startsWith(".")) ?? "";
    if (!relName) {
      fail("could not read the downloaded tarball");
      return 1;
    }

    const releasesDir = join(OPENSESSION_HOME, "releases");
    mkdirSync(releasesDir, { recursive: true });
    const dest = join(releasesDir, relName);
    const current = existsSync(rel.srcLink) ? realpathSync(rel.srcLink) : "";
    if (existsSync(dest) && realpathSync(dest) === current && current) {
      ok("already up to date", rel.manifest.version);
      return 0;
    }
    // A complete unpack has a release.json at its root; anything else (a dir
    // left behind by a tar that died partway, e.g. a full disk) is treated as
    // absent and redone. Extract into a sibling staging dir and rename the
    // unpacked tree into place only on success, so `dest` is never a partial
    // tree a later run would trust — the rename is atomic on one filesystem.
    if (existsSync(dest) && existsSync(join(dest, "release.json"))) {
      ok(`${relName} already unpacked`);
    } else {
      rmSync(dest, { recursive: true, force: true });
      const staging = join(releasesDir, `.incoming.${process.pid}`);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      try {
        if ((await run(["tar", "-xzf", tarball, "-C", staging])).code !== 0) {
          fail("could not unpack the release");
          return 1;
        }
        const unpacked = join(staging, relName);
        if (!existsSync(join(unpacked, "release.json"))) {
          fail("the unpacked release is missing release.json");
          return 1;
        }
        renameSync(unpacked, dest);
        ok(`unpacked ${relName}`);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }

    // Atomic swap: write the new link next to the target and rename over it,
    // so a reader either sees the old tree or the new one, never neither.
    const staging = join(dirname(rel.srcLink), `.src.next.${process.pid}`);
    try {
      rmSync(staging, { force: true });
    } catch {}
    symlinkSync(dest, staging);
    renameSync(staging, rel.srcLink);
    ok(
      `switched src -> releases/${relName}`,
      current ? `was ${current.split("/").pop()}` : undefined,
    );
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The upstream project this source came from. */
const UPSTREAM_URL_RE = /github\.com[/:]tellahq\/opensession(\.git)?$/;

export interface Remote {
  name: string;
  url: string;
}

/** Parse `git remote -v` output into unique fetch remotes. */
export function parseRemotes(remoteV: string): Remote[] {
  const seen = new Map<string, string>();
  for (const line of remoteV.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    if (m && !seen.has(m[1])) seen.set(m[1], m[2]);
  }
  return [...seen.entries()].map(([name, url]) => ({ name, url }));
}

export interface Topology {
  /** Remote updates are pulled from. */
  source: string;
  /** fork = merge allowed + push back to origin; origin = ff-only. */
  kind: "origin" | "fork";
}

/**
 * Where updates come from. Fork topology iff origin is NOT the upstream
 * project and some other remote is — then that remote is the source and a
 * merge is legitimate (the local commits are the operator's own fork history).
 * Everything else (origin-only clones, origin = upstream, no origin at all)
 * stays the conservative ff-only path against origin.
 */
export function classifyTopology(remotes: Remote[]): Topology {
  const origin = remotes.find((r) => r.name === "origin");
  const upstream = remotes.find(
    (r) => r.name !== "origin" && UPSTREAM_URL_RE.test(r.url),
  );
  if (origin && !UPSTREAM_URL_RE.test(origin.url) && upstream) {
    return { source: upstream.name, kind: "fork" };
  }
  return { source: "origin", kind: "origin" };
}

async function git(args: string[]) {
  return await run(["git", ...args], { cwd: REPO_ROOT });
}

/** Can this shell restart the service without prompting? (self-deploy.sh runs
 *  systemctl via `sudo -n`; a sudo password prompt inside it would just fail.) */
async function passwordlessRoot(): Promise<boolean> {
  if (process.getuid?.() === 0) return true;
  return (await run(["sudo", "-n", "true"])).code === 0;
}

export async function update(opts: UpdateOptions = {}): Promise<number> {
  heading("Update");

  // Release install (no .git, immutable tree): download-and-swap, then restart
  // through the same health-gated path as the source update below.
  const rel = releaseInstall();
  if (rel) {
    if (opts.check) {
      info(
        dim(
          `release install ${rel.manifest.version}; \`opensession update\` swaps to the latest artefact`,
        ),
      );
      return 0;
    }
    const prevTarget = existsSync(rel.srcLink) ? realpathSync(rel.srcLink) : "";
    const swapped = await updateRelease(rel, opts);
    if (swapped !== 0) return swapped;
    const newTarget = existsSync(rel.srcLink) ? realpathSync(rel.srcLink) : "";
    // updateRelease returns 0 both when it swapped and when already current;
    // only a real swap needs a restart, and only then is there a rollback target.
    if (!newTarget || newTarget === prevTarget) return 0;
    return await restartReleaseWithRollback(rel.srcLink, prevTarget, opts);
  }

  const { code: isRepo } = await git(["rev-parse", "--git-dir"]);
  if (isRepo !== 0) {
    fail("not a git checkout", REPO_ROOT);
    return 1;
  }

  // Refuse to move a dirty tree — the user's own edits are more valuable than
  // being current, and a failed merge here leaves a live server half-updated.
  const { stdout: dirty } = await git(["status", "--porcelain"]);
  if (dirty) {
    fail("working tree has uncommitted changes", "commit or stash them first");
    info(dim(dirty.split("\n").slice(0, 10).join("\n  ")));
    return 1;
  }

  const remotes = parseRemotes((await git(["remote", "-v"])).stdout ?? "");
  const topology = classifyTopology(remotes);
  if (topology.kind === "fork") {
    info(
      dim(
        `fork topology: updates from ${bold(topology.source)}, pushes to origin`,
      ),
    );
  }

  const branch =
    opts.channel ??
    (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout ??
    "main";
  const before = (await git(["rev-parse", "--short", "HEAD"])).stdout;
  const beforeFull = (await git(["rev-parse", "HEAD"])).stdout;

  info(dim(`fetching ${topology.source}/${branch} ...`));
  if ((await git(["fetch", "--quiet", topology.source, branch])).code !== 0) {
    fail(`could not fetch ${topology.source}/${branch}`);
    return 1;
  }

  const { stdout: counts } = await git([
    "rev-list",
    "--left-right",
    "--count",
    `HEAD...FETCH_HEAD`,
  ]);
  const [ahead = "0", behind = "0"] = counts.split(/\s+/);

  if (behind === "0") {
    ok(`already up to date`, `${branch} @ ${before}`);
    return 0;
  }

  info(`${behind} new commit(s) on ${bold(`${topology.source}/${branch}`)}`);
  const { stdout: log } = await git([
    "log",
    "--oneline",
    "--no-decorate",
    "-10",
    `HEAD..FETCH_HEAD`,
  ]);
  for (const line of log.split("\n").filter(Boolean)) info(dim(`  ${line}`));

  if (ahead !== "0" && topology.kind === "origin") {
    fail(
      `local branch has diverged (${ahead} ahead, ${behind} behind)`,
      "reconcile manually — update will not rewrite your history",
    );
    if (
      remotes.some((r) => r.name === "origin" && UPSTREAM_URL_RE.test(r.url))
    ) {
      info(
        dim(
          "  self-developing against the upstream clone? Fork it and point origin\n" +
            "  at the fork (docs/self-development.md) — update then merges for you.",
        ),
      );
    }
    return 1;
  }

  if (opts.check) {
    if (ahead !== "0")
      info(
        dim(`\n  ${ahead} local commit(s) — update will create a merge commit`),
      );
    info(dim("  --check given, stopping before applying"));
    return 0;
  }

  if (ahead === "0") {
    if ((await git(["merge", "--ff-only", "FETCH_HEAD"])).code !== 0) {
      fail("fast-forward failed", "reconcile manually");
      return 1;
    }
  } else {
    // Fork topology with local self-development commits: an honest merge
    // commit is the correct reconciliation (never a rebase/reset — this
    // checkout may be live). Conflicts abort back to the pre-merge tree.
    info(
      dim(
        `merging ${topology.source}/${branch} into ${branch} (${ahead} local commit(s))`,
      ),
    );
    const merge = await git([
      "merge",
      "--no-edit",
      "-m",
      `Merge ${topology.source}/${branch} (opensession update)`,
      "FETCH_HEAD",
    ]);
    if (merge.code !== 0) {
      await git(["merge", "--abort"]);
      fail(
        "merge conflicts with upstream",
        `resolve by hand: git merge ${topology.source}/${branch}`,
      );
      return 1;
    }
  }
  const after = (await git(["rev-parse", "--short", "HEAD"])).stdout;
  ok("updated", `${before} -> ${after}`);

  // Keep the fork current so session pushes and deploy_self (which
  // fast-forwards from origin) see the merged history.
  if (topology.kind === "fork") {
    if ((await git(["push", "origin", branch])).code === 0) {
      ok(`pushed ${branch} to origin`);
    } else {
      warn(
        "could not push to origin",
        `push by hand: git push origin ${branch}`,
      );
    }
  }

  heading("Dependencies");
  if ((await runInherit(["bun", "install"], REPO_ROOT)) !== 0) {
    fail("bun install failed");
    return 1;
  }
  ok("dependencies installed");

  return await restartAfterUpdate(opts, beforeFull);
}

/** The local origin the service should answer on, for the health gate. */
/** A single value from the service env file (~/.opensession.env). The systemd
 *  unit and the LaunchAgent load it, and the server reads HOST/PORT from it. */
function envFileValue(name: string): string | undefined {
  try {
    for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && m[1] === name) return m[2].trim();
    }
  } catch {}
  return undefined;
}

async function healthBaseUrl(): Promise<string> {
  const server = ((await readConfig())?.server ?? {}) as Record<
    string,
    unknown
  >;
  // The server takes HOST/PORT from the env file the service loads, ahead of
  // config, defaulting to 127.0.0.1:3850 (opensession.ts). Probe that same
  // endpoint; otherwise a healthy update whose env file overrides the port
  // fails the health check and rolls itself back every time.
  const host = envFileValue("HOST") || (server.host as string) || "127.0.0.1";
  const port = Number(envFileValue("PORT") || server.port) || 3850;
  // A wildcard bind address is not connectable; probe loopback instead.
  const probeHost = /^(0\.0\.0\.0|::|\[::\])$/.test(host) ? "127.0.0.1" : host;
  return `http://${probeHost}:${port}`;
}

/**
 * Restart a freshly swapped release install and verify it. A release has no
 * deploy/ and no pin, so `restartAfterUpdate` would restart and return success
 * even when the new binary crash-loops (systemd `Restart=always` masks it). The
 * old release is still on disk, so instead: restart, gate on /api/health, and
 * if the restart or the health check fails, repoint `src` back to the previous
 * release and restart it, then fail loudly rather than leave the box offline.
 */
async function restartReleaseWithRollback(
  srcLink: string,
  prevTarget: string,
  opts: UpdateOptions,
): Promise<number> {
  if (opts.restart === false) return 0;
  if (!(await service.isInstalled())) {
    warn(
      "no service installed",
      "restart your foreground server to pick this up",
    );
    return 0;
  }
  heading("Restart (health-gated)");
  const base = await healthBaseUrl();
  const executorRestarted = (await service.restartExecutor()) === 0;
  const restarted =
    executorRestarted && (await service.control("restart")) === 0;
  const healthy = restarted && (await service.waitHealthy(base));
  if (healthy) {
    ok("restarted and healthy");
    return 0;
  }
  if (!prevTarget) {
    fail(
      restarted ? "did not come back healthy" : "restart failed",
      "no previous release to roll back to",
    );
    return 1;
  }
  warn(
    restarted ? "the new release did not come back healthy" : "restart failed",
    `rolling back to ${prevTarget.split("/").pop()}`,
  );
  try {
    const staging = join(dirname(srcLink), `.src.rollback.${process.pid}`);
    try {
      rmSync(staging, { force: true });
    } catch {}
    symlinkSync(prevTarget, staging);
    renameSync(staging, srcLink); // atomic over the symlink
  } catch {
    fail(
      "rollback failed — repoint src by hand",
      `${srcLink} -> ${prevTarget}`,
    );
    return 1;
  }
  await service.restartExecutor();
  await service.control("restart");
  fail("rolled back to the previous release", "the new one did not come up");
  return 1;
}

/**
 * Backend changes never take effect without a real restart — the frontend
 * watcher only rebuilds the SPA. Prefer the health-gated deploy script (source
 * installs, which carry deploy/ and a pin commit): it pins the pre-update
 * commit as last-known-good, gates on a bootId-stable /api/health streak, and
 * opens the watchdog window. A release install has no pin and no deploy/, so it
 * takes the plain service restart — the previous release stays on disk for a
 * manual rollback (repoint src and restart).
 */
async function restartAfterUpdate(
  opts: UpdateOptions,
  pin: string | undefined,
): Promise<number> {
  if (opts.restart === false) return 0;
  const selfDeploy = join(REPO_ROOT, "deploy", "self-deploy.sh");
  if (
    pin &&
    (await service.isInstalled()) &&
    existsSync(selfDeploy) &&
    (await passwordlessRoot())
  ) {
    heading("Deploy (health-gated)");
    const code = await runInherit(
      [selfDeploy, "--sha", "HEAD", "--pin", pin],
      REPO_ROOT,
    );
    if (code === 0) {
      ok("restarted and healthy", `rollback pin ${pin.slice(0, 8)}`);
    } else {
      fail(
        "deploy did not come back healthy",
        "see ~/.opensession-deploy/last-result.json and self-deploy.log",
      );
      return 1;
    }
  } else if (await service.isInstalled()) {
    heading("Restart");
    if ((await service.control("restart")) === 0) ok("service restarted");
    else warn("restart failed — do it by hand");
  } else {
    warn(
      "no service installed",
      "restart your foreground server to pick this up",
    );
  }
  if (
    service.installedScope() === "system" &&
    !existsSync("/usr/local/libexec/opensession-run-host")
  ) {
    warn(
      "detached executor not installed",
      "run `opensession service install --system` once to install the fixed launch helper",
    );
  }

  return 0;
}
