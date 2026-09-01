/**
 * Simple-mode install harness (adrs/simple-mode.md, "Test harness").
 *
 * Drives a fresh Ubuntu VM through the install path and checks the box with
 * Goss. Steps run in order and each depends on the previous one:
 *
 *   build   → the release artefact for the guest's arch (scripts/build-release.ts)
 *             or, with SIMPLE_MODE_SOURCE=1, the branch as a git bundle
 *   vm      → limactl create/start from lima.yaml, work dir mounted read-only
 *   install → install.sh --artifact <tarball>, no flags (or --repo
 *             <bundle> for the source path), as the guest user
 *   service → require the installer's persistent user service to be active
 *   goss    → goss.yaml (today's bar); goss.dod.yaml with SIMPLE_MODE_STRICT=1
 *   reboot  → limactl stop/start, goss again (STRICT only: needs a service)
 *   uninstall → install.sh --uninstall, goss.uninstalled.yaml (STRICT only)
 *   destroy → unless SIMPLE_MODE_KEEP=1
 *
 * Environment:
 *   SIMPLE_MODE_TARGET   lima (default) | host   host = run every step on
 *                        this machine, no VM (a CI runner, a throwaway box)
 *   SIMPLE_MODE_VM       Lima instance name (default opensession-simple)
 *   SIMPLE_MODE_REUSE=1  do not recreate the VM if it exists
 *   SIMPLE_MODE_KEEP=1   leave the VM running at the end
 *   SIMPLE_MODE_STRICT=1 also run the definition-of-done assertions
 *   SIMPLE_MODE_NOSUDO=1 run install/start as the `nosudo` guest user (R1.1)
 *   SIMPLE_MODE_SOURCE=1 install from a git bundle of the branch (the
 *                        contributor path) instead of the release artefact
 *   OPENSESSION_TEST_CLAUDE_TOKEN  when set, add the account and run one turn
 *
 * Run: bun test ./test/simple-mode/harness.test.ts      (not part of `bun test`'s default set)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";

const HERE = dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = resolve(HERE, "..", "..");
const WORK = join(HERE, ".work");
const CACHE_HOME =
  process.env.XDG_CACHE_HOME || join(process.env.HOME || "~", ".cache");
/** Release build output; outside the repo on purpose (see build-release.ts). */
const RELEASE_OUT = join(CACHE_HOME, "opensession-release", "simple-mode");
const TARGET = process.env.SIMPLE_MODE_TARGET ?? "lima";
const VM = process.env.SIMPLE_MODE_VM ?? "opensession-simple";
const REUSE = process.env.SIMPLE_MODE_REUSE === "1";
const KEEP = process.env.SIMPLE_MODE_KEEP === "1";
const STRICT = process.env.SIMPLE_MODE_STRICT === "1";
const NOSUDO = process.env.SIMPLE_MODE_NOSUDO === "1";
const SOURCE = process.env.SIMPLE_MODE_SOURCE === "1";
const CLAUDE_TOKEN = process.env.OPENSESSION_TEST_CLAUDE_TOKEN;

const PORT = 3850;
const INGRESS_PORT = 3860;
const GUEST_MOUNT = "/mnt/simple-mode";
const MINUTES = 60_000;
const GOSS_VERSION = "v0.4.10";

/** Where the guest sees the work dir. On host it is the dir itself. */
const guestWork = TARGET === "host" ? WORK : GUEST_MOUNT;

type Run = { code: number; stdout: string; stderr: string };

/** Run a command on the host and capture it. */
async function host(cmd: string[], opts: { cwd?: string } = {}): Promise<Run> {
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  if (code !== 0 && !stdout && !stderr) {
    console.log(
      `[harness] ${cmd[0]} exited ${code} with no output (which=${Bun.which(cmd[0])})`,
    );
  }
  return { code, stdout, stderr };
}

/**
 * Run a shell command line in the target box as the test user. On lima this
 * is `limactl shell`; on host it is a login shell here. `bash -lc` so the
 * installer's PATH edits are picked up on the next call.
 */
async function guest(line: string, opts: { user?: string } = {}): Promise<Run> {
  const user = opts.user ?? (NOSUDO ? "nosudo" : undefined);
  if (TARGET === "host") {
    const cmd = user
      ? ["sudo", "-u", user, "-i", "bash", "-lc", line]
      : ["bash", "-lc", line];
    return host(cmd);
  }
  const cmd = user
    ? ["limactl", "shell", VM, "sudo", "-u", user, "-i", "bash", "-lc", line]
    : ["limactl", "shell", VM, "bash", "-lc", line];
  return host(cmd);
}

function expectOk(r: Run, what: string) {
  if (r.code !== 0) {
    throw new Error(
      `${what} failed (${r.code})\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`,
    );
  }
}

async function guestHome(): Promise<string> {
  const r = await guest('printf %s "$HOME"');
  expectOk(r, "resolve $HOME");
  return r.stdout.trim();
}

async function guestUser(): Promise<string> {
  const r = await guest("id -un");
  expectOk(r, "resolve user");
  return r.stdout.trim();
}

/** Copy a file into the guest home; on lima via the mounted work dir. */
async function putInGuest(name: string, content: string): Promise<string> {
  writeFileSync(join(WORK, name), content);
  return join(guestWork, name);
}

/** Run a goss file with vars; returns the TAP output. Throws on failure. */
async function goss(file: string): Promise<string> {
  const home = await guestHome();
  const user = await guestUser();
  const vars =
    `home: ${home}\nuser: ${user}\nport: ${PORT}\ningressPort: ${INGRESS_PORT}\n` +
    `source: ${SOURCE}\ntoken: ${CLAUDE_TOKEN ? "true" : ""}\n`;
  const varsPath = await putInGuest("vars.yaml", vars);
  const r = await guest(
    `~/.local/bin/goss -g ${join(guestWork, file)} --vars ${varsPath} validate --format tap`,
  );
  if (r.code !== 0) throw new Error(`goss ${file}:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

async function limaStatus(): Promise<string | null> {
  const r = await host(["limactl", "list", "--json"]);
  for (const l of r.stdout.split("\n")) {
    if (!l) continue;
    const j = JSON.parse(l) as { name: string; status: string };
    if (j.name === VM) return j.status;
  }
  return null;
}
const limaExists = async () => (await limaStatus()) !== null;

const bundlePath = join(WORK, "opensession.bundle");
let branch = "";
let tarballName = "";
let commandWasOnPath = false;

describe("simple mode install", () => {
  beforeAll(async () => {
    // Clear contents, keep the directory: on lima it is a virtiofs mount and
    // recreating it would leave the guest looking at the old inode.
    mkdirSync(WORK, { recursive: true });
    for (const f of readdirSync(WORK))
      rmSync(join(WORK, f), { recursive: true, force: true });
    mkdirSync(RELEASE_OUT, { recursive: true });
    for (const f of readdirSync(RELEASE_OUT).filter((f) =>
      f.endsWith(".tar.gz"),
    )) {
      rmSync(join(RELEASE_OUT, f), { force: true });
    }
  }, 2 * MINUTES);

  test(
    "build: the release artefact (or a source bundle) for the guest",
    async () => {
      await Bun.write(
        join(WORK, "install.sh"),
        Bun.file(join(REPO_ROOT, "install.sh")),
      );
      for (const f of ["goss.yaml", "goss.dod.yaml", "goss.uninstalled.yaml"]) {
        await Bun.write(join(WORK, f), Bun.file(join(HERE, f)));
      }
      if (SOURCE) {
        const b = await host(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: REPO_ROOT,
        });
        expectOk(b, "git rev-parse");
        // Detached HEAD: bundle HEAD alone and let the installer clone its
        // default; otherwise bundle the branch and pass it as --channel.
        branch = b.stdout.trim() === "HEAD" ? "" : b.stdout.trim();
        const r = await host(
          ["git", "bundle", "create", bundlePath, branch || "HEAD"],
          { cwd: REPO_ROOT },
        );
        expectOk(r, "git bundle create");
        expect(existsSync(bundlePath)).toBe(true);
        return;
      }
      // The artefact a customer downloads: built here for the guest's arch
      // (Lima runs the host's arch), then handed to the installer by path.
      const arch =
        TARGET === "host"
          ? process.arch
          : process.arch === "arm64"
            ? "arm64"
            : "x64";
      const os =
        TARGET === "host" && process.platform === "darwin" ? "darwin" : "linux";
      // Built outside the repo tree (see build-release.ts on why), then only
      // the tarball is copied into the mounted work dir.
      const r = await host(
        [
          "bun",
          "scripts/build-compile.ts",
          "--os",
          os,
          "--arch",
          arch,
          "--out",
          RELEASE_OUT,
        ],
        { cwd: REPO_ROOT },
      );
      expectOk(r, "build-compile");
      const tarballs = readdirSync(RELEASE_OUT).filter((f) =>
        f.endsWith(".tar.gz"),
      );
      if (tarballs.length !== 1)
        throw new Error(
          `expected one tarball in ${RELEASE_OUT}, found ${tarballs.join(", ") || "none"}`,
        );
      tarballName = tarballs[0];
      copyFileSync(join(RELEASE_OUT, tarballName), join(WORK, tarballName));
      console.log(
        `artefact ${tarballName} (${(statSync(join(WORK, tarballName)).size / 1e6).toFixed(0)} MB)`,
      );
    },
    20 * MINUTES,
  );

  test(
    "vm: fresh Ubuntu via Lima",
    async () => {
      if (TARGET === "host") return;
      if ((await limaExists()) && !REUSE) {
        expectOk(
          await host(["limactl", "delete", "--force", VM]),
          "limactl delete",
        );
      }
      if (!(await limaExists())) {
        const r = await host([
          "limactl",
          "start",
          "--name",
          VM,
          "--tty=false",
          "--set",
          `.mounts[0].location = "${WORK}"`,
          join(HERE, "lima.yaml"),
        ]);
        expectOk(r, "limactl start");
      } else if ((await limaStatus()) !== "Running") {
        expectOk(
          await host(["limactl", "start", VM]),
          "limactl start (existing)",
        );
      }
      const probe = await guest(`test -f ${guestWork}/install.sh`);
      expectOk(probe, "work dir mounted in guest");
    },
    15 * MINUTES,
  );

  test(
    "goss: present in the guest",
    async () => {
      // Goss is the assertion runner; it is test tooling, not part of the
      // install under test, so it goes to ~/.local/bin of the test user only.
      // The binary is fetched once into the host cache and handed over through
      // the work dir: GitHub rate-limits repeated release downloads (429), and
      // that must not fail a run.
      const gossArch = process.arch === "arm64" ? "arm64" : "x86_64";
      const gossOs = TARGET === "host" ? process.platform : "linux";
      const ver = GOSS_VERSION.replace(/^v/, "");
      const cached = join(
        RELEASE_OUT,
        "..",
        `goss-${ver}-${gossOs}-${gossArch}`,
      );
      if (!existsSync(cached)) {
        const url = `https://github.com/goss-org/goss/releases/download/${GOSS_VERSION}/goss_${ver}_${gossOs}_${gossArch}.tar.gz`;
        const tgz = `${cached}.tar.gz`;
        const dl = await host([
          "curl",
          "-fsSL",
          "--retry",
          "5",
          "--retry-delay",
          "10",
          "--retry-all-errors",
          "-o",
          tgz,
          url,
        ]);
        expectOk(dl, `download ${url}`);
        const un = await host([
          "tar",
          "-xzf",
          tgz,
          "-C",
          dirname(cached),
          "goss",
        ]);
        expectOk(un, "untar goss");
        renameSync(join(dirname(cached), "goss"), cached);
      }
      await Bun.write(join(WORK, "goss"), Bun.file(cached));
      const r = await guest(
        `mkdir -p ~/.local/bin && cp ${guestWork}/goss ~/.local/bin/goss && chmod +x ~/.local/bin/goss && ~/.local/bin/goss --version`,
      );
      expectOk(r, "install goss");
    },
    3 * MINUTES,
  );

  test(
    "install: install.sh from the bundle, non-interactive",
    async () => {
      commandWasOnPath = (await guest("command -v opensession")).code === 0;
      // No flags (DoD 1): defaults-only onboarding, no Tailscale, the
      // installer's own service. `--advanced` is the operator path.
      const source = SOURCE
        ? `--repo ${guestWork}/opensession.bundle ${branch ? `--channel ${branch} ` : ""}`
        : `--artifact ${guestWork}/${tarballName} `;
      // A test token rides the installer's env, the way an unattended install
      // would pass it; the server imports it at first start.
      const tokenEnv = CLAUDE_TOKEN
        ? `OPENSESSION_CLAUDE_TOKEN=${JSON.stringify(CLAUDE_TOKEN)} `
        : "";
      const r = await guest(
        `${tokenEnv}bash ${guestWork}/install.sh ${source}2>&1 | tee ~/install.log; ` +
          `exit \${PIPESTATUS[0]}`,
      );
      expectOk(r, "install.sh");
      const installedAt = r.stdout.lastIndexOf("Installed");
      const startedAt = r.stdout.lastIndexOf("Started");
      const urlAt = r.stdout.lastIndexOf(
        `Open Session is running at http://127.0.0.1:${PORT}`,
      );
      expect(installedAt).toBeGreaterThanOrEqual(0);
      expect(startedAt).toBeGreaterThan(installedAt);
      expect(urlAt).toBeGreaterThan(startedAt);
      if (!commandWasOnPath) {
        expect(r.stdout).toContain(
          "To use opensession in this shell, run:\n    source ~/.bashrc",
        );
      }
    },
    30 * MINUTES,
  );

  test(
    "service: the installer's user service is active",
    async () => {
      // A successful install means the persistent service is active. Do not hide
      // an installer regression behind a transient foreground fallback: that
      // would pass health checks but stop Open Session at logout or reboot.
      const own = await guest(
        `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active opensession`,
      );
      if (own.stdout.trim() !== "active") {
        const log = await guest(
          "XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u opensession --no-pager | tail -40; " +
            "loginctl show-user $(id -un) -p Linger --value",
        );
        throw new Error(
          `installer's service is not active (${own.stdout || own.stderr})\n${log.stdout}`,
        );
      }
      console.log("installer's user service is active");
      // Wait for health.
      const deadline = Date.now() + 3 * MINUTES;
      let last = "";
      while (Date.now() < deadline) {
        const h = await guest(`curl -fsS http://127.0.0.1:${PORT}/api/health`);
        if (h.code === 0 && h.stdout.includes('"ok"')) return;
        last = h.stdout + h.stderr;
        await Bun.sleep(3000);
      }
      const log = await guest(
        "XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u opensession -u opensession-harness --no-pager | tail -60",
      );
      throw new Error(`server never became healthy: ${last}\n${log.stdout}`);
    },
    5 * MINUTES,
  );

  test(
    "goss: today's bar",
    async () => {
      const tap = await goss("goss.yaml");
      console.log(tap);
    },
    2 * MINUTES,
  );

  test(
    "session: the default repo yields a worktree",
    async () => {
      // Between "health ok" and "a turn ran": create a code session on the
      // default repo and require that session setup reaches a checked-out
      // worktree. Catches a default repo that is not a git repository (a
      // release install registering its own release dir, for instance) with
      // no model account needed; the run itself may still fail for lack of
      // one, and that is fine here. Pi is bundled into the binary, so there is
      // no engine cold-start seed to verify.
      const create = await guest(
        `curl -fsS -X POST http://127.0.0.1:${PORT}/api/sessions ` +
          `-H 'content-type: application/json' ` +
          `-d '{"prompt":"harness: worktree check","mode":"code","branch":"harness-worktree-check"}'`,
      );
      expectOk(create, "create session");
      const id = (JSON.parse(create.stdout) as { id?: string }).id;
      if (!id) throw new Error(`no session id in ${create.stdout}`);
      const deadline = Date.now() + 2 * MINUTES;
      let last = "";
      while (Date.now() < deadline) {
        const r = await guest(
          `curl -fsS http://127.0.0.1:${PORT}/api/sessions/${id}`,
        );
        const s =
          r.code === 0
            ? (JSON.parse(r.stdout) as {
                worktreeDir?: string;
                lastRunError?: { message?: string };
              })
            : {};
        const err = s.lastRunError?.message ?? "";
        if (/Session setup failed/i.test(err))
          throw new Error(`session setup failed: ${err}`);
        if (s.worktreeDir) {
          const wt = await guest(
            `test -e ${JSON.stringify(s.worktreeDir)}/.git`,
          );
          if (wt.code === 0) {
            return;
          }
        }
        last = r.stdout;
        await Bun.sleep(3000);
      }
      throw new Error(`no worktree after 2 minutes: ${last}`);
    },
    5 * MINUTES,
  );

  test(
    "turn: one real agent turn (needs OPENSESSION_TEST_CLAUDE_TOKEN)",
    async () => {
      if (!CLAUDE_TOKEN) {
        console.log("skipped: OPENSESSION_TEST_CLAUDE_TOKEN not set");
        return;
      }
      // The token went in through the installer (R2.5); the server must have
      // imported it at boot, and the token file must be gone.
      const status = await guest(
        `curl -fsS http://127.0.0.1:${PORT}/api/setup/status`,
      );
      expectOk(status, "engine status");
      const st =
        (
          JSON.parse(status.stdout) as {
            engine?: {
              ready?: boolean;
              claudeAccounts?: number;
              blocker?: string;
            };
          }
        ).engine ?? {};
      if (!st.ready)
        throw new Error(
          `engine not ready after token import: ${st.blocker} (accounts=${st.claudeAccounts})`,
        );
      expectOk(
        await guest("test ! -e ~/.opensession-claude-token"),
        "token file removed after import",
      );
      // DoD 5: a real turn completes. The proof is an assistant entry in the
      // transcript; a finished session carries no runState field at all, and a
      // short turn can finish between two polls, so state alone is not enough.
      const t0 = Date.now();
      const create = await guest(
        `curl -fsS -X POST http://127.0.0.1:${PORT}/api/sessions ` +
          `-H 'content-type: application/json' ` +
          `-d '{"prompt":"Reply with exactly the word READY and nothing else. Do not use any tools.","mode":"code","branch":"harness-first-turn"}'`,
      );
      expectOk(create, "create session");
      const id = (JSON.parse(create.stdout) as { id?: string }).id!;
      const deadline = Date.now() + 8 * MINUTES;
      let last = "";
      while (Date.now() < deadline) {
        const r = await guest(
          `curl -fsS http://127.0.0.1:${PORT}/api/sessions/${id}`,
        );
        const s =
          r.code === 0
            ? (JSON.parse(r.stdout) as {
                runState?: string;
                lastRunError?: { message?: string };
              })
            : {};
        if (s.lastRunError?.message)
          throw new Error(`turn failed: ${s.lastRunError.message}`);
        if (s.runState === "failed")
          throw new Error(`turn failed: ${r.stdout}`);
        const t = await guest(
          `curl -fsS http://127.0.0.1:${PORT}/api/sessions/${id}/transcript`,
        );
        const entries =
          t.code === 0
            ? (JSON.parse(t.stdout) as { type?: string; content?: string }[])
            : [];
        const reply = entries.find(
          (e) => e.type === "assistant" && (e.content ?? "").trim(),
        );
        if (reply) {
          console.log(
            `first turn completed in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${JSON.stringify((reply.content ?? "").slice(0, 80))}`,
          );
          return;
        }
        last = r.stdout;
        await Bun.sleep(3000);
      }
      throw new Error(`turn did not complete in 8 minutes: ${last}`);
    },
    10 * MINUTES,
  );

  test(
    "goss: definition of done (STRICT)",
    async () => {
      if (!STRICT) {
        console.log("skipped: SIMPLE_MODE_STRICT not set");
        return;
      }
      console.log(await goss("goss.dod.yaml"));
    },
    2 * MINUTES,
  );

  test(
    "reboot: comes back on its own (STRICT, lima)",
    async () => {
      if (!STRICT || TARGET === "host") {
        console.log("skipped: needs SIMPLE_MODE_STRICT=1 and the lima target");
        return;
      }
      expectOk(await host(["limactl", "stop", VM]), "limactl stop");
      expectOk(await host(["limactl", "start", VM]), "limactl start");
      const deadline = Date.now() + 3 * MINUTES;
      while (Date.now() < deadline) {
        const h = await guest(`curl -fsS http://127.0.0.1:${PORT}/api/health`);
        if (h.code === 0) break;
        await Bun.sleep(3000);
      }
      console.log(await goss("goss.dod.yaml"));
    },
    10 * MINUTES,
  );

  test(
    "uninstall: committed scratch work blocks removal (STRICT)",
    async () => {
      if (!STRICT) {
        console.log("skipped: SIMPLE_MODE_STRICT not set");
        return;
      }
      // A code session can commit to a scratch worktree that has no remote; that
      // commit is the only copy, so uninstall must refuse to delete the home and
      // name it (install.sh worktree guard). Create such a commit, run
      // --uninstall --yes, and require the home to survive; then clean it so the
      // real uninstall test below can assert a clean removal.
      const wtProbe = await guest(
        `g=$(find ~/.opensession/worktrees -maxdepth 4 -name .git | head -1); dirname "$g"`,
      );
      const wt = wtProbe.stdout.trim();
      if (wt) {
        await guest(
          `cd ${JSON.stringify(wt)} && echo committed > NEWFILE.txt && ` +
            `git add NEWFILE.txt && git -c user.email=h@h -c user.name=h commit -q -m "scratch work"`,
        );
        const r = await guest(`bash ${guestWork}/install.sh --uninstall --yes`);
        expectOk(r, "uninstall with committed scratch work");
        const kept = await guest("test -d ~/.opensession && echo KEPT");
        if (kept.stdout.trim() !== "KEPT") {
          throw new Error(
            "uninstall deleted ~/.opensession despite committed scratch work",
          );
        }
        expect(r.stdout).toMatch(/unpushed commits|unsaved work/);
        // Clean it so the clean-removal case below is deterministic.
        await guest(`rm -rf ${JSON.stringify(wt)}`);
      }
    },
    5 * MINUTES,
  );

  test(
    "uninstall: leaves nothing but repos (STRICT)",
    async () => {
      if (!STRICT) {
        // Today's uninstall keeps the checkout and config on purpose; only the
        // shim is guaranteed gone.
        const r = await guest(`bash ${guestWork}/install.sh --uninstall --yes`);
        expectOk(r, "install.sh --uninstall");
        const shim = await guest("test ! -e ~/.opensession/bin");
        expectOk(shim, "shim removed");
        return;
      }
      const r = await guest(`bash ${guestWork}/install.sh --uninstall --yes`);
      expectOk(r, "install.sh --uninstall");
      console.log(await goss("goss.uninstalled.yaml"));
    },
    5 * MINUTES,
  );

  afterAll(async () => {
    if (TARGET === "host") return;
    if (KEEP) {
      console.log(`kept VM ${VM}: limactl shell ${VM}`);
      return;
    }
    await host(["limactl", "delete", "--force", VM]);
  });
});
