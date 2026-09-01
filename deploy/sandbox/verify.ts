/**
 * Docker sandbox verification suite — run MANUALLY:
 *
 *   bun run deploy/sandbox/verify.ts
 *
 * BIND section: exercises the DockerProvider end-to-end against a
 * scratch git repo + worktree (never a real session, never a real worktree):
 * container ensure/reuse, git status+commit THROUGH the bind-mounted worktree
 * + common .git, exec, RPC-socket reachability, the claude CLI, and — when
 * the account pool is available — a minimal real agent run through launchRun
 * (cheapest Claude model, "reply with OK", hard timeout). Degrades to a
 * dry-run notice when no account token exists.
 *
 * VOLUME section: a second sbxtest session materializes a
 * volume-only workspace (cloned in-container from a scratch LOCAL BARE repo —
 * no real GitHub repo involved), then drives the exec-routed surfaces
 * (workspaceExecFor → searchRepoEntries/getSessionDiff/getGitStatus), the
 * preview port publishing (in-container Bun.serve reached through the
 * published loopback port), the stopped-container host-exec fallback, and
 * the destroy-removes-the-workspace-volume contract.
 *
 * SNAPSHOTS section: a fourth sbxtest session (bind mode, snapshots enabled
 * in the scratch config) runs `.agents/setup` to write state into the
 * CONTAINER LAYER, is
 * idle-snapshotted by the real sweep (scoped to itself — the scratch config
 * must never touch live sandboxes), has its container removed, and is then
 * ensure()d again: the new container must come FROM the snapshot image
 * (marker present) with the bind-mounted workspace still correct. Also
 * checks maxPerSession pruning and that destroy() removes the images.
 *
 * WS-TRANSPORT section: a third sbxtest session runs with
 * `transport: "ws"` — the in-container run host DIALS BACK to a scratch WS
 * server in this process (the same run-ws module opensession.ts wires) instead
 * of serving a unix socket, and the rpc socket isn't mounted at all. Checks:
 * upgrade auth (bad token → 403; plain run-rpc tokens refused), a real agent
 * run streaming over WS (only when the socket-mode run above ran — same
 * account gating), steer delivery + cancel over WS, and the in-container
 * rpc-ws bridge via the hostId+wsToken handshake.
 *
 * PREVIEW + LIFECYCLE section: a fifth sbxtest session exercises
 * the sandboxed Preview flow end-to-end — `.agents/setup` one-shot,
 * `.agents/start.sh` bring-up on a port allocated from the pre-published
 * range, the namespaced Caddy https route (live Caddy admin; asserted
 * collision-free against the host webapp+6000 scheme AND a second sandbox on
 * the same webapp port), the `.tunnels.env` contract, stop/route teardown,
 * published-range exhaustion refusal, and destroy releasing the allocations.
 *
 * TERMINAL section: the sandbox-aware Shell tab PTY (src/server/terminals.ts)
 * — docker exec shell inside the container (workspace cwd), wake-on-demand of
 * a stopped container, host-shell fallback for a gone sandbox, and (with
 * daytona credentials) a live SSH-gateway shell into a bare daytona sandbox.
 *
 * Everything is sbxtest-prefixed and cleaned up at the end. Safe to run next
 * to the live server: the run journal AND the sandbox config are redirected
 * to the scratch dir BEFORE any module import, so nothing here can leak into
 * ~/.opensession-sessions/active-runs.json or flip the live sandbox config.
 */

const SCRATCH = `${process.env.HOME || homedir()}/.sandbox-verify-scratch`;
// MUST happen before importing any src/server module — claude-runner resolves
// the journal path at module load, and sandbox/config.ts resolves its config
// PATH at module load. The scratch config (written below) turns on the docker
// provider + volume workspace mode + a preview port WITHOUT touching the live
// ~/.opensession-sandbox.json.
process.env.OPENSESSION_RUN_JOURNAL = `${SCRATCH}/active-runs.json`;
process.env.OPENSESSION_SANDBOX_CONFIG = `${SCRATCH}/sandbox-config.json`;
// The repo registry is config-driven now (REPOS is a read-only Proxy over
// configuredRepos() — see worktree.ts/config.ts): the scratch sbxtest repo is
// registered through a scratch ~/.opensession/config.json, written below. The
// live box has no config.json, so this only ADDS the scratch repo over the
// built-in defaults.
process.env.OPENSESSION_CONFIG = `${SCRATCH}/opensession-config.json`;
// Keep the verifier's isolated checkout under its private worktree root so
// repoForPath recognizes it as an owned worktree without registering that
// checkout itself as a shared mainline.
process.env.OPENSESSION_WORKTREES_DIR = `${SCRATCH}/worktrees`;

import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";

const {
  DockerProvider,
  containerNameFor,
  snapshotRepoForSandbox,
  snapshotSandboxImage,
  sweepIdleSandboxes,
} =
  await import("../../packages/core/opensession-server/src/server/sandbox/docker");
const { workspaceExecFor } =
  await import("../../packages/core/opensession-server/src/server/sandbox/workspace-exec");
const { searchRepoEntries } =
  await import("../../packages/core/opensession-server/src/server/file-index");
const { getSessionDiff } =
  await import("../../packages/core/opensession-server/src/server/git-diff");
const { getGitStatus } =
  await import("../../packages/core/opensession-server/src/server/git-status");
const { worktreePathFor } =
  await import("../../packages/core/opensession-server/src/server/worktree");
const { rpcSocketPath } =
  await import("../../packages/core/opensession-server/src/runner-host/protocol");
const { OPENSESSION_SESSIONS_DIR } =
  await import("../../packages/core/opensession-server/src/server/paths");
const { statePath } =
  await import("../../packages/core/opensession-server/src/server/paths");
type RunHostSpec =
  import("../../packages/core/opensession-server/src/runner-host/protocol").RunHostSpec;

const SESSION_ID = `sbxtest-${Date.now().toString(36)}`;
const CONTAINER = containerNameFor(SESSION_ID);
const MAIN = `${SCRATCH}/main-repo`;
const WT = `${SCRATCH}/worktrees/sbxtest-sbxtest-branch`;
const BARE = `${SCRATCH}/origin.git`;

// Volume-mode section resources (own session/container; also sbxtest-*).
const VOL_SESSION_ID = `sbxtest-vol-${Date.now().toString(36)}`;
const VOL_CONTAINER = containerNameFor(VOL_SESSION_ID);
const VOL_BRANCH = "sbxtest-vol-branch";
const PREVIEW_PORT = 18734;

// WS-transport section resources (own session/container; also sbxtest-*).
const WS_SESSION_ID = `sbxtest-wst-${Date.now().toString(36)}`;
const WS_CONTAINER = containerNameFor(WS_SESSION_ID);

// Snapshots section resources (own session/container; also sbxtest-*).
const SNAP_SESSION_ID = `sbxtest-snap-${Date.now().toString(36)}`;
const SNAP_CONTAINER = containerNameFor(SNAP_SESSION_ID);

// Preview/lifecycle section resources (own session/container; also sbxtest-*).
// Container-internal webapp-range ports; published to random loopback host
// ports at create, so nothing here can collide with real host dev servers.
const PRE_SESSION_ID = `sbxtest-pre-${Date.now().toString(36)}`;
const PRE_CONTAINER = containerNameFor(PRE_SESSION_ID);
const PRE_PORTS = [3311, 3312, 3313];
const COLLISION_SBX_ID = "bks-sbx-sbxtest-collision-probe";

// Scratch sandbox config: docker provider, volume workspaces, one preview
// port. Read fresh per call by sandbox/config.ts via the env override above.
mkdirSync(SCRATCH, { recursive: true });
await Bun.write(
  process.env.OPENSESSION_SANDBOX_CONFIG!,
  JSON.stringify({
    provider: "docker",
    workspace: "volume",
    previewPorts: [PREVIEW_PORT],
  }),
);

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function sh(
  cmd: string[],
  cwd?: string,
): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}

async function cleanup(): Promise<void> {
  console.log("\n── cleanup ──");
  // Preview https-port allocations + Caddy routes (live chats dir + live
  // Caddy admin — must not leak sbxtest entries into either).
  try {
    const { dropSandboxPreviewRoutes } =
      await import("../../packages/core/opensession-server/src/server/preview");
    for (const id of [
      CONTAINER,
      VOL_CONTAINER,
      WS_CONTAINER,
      SNAP_CONTAINER,
      PRE_CONTAINER,
      COLLISION_SBX_ID,
    ]) {
      await dropSandboxPreviewRoutes(id);
    }
  } catch {}
  for (const [container, session] of [
    [CONTAINER, SESSION_ID],
    [VOL_CONTAINER, VOL_SESSION_ID],
    [WS_CONTAINER, WS_SESSION_ID],
    [SNAP_CONTAINER, SNAP_SESSION_ID],
    [PRE_CONTAINER, PRE_SESSION_ID],
  ]) {
    await sh(["docker", "rm", "-f", container]);
    await sh([
      "docker",
      "volume",
      "rm",
      "-f",
      `${container}-claude`,
      `${container}-codex`,
      `${container}-ws`,
    ]);
    // Snapshot images (rm -f by id drops every tag of the repo at once).
    const imgIds = (
      await sh([
        "docker",
        "image",
        "ls",
        snapshotRepoForSandbox(container),
        "-q",
      ])
    ).out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of new Set(imgIds)) await sh(["docker", "rmi", "-f", id]);
    try {
      rmSync(`${OPENSESSION_SESSIONS_DIR}/sandboxes/${container}.json`, {
        force: true,
      });
      rmSync(`${OPENSESSION_SESSIONS_DIR}/sandbox-runs/${session}`, {
        recursive: true,
        force: true,
      });
    } catch {}
  }
  // Transcript dirs the container-create mkdir'd for the scratch cwds.
  for (const dir of [WT, VOL_CWD]) {
    const munged = `-${dir.replaceAll("/", "-").replace(/^-/, "")}`;
    try {
      rmSync(`${process.env.HOME}/.claude/projects/${munged}`, {
        recursive: true,
        force: true,
      });
    } catch {}
  }
  rmSync(SCRATCH, { recursive: true, force: true });
  console.log("  removed containers, volumes, state, scratch");
}

// ── scratch repo + worktree ───────────────────────────────────────────────────
console.log("── setup: scratch repo + worktree ──");
// Selective clean (NOT rmSync(SCRATCH) — the sandbox config written above
// lives there); cleanup() removes the whole scratch dir at the end.
for (const p of [MAIN, WT, BARE]) rmSync(p, { recursive: true, force: true });
mkdirSync(MAIN, { recursive: true });
for (const c of [
  ["git", "init", "-q", "-b", "main"],
  ["git", "config", "user.email", "sbxtest@opensession.local"],
  ["git", "config", "user.name", "Sandbox Verify"],
])
  await sh(c, MAIN);
await Bun.write(`${MAIN}/README.md`, "sandbox verify scratch repo\n");
await sh(["git", "add", "README.md"], MAIN);
await sh(["git", "commit", "-q", "-m", "init"], MAIN);
const wtAdd = await sh(
  ["git", "worktree", "add", "-q", WT, "-b", "sbxtest-branch"],
  MAIN,
);
ok(
  "scratch worktree created",
  wtAdd.code === 0 && existsSync(`${WT}/.git`),
  WT,
);

// Local BARE origin for the volume-mode section: the in-container clone
// source (a local-path origin gets mounted ro by the provider — real repos
// clone over ssh/https instead). MAIN's `origin` remote points at it so
// repoOriginUrl resolves it.
await sh(["git", "clone", "-q", "--bare", MAIN, BARE]);
await sh(["git", "remote", "add", "origin", BARE], MAIN);
// Register the scratch repo through the config-driven registry (OPENSESSION_CONFIG
// points at this scratch file) so getRepo/worktreePathFor/repoOriginUrl can
// resolve clone source + default branch. sbxtest-only, scratch-dir-only.
await Bun.write(
  process.env.OPENSESSION_CONFIG!,
  JSON.stringify({
    repos: {
      sbxtest: {
        repo: MAIN,
        wtPrefix: "sbxtest",
        defaultBranch: "main",
        ghRepo: "sbxtest/sbxtest",
      },
    },
  }),
);
const VOL_CWD = worktreePathFor(VOL_BRANCH, "sbxtest", { isolated: true });

const provider = new DockerProvider();

try {
  // ── ensure / reuse ──────────────────────────────────────────────────────────
  console.log("\n── ensure ──");
  const t0 = Date.now();
  const sandbox = await provider.ensure({ sessionId: SESSION_ID, cwd: WT });
  ok(
    "ensure() created + started container",
    sandbox.id === CONTAINER,
    `${sandbox.id} in ${Date.now() - t0}ms`,
  );
  ok("status() is running", (await sandbox.status()) === "running");

  const t1 = Date.now();
  const again = await provider.ensure({ sessionId: SESSION_ID, cwd: WT });
  ok(
    "ensure() is idempotent (reuse)",
    again.id === sandbox.id && Date.now() - t1 < 5000,
    `${Date.now() - t1}ms`,
  );

  const inspect = await sh([
    "docker",
    "inspect",
    "-f",
    '{{index .Config.Labels "opensession.session"}} cpus={{.HostConfig.NanoCpus}} mem={{.HostConfig.Memory}} init={{.HostConfig.Init}}',
    CONTAINER,
  ]);
  ok(
    "labels + limits + --init applied",
    inspect.out.includes(SESSION_ID) && inspect.out.includes("init=true"),
    inspect.out.trim(),
  );
  const homeMounts = await sh([
    "docker",
    "inspect",
    "-f",
    "{{range .Mounts}}{{.Destination}}\n{{end}}",
    CONTAINER,
  ]);
  ok(
    "no volume shadows /home/ubuntu",
    !homeMounts.out.split("\n").includes("/home/ubuntu"),
    "mounts: " + homeMounts.out.trim().split("\n").join(", "),
  );

  // ── exec + toolchain ────────────────────────────────────────────────────────
  console.log("\n── exec / toolchain ──");
  const whoami = await sandbox.exec(["id", "-u"]);
  ok(
    "exec runs as uid 1000",
    whoami.exitCode === 0 && whoami.stdout.trim() === "1000",
    whoami.stdout.trim(),
  );
  const claudeVer = await sandbox.exec([
    "/home/ubuntu/.local/bin/claude",
    "--version",
  ]);
  ok(
    "claude CLI runs in-container",
    claudeVer.exitCode === 0,
    claudeVer.stdout.trim() || claudeVer.stderr.trim(),
  );
  const bunVer = await sandbox.exec(["bun", "--version"]);
  ok("bun runs in-container", bunVer.exitCode === 0, bunVer.stdout.trim());
  const settings = await sandbox.exec([
    "cat",
    "/home/ubuntu/.claude/settings.json",
  ]);
  ok(
    "~/.claude/settings.json seeded in volume",
    settings.exitCode === 0 && settings.stdout.trim().length > 0,
    settings.stdout.trim(),
  );

  // ── git through the mounts ──────────────────────────────────────────────────
  console.log("\n── git inside the sandbox ──");
  const status = await sandbox.exec(["git", "status", "--porcelain"]);
  ok(
    "git status works (worktree + common .git mounts)",
    status.exitCode === 0,
    status.stderr.trim(),
  );
  await sandbox.exec(["sh", "-c", "echo sandbox-was-here > sandbox-file.txt"]);
  await sandbox.exec(["git", "add", "sandbox-file.txt"]);
  const commit = await sandbox.exec([
    "git",
    "-c",
    "user.email=sbxtest@opensession.local",
    "-c",
    "user.name=Sandbox Verify",
    "commit",
    "-q",
    "-m",
    "commit from inside the sandbox",
  ]);
  ok(
    "git commit inside container",
    commit.exitCode === 0,
    commit.stderr.trim(),
  );
  const hostLog = await sh(["git", "log", "--oneline", "-1"], WT);
  ok(
    "commit visible host-side",
    hostLog.out.includes("commit from inside the sandbox"),
    hostLog.out.trim(),
  );

  // ── IMDS block ──────────────────────────────────────────────────────────────
  console.log("\n── network ──");
  const imds = await sandbox.exec([
    "sh",
    "-c",
    "curl -s -m 3 -o /dev/null -w '%{http_code}' http://169.254.169.254/latest/meta-data/ || echo blocked",
  ]);
  ok(
    "IMDS unreachable from container",
    imds.stdout.includes("blocked") || imds.stdout.trim() === "000",
    imds.stdout.trim(),
  );

  // ── RPC socket ──────────────────────────────────────────────────────────────
  console.log("\n── rpc socket ──");
  const sock = rpcSocketPath(OPENSESSION_SESSIONS_DIR);
  const sockLs = await sandbox.exec(["ls", sock]);
  ok("rpc socket mounted", sockLs.exitCode === 0, sock);
  const sockProbe = await sandbox.exec([
    "bun",
    "-e",
    `const r = await fetch("http://opensession/mcp/list", {method:"POST", unix:"${sock}", headers:{"content-type":"application/json"}, body:"{}"}); console.log("HTTP", r.status);`,
  ]);
  ok(
    "rpc socket answers from inside",
    sockProbe.exitCode === 0 && sockProbe.stdout.includes("HTTP"),
    (sockProbe.stdout || sockProbe.stderr).trim().slice(0, 120),
  );

  // ── real agent run through launchRun ───────────────────────────────────────
  console.log("\n── agent run (launchRun) ──");
  const accountsPath =
    process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH ||
    statePath(".opensession-claude-accounts.json");
  let hasAccounts = false;
  let socketRunOk = false; // gates the WS-section agent runs (same cost rule)
  try {
    const store = JSON.parse(await Bun.file(accountsPath).text());
    hasAccounts = Array.isArray(store.accounts) && store.accounts.length > 0;
  } catch {}
  if (!hasAccounts) {
    console.log(
      "  (dry-run: no account pool at",
      accountsPath,
      "— skipping the live agent run)",
    );
  } else {
    const spec: RunHostSpec = {
      hostId: `rh-verify-${Date.now().toString(36)}`,
      osSessionId: SESSION_ID,
      prompt: "Reply with exactly: OK",
      cwd: WT,
      mode: "ask",
      model: "claude-haiku-4-5",
      mcpServers: [],
      journalKind: "prompt",
    };
    const handle = sandbox.launchRun(spec, {});
    const events: string[] = [];
    let doneText = "";
    let sawInit = false;
    const consume = (async () => {
      for await (const ev of handle.events()) {
        events.push(ev.type);
        if (ev.type === "init") sawInit = true;
        if (ev.type === "text_chunk") doneText += ev.text || "";
        if (ev.type === "done" || ev.type === "error") return ev;
      }
      return null;
    })();
    const result = await Promise.race([
      consume,
      new Promise<null>((r) => setTimeout(() => r(null), 180_000)),
    ]);
    if (!result) handle.cancel();
    ok(
      "run emitted init (engine session started in-container)",
      sawInit,
      events.slice(0, 6).join(","),
    );
    ok(
      "run finished with done",
      result?.type === "done",
      result
        ? `${result.type}: ${(result.result || result.content || "").slice(0, 120)}`
        : "timed out after 180s",
    );
    socketRunOk = result?.type === "done";
    ok(
      "model replied",
      /\bOK\b/i.test(doneText) || /\bOK\b/i.test(result?.result || ""),
      JSON.stringify(doneText.slice(0, 80)),
    );
    const transcriptDir = `${process.env.HOME}/.claude/projects/-${WT.replaceAll("/", "-").replace(/^-/, "")}`;
    ok(
      "engine transcript visible host-side",
      existsSync(transcriptDir),
      transcriptDir,
    );
  }

  // ── failed launch must not wedge the session busy ───────────────────────────
  // The HostHandle ctor registers a host-registry control keyed by the bks
  // session id; a connect failure (socket never appears) must drop it via
  // abandon() — the cleanup launchRunEager/spawnHostRun run in their catch —
  // or hostRunBusy() stays true forever and every future prompt reads busy.
  console.log("\n── failed-launch cleanup (host-registry) ──");
  const { HostHandle } =
    await import("../../packages/core/opensession-server/src/server/host-client");
  const { hostRunBusy } =
    await import("../../packages/core/opensession-server/src/server/host-registry");
  const failSession = `sbxtest-fail-${Date.now().toString(36)}`;
  const failDir = `${SCRATCH}/fail-run`;
  mkdirSync(failDir, { recursive: true });
  const failHandle = new HostHandle(
    failDir,
    {
      hostId: "rh-sbxtest-fail",
      osSessionId: failSession,
      prompt: "x",
      cwd: WT,
      mode: "ask",
      model: "claude-haiku-4-5",
      mcpServers: [],
      journalKind: "prompt",
    },
    {},
    // Launcher that "succeeds" but never brings up a socket = unreachable host.
    { alive: () => false, newRunDir: () => failDir, launch: async () => {} },
  );
  ok(
    "HostHandle ctor registers the run (session reads busy)",
    hostRunBusy(failSession),
  );
  let connectThrew = false;
  try {
    await failHandle.connectWithWait(700);
  } catch {
    connectThrew = true;
  }
  ok("connectWithWait throws on an unreachable socket", connectThrew);
  failHandle.abandon();
  ok(
    "abandon() clears the busy registration after a failed connect",
    !hostRunBusy(failSession),
  );

  // ── stop/start lifecycle ────────────────────────────────────────────────────
  console.log("\n── lifecycle ──");
  await sh(["docker", "stop", "-t", "5", CONTAINER]);
  ok("stopped", (await sandbox.status()) === "stopped");
  const revived = await provider.ensure({ sessionId: SESSION_ID, cwd: WT });
  ok(
    "ensure() restarts a stopped container",
    (await revived.status()) === "running",
  );
  const got = await provider.get(CONTAINER);
  ok("get() reattaches by id", got !== null && got.cwd === WT, got?.cwd);

  // ── destroy ─────────────────────────────────────────────────────────────────
  console.log("\n── destroy ──");
  await provider.destroy(CONTAINER);
  const goneC = await sh(["docker", "inspect", CONTAINER]);
  const goneV = await sh([
    "docker",
    "volume",
    "inspect",
    `${CONTAINER}-claude`,
  ]);
  ok("container removed", goneC.code !== 0);
  ok("volumes removed", goneV.code !== 0);
  ok("worktree untouched by destroy", existsSync(`${WT}/sandbox-file.txt`));

  // ══ VOLUME MODE ═════════════════════════════════════════════════
  // The workspace lives ONLY in a per-session volume: ensure() clones the
  // scratch bare origin inside the container; nothing appears host-side. The
  // read surfaces are exercised exec-routed (workspaceExecFor), exactly the
  // way opensession.ts routes them for such a session.
  console.log("\n══ volume-mode workspace ══");
  const vol = await provider.ensure({
    sessionId: VOL_SESSION_ID,
    repo: "sbxtest",
    branch: VOL_BRANCH,
    mode: "code",
  });
  ok(
    "ensure() materialized a volume workspace",
    vol.workspace === "volume",
    `${vol.id} cwd=${vol.cwd}`,
  );
  ok("cwd is the canonical worktree path", vol.cwd === VOL_CWD, vol.cwd);
  ok("no host dir was created", !existsSync(VOL_CWD));
  const wsVol = await sh([
    "docker",
    "volume",
    "inspect",
    `${VOL_CONTAINER}-ws`,
  ]);
  ok("workspace volume exists", wsVol.code === 0, `${VOL_CONTAINER}-ws`);
  const volStatus = await vol.exec(["git", "status", "--porcelain"]);
  ok(
    "git works in the cloned volume",
    volStatus.exitCode === 0,
    volStatus.stderr.trim(),
  );
  const volBranch = await vol.exec(["git", "branch", "--show-current"]);
  ok(
    "checked out the session branch",
    volBranch.stdout.trim() === VOL_BRANCH,
    volBranch.stdout.trim(),
  );
  const idem = await provider.ensure({
    sessionId: VOL_SESSION_ID,
    repo: "sbxtest",
    branch: VOL_BRANCH,
    mode: "code",
    cwd: VOL_CWD,
  });
  ok(
    "ensure() is idempotent for volume workspaces",
    idem.id === vol.id && idem.workspace === "volume",
  );

  // Exec-routed surfaces against the volume workspace, via the same session
  // shape opensession.ts derives the exec from.
  console.log("\n── exec-routed surfaces (volume) ──");
  const volSession = {
    sandbox: { provider: "docker", sandboxId: vol.id, workspace: "volume" },
    worktreeDir: VOL_CWD,
    repo: "sbxtest",
  };
  const exec = await workspaceExecFor(volSession);
  ok(
    "workspaceExecFor routes into the sandbox",
    exec.sandboxed && exec.remote,
    `sandboxed=${exec.sandboxed} remote=${exec.remote}`,
  );
  const hits = (await searchRepoEntries(VOL_CWD, "readme", 20, exec)).map(
    (e) => e.path,
  );
  ok(
    "searchRepoEntries (git ls-files in-container)",
    hits.includes("README.md"),
    hits.join(","),
  );
  // Dirty the workspace: modify a tracked file + add an untracked one.
  await exec([
    "sh",
    "-c",
    "echo volume-edit >> README.md && echo new-untracked > sbx-vol-new.txt",
  ]);
  const diff = await getSessionDiff(VOL_CWD, "main", exec);
  ok(
    "getSessionDiff sees the tracked edit",
    diff.files.some((f) => f.path === "README.md" && f.status === "modified"),
    diff.files.map((f) => `${f.path}:${f.status}`).join(","),
  );
  ok(
    "getSessionDiff synthesizes the untracked file (remote fs reads)",
    diff.files.some(
      (f) => f.path === "sbx-vol-new.txt" && f.status === "untracked",
    ) && diff.rawPatch.includes("+new-untracked"),
    `rawPatch ${diff.rawPatch.length} chars`,
  );
  const gs = await getGitStatus(VOL_CWD, "main", exec);
  ok(
    "getGitStatus reads branch + dirty count in-container",
    gs.branch === VOL_BRANCH && gs.uncommittedFiles >= 2,
    `branch=${gs.branch} dirty=${gs.uncommittedFiles}`,
  );

  // ── preview port publishing ─────────────────────────────────────────────────
  console.log("\n── preview ports ──");
  const portMap = await vol.ports();
  const hostPort = portMap[PREVIEW_PORT];
  ok(
    "configured preview port is published to a loopback host port",
    !!hostPort,
    JSON.stringify(portMap),
  );
  if (hostPort) {
    // Trivial static server INSIDE the container on the published port; this
    // independently proves the port+map layer before lifecycle Preview below.
    await sh([
      "docker",
      "exec",
      "-d",
      vol.id,
      "bun",
      "-e",
      `Bun.serve({ port: ${PREVIEW_PORT}, hostname: "0.0.0.0", fetch: () => new Response("sbx-preview-ok") });`,
    ]);
    let body = "";
    for (let i = 0; i < 20 && !body.includes("sbx-preview-ok"); i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        body = await (await fetch(`http://127.0.0.1:${hostPort}/`)).text();
      } catch {}
    }
    ok(
      "host reaches the in-container server through the published port",
      body.includes("sbx-preview-ok"),
      JSON.stringify(body.slice(0, 40)),
    );
  }

  // ── stopped container: reads fall back to host exec (never docker start) ──
  console.log("\n── stopped-container read fallback ──");
  await sh(["docker", "stop", "-t", "5", vol.id]);
  const execStopped = await workspaceExecFor(volSession);
  ok("stopped sandbox → host exec (no wake for reads)", !execStopped.sandboxed);
  ok(
    "container was not started by the read path",
    (await vol.status()) === "stopped",
  );

  // ── volume destroy contract ─────────────────────────────────────────────────
  console.log("\n── volume destroy ──");
  await provider.destroy(vol.id);
  const volGoneC = await sh(["docker", "inspect", vol.id]);
  const volGoneWs = await sh([
    "docker",
    "volume",
    "inspect",
    `${VOL_CONTAINER}-ws`,
  ]);
  ok("volume container removed", volGoneC.code !== 0);
  ok("workspace volume removed (documented data loss)", volGoneWs.code !== 0);

  // ══ WS TRANSPORT ═══════════════════════════════════════════════
  // The run host dials back to a scratch WS server in THIS process (same
  // run-ws module opensession.ts wires), bound on 0.0.0.0 so the container can
  // reach it via the docker bridge gateway. No rpc-socket mount, no host.sock.
  console.log("\n══ ws transport ══");
  const runWs =
    await import("../../packages/core/opensession-server/src/server/run-ws");
  const { registerRunToken: rpcRegister, unregisterRunToken: rpcUnregister } =
    await import("../../packages/core/opensession-server/src/server/run-rpc");
  const gwRaw = await sh([
    "docker",
    "network",
    "inspect",
    "bridge",
    "-f",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]);
  const gateway = gwRaw.out.trim() || "172.17.0.1";
  const wsSrv = Bun.serve({
    port: 0,
    hostname: "0.0.0.0",
    fetch(req, server) {
      return (
        runWs.handleSandboxWsUpgrade(req, server, new URL(req.url).pathname) ??
        undefined
      );
    },
    websocket: {
      open(ws) {
        runWs.sandboxWsOpen(ws);
      },
      message(ws, m) {
        runWs.sandboxWsMessage(ws, m as any);
      },
      close(ws) {
        runWs.sandboxWsClose(ws);
      },
    },
  });
  const wsBase = `ws://${gateway}:${wsSrv.port}`;
  await Bun.write(
    process.env.OPENSESSION_SANDBOX_CONFIG!,
    JSON.stringify({
      provider: "docker",
      transport: "ws",
      callbackBaseUrl: wsBase,
    }),
  );
  console.log(`  scratch run-ws server at ${wsBase}`);

  const wsSbx = await provider.ensure({ sessionId: WS_SESSION_ID, cwd: WT });
  ok(
    "ensure() created a ws-transport container",
    wsSbx.id === WS_CONTAINER,
    wsSbx.id,
  );
  const wsMounts = await sh([
    "docker",
    "inspect",
    "-f",
    "{{range .Mounts}}{{.Destination}}\n{{end}}",
    WS_CONTAINER,
  ]);
  ok(
    "rpc socket NOT mounted (ws transport)",
    !wsMounts.out.includes("opensession-rpc.sock"),
    "mounts: " + wsMounts.out.trim().split("\n").length + " entries",
  );

  // Upgrade auth: an unknown host id / bad token must be refused pre-upgrade.
  const badAuth = await fetch(`http://127.0.0.1:${wsSrv.port}/run-ws/rh-nope`, {
    headers: { authorization: "Bearer wrong" },
  });
  ok(
    "run-ws upgrade refuses a bad token (403)",
    badAuth.status === 403,
    String(badAuth.status),
  );
  const badRpc = await fetch(`http://127.0.0.1:${wsSrv.port}/rpc-ws`);
  ok(
    "rpc-ws upgrade refuses a missing token (403)",
    badRpc.status === 403,
    String(badRpc.status),
  );

  // rpc-ws bridge from INSIDE the container. The upgrade is gated on a
  // WS-TRANSPORT run's hostId + wsToken (run-ws token registry) since the
  // token-gating fix — a plain run-rpc token must be refused pre-upgrade;
  // each FRAME still carries the rpc token that dispatchRunRpc resolves.
  // Register scratch credentials for both layers, expect an {id,status}
  // answer (503 "builder not registered" in this scratch process —
  // auth+bridge proven).
  const scratchToken = crypto.randomUUID(); // per-frame rpc token
  const probeHostId = `rh-rpcprobe-${Date.now().toString(36)}`;
  const probeWsToken = crypto.randomUUID(); // upgrade credential
  rpcRegister(scratchToken, { sessionId: WS_SESSION_ID });
  runWs.registerRunWsHost(probeHostId, probeWsToken);
  const oldShape = await fetch(`http://127.0.0.1:${wsSrv.port}/rpc-ws`, {
    headers: { authorization: `Bearer ${scratchToken}` },
  });
  ok(
    "rpc-ws refuses a plain run-rpc token without a host id (403)",
    oldShape.status === 403,
    String(oldShape.status),
  );
  const rpcProbe = await wsSbx.exec([
    "bun",
    "-e",
    `
    const ws = new WebSocket("${wsBase}/rpc-ws?host=${probeHostId}", { headers: { authorization: "Bearer ${probeWsToken}" } });
    const bail = setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 10000);
    ws.onopen = () => ws.send(JSON.stringify({ id: "p1", path: "/mcp/list", token: "${scratchToken}", server: "opensession-sessions" }));
    ws.onmessage = (ev) => { console.log(String(ev.data)); clearTimeout(bail); process.exit(0); };
    ws.onclose = () => { console.log("CLOSED"); clearTimeout(bail); process.exit(1); };
  `,
  ]);
  ok(
    "rpc-ws bridge answers from inside the container (hostId+wsToken handshake)",
    rpcProbe.exitCode === 0 && rpcProbe.stdout.includes('"status"'),
    (rpcProbe.stdout || rpcProbe.stderr).trim().slice(0, 120),
  );
  runWs.unregisterRunWsHost(probeHostId);
  rpcUnregister(scratchToken);

  // Agent runs over WS — same cost gating as the socket section, plus "only
  // if the socket-mode run actually worked" (no point burning tokens into a
  // broken pool twice).
  if (!hasAccounts || !socketRunOk) {
    console.log(
      "  (dry-run: skipping ws agent runs —",
      !hasAccounts ? "no account pool" : "socket-mode run did not pass",
      ")",
    );
  } else {
    const wsSpec: RunHostSpec = {
      hostId: `rh-wsverify-${Date.now().toString(36)}`,
      osSessionId: WS_SESSION_ID,
      prompt: "Reply with exactly: OK",
      cwd: WT,
      mode: "ask",
      model: "claude-haiku-4-5",
      mcpServers: [],
      journalKind: "prompt",
    };
    const wsHandle = wsSbx.launchRun(wsSpec, {});
    const wsEvents: string[] = [];
    let wsText = "";
    let wsInit = false;
    const wsConsume = (async () => {
      for await (const ev of wsHandle.events()) {
        wsEvents.push(ev.type);
        if (ev.type === "init") wsInit = true;
        if (ev.type === "text_chunk") wsText += ev.text || "";
        if (ev.type === "done" || ev.type === "error") return ev;
      }
      return null;
    })();
    const wsResult = await Promise.race([
      wsConsume,
      new Promise<null>((r) => setTimeout(() => r(null), 180_000)),
    ]);
    if (!wsResult) wsHandle.cancel();
    ok(
      "ws run emitted init (events streamed over the dial-back)",
      wsInit,
      wsEvents.slice(0, 6).join(","),
    );
    ok(
      "ws run finished with done",
      wsResult?.type === "done",
      wsResult
        ? `${wsResult.type}: ${(wsResult.result || wsResult.content || "").slice(0, 120)}`
        : "timed out after 180s",
    );
    ok(
      "ws run model replied",
      /\bOK\b/i.test(wsText) || /\bOK\b/i.test(wsResult?.result || ""),
      JSON.stringify(wsText.slice(0, 80)),
    );

    // Steer delivery + cancel over WS: a long generation we steer, then kill.
    console.log("\n── ws steer / cancel ──");
    const { hostRunBusy: wsBusy } =
      await import("../../packages/core/opensession-server/src/server/host-registry");
    const cancelSpec: RunHostSpec = {
      hostId: `rh-wscancel-${Date.now().toString(36)}`,
      osSessionId: WS_SESSION_ID,
      prompt: "Count from 1 to 400, one number per line. Do not stop early.",
      cwd: WT,
      mode: "ask",
      model: "claude-haiku-4-5",
      mcpServers: [],
      journalKind: "prompt",
    };
    const cancelHandle = wsSbx.launchRun(cancelSpec, {});
    let cSawInit = false;
    let cTerminal: string | null = null;
    const cConsume = (async () => {
      for await (const ev of cancelHandle.events()) {
        if (ev.type === "init") cSawInit = true;
        if (ev.type === "done" || ev.type === "error") cTerminal = ev.type;
      }
    })();
    // Wait for the run to actually be going, then steer + cancel.
    const cDeadline = Date.now() + 60_000;
    while (!cSawInit && Date.now() < cDeadline)
      await new Promise((r) => setTimeout(r, 500));
    ok("cancel-run started (init over ws)", cSawInit);
    const steered = cancelHandle.steer("Nudge: you may stop early.");
    ok("steer delivered over ws", steered);
    const cancelled = cancelHandle.cancel();
    ok("cancel delivered over ws", cancelled);
    const cDone = await Promise.race([
      cConsume.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 60_000)),
    ]);
    ok(
      "cancelled run's stream terminated",
      cDone === true,
      `terminal=${cTerminal}`,
    );
    ok("session no longer busy after cancel", !wsBusy(WS_SESSION_ID));
  }

  // ws sandbox teardown (scratch WS server stops in cleanup below).
  await provider.destroy(wsSbx.id);
  const wsGone = await sh(["docker", "inspect", WS_CONTAINER]);
  ok("ws-transport container removed", wsGone.code !== 0);
  wsSrv.stop(true);

  // ══ SNAPSHOTS ══════════════════════════════════════════════════════════
  // Warm-restore pattern: idle-stop commits the container layer to a
  // bks-snap-* image; a later ensure() for the GONE container starts from it.
  // Volumes/bind mounts (engine state, workspace) are NOT in the image — the
  // marker below goes to the container layer specifically to prove the image
  // path, and sandbox-file.txt (bind-mounted worktree) proves the workspace
  // is mount-carried, not snapshot-carried.
  console.log("\n══ snapshots ══");
  await Bun.write(
    process.env.OPENSESSION_SANDBOX_CONFIG!,
    JSON.stringify({
      provider: "docker",
      snapshots: { enabled: true, maxPerSession: 2 },
    }),
  );
  mkdirSync(`${WT}/.agents`, { recursive: true });
  await Bun.write(
    `${WT}/.agents/setup`,
    "#!/usr/bin/env bash\nprintf post-setup > /home/ubuntu/sbx-post-setup-proof\n",
  );
  const snapRepo = snapshotRepoForSandbox(SNAP_CONTAINER);
  const snapSbx = await provider.ensure({
    sessionId: SNAP_SESSION_ID,
    cwd: WT,
  });
  ok(
    "ensure() created the snapshots-section container",
    snapSbx.id === SNAP_CONTAINER,
    snapSbx.id,
  );
  const setupProof = await snapSbx.exec([
    "cat",
    "/home/ubuntu/sbx-post-setup-proof",
  ]);
  ok(
    ".agents/setup produced container-layer state before snapshot",
    setupProof.exitCode === 0 && setupProof.stdout === "post-setup",
    (setupProof.stdout || setupProof.stderr).trim(),
  );
  const mark = await snapSbx.exec([
    "sh",
    "-c",
    "echo snap-layer-state > /home/ubuntu/sbx-snap-marker",
  ]);
  ok("wrote a container-layer marker", mark.exitCode === 0, mark.stderr.trim());

  // Backdate the state file, then run the REAL sweep scoped to this sandbox:
  // it must snapshot first, then stop.
  const snapStatePath = `${OPENSESSION_SESSIONS_DIR}/sandboxes/${SNAP_CONTAINER}.json`;
  const snapState = JSON.parse(await Bun.file(snapStatePath).text());
  snapState.lastActivityAt = new Date(
    Date.now() - 2 * 60 * 60_000,
  ).toISOString();
  snapState.createdAt = snapState.lastActivityAt;
  await Bun.write(snapStatePath, JSON.stringify(snapState));
  await sweepIdleSandboxes(SNAP_CONTAINER);
  const snapImg = await sh([
    "docker",
    "image",
    "inspect",
    "-f",
    "{{.Id}}",
    `${snapRepo}:latest`,
  ]);
  ok(
    "idle sweep snapshotted before stopping",
    snapImg.code === 0,
    `${snapRepo}:latest`,
  );
  ok(
    "idle sweep stopped the container",
    (await snapSbx.status()) === "stopped",
  );

  // Remove the container entirely (docker rm — NOT destroy, which would drop
  // the snapshot too); ensure() must recreate FROM the snapshot image.
  await sh(["docker", "rm", "-f", SNAP_CONTAINER]);
  const restored = await provider.ensure({
    sessionId: SNAP_SESSION_ID,
    cwd: WT,
  });
  const marker = await restored.exec(["cat", "/home/ubuntu/sbx-snap-marker"]);
  ok(
    "restored container came from the snapshot (container-layer marker present)",
    marker.exitCode === 0 && marker.stdout.includes("snap-layer-state"),
    (marker.stdout || marker.stderr).trim(),
  );
  const restoredSetupProof = await restored.exec([
    "cat",
    "/home/ubuntu/sbx-post-setup-proof",
  ]);
  ok(
    "snapshot restore retained .agents/setup state without rerunning setup",
    restoredSetupProof.exitCode === 0 &&
      restoredSetupProof.stdout === "post-setup",
    (restoredSetupProof.stdout || restoredSetupProof.stderr).trim(),
  );
  const fromImage = await sh([
    "docker",
    "inspect",
    "-f",
    "{{.Config.Image}}",
    SNAP_CONTAINER,
  ]);
  ok(
    "container image is the snapshot",
    fromImage.out.trim() === `${snapRepo}:latest`,
    fromImage.out.trim(),
  );
  const snapGit = await restored.exec(["git", "status", "--porcelain"]);
  const snapWs = await restored.exec(["cat", "sandbox-file.txt"]);
  ok(
    "workspace still correct after restore (bind mounts intact)",
    snapGit.exitCode === 0 && snapWs.exitCode === 0,
    snapWs.stdout.trim(),
  );

  // maxPerSession pruning: two more snapshots → at most 2 timestamped tags.
  await snapshotSandboxImage(SNAP_CONTAINER);
  await snapshotSandboxImage(SNAP_CONTAINER);
  const tTags = (
    await sh(["docker", "image", "ls", snapRepo, "--format", "{{.Tag}}"])
  ).out
    .split("\n")
    .map((s) => s.trim())
    .filter((t) => /^t\d+$/.test(t));
  ok(
    "maxPerSession enforced (≤2 timestamped snapshots)",
    tTags.length >= 1 && tTags.length <= 2,
    tTags.join(","),
  );

  // destroy() removes the snapshot images with the container/volumes.
  await provider.destroy(SNAP_CONTAINER);
  ok(
    "snapshots-section container removed",
    (await sh(["docker", "inspect", SNAP_CONTAINER])).code !== 0,
  );
  const imgsLeft = await sh([
    "docker",
    "image",
    "ls",
    snapRepo,
    "--format",
    "{{.Tag}}",
  ]);
  ok(
    "destroy removed the snapshot images",
    !imgsLeft.out.trim(),
    imgsLeft.out.trim() || "none",
  );

  // ══ PREVIEW + LIFECYCLE ═══════════════════════════════════════
  // A bind-mode sandbox with the repo-local lifecycle hooks: setup.sh must run
  // exactly once; startSandboxPreview must allocate a webapp port from the
  // pre-published range, run .agents/start.sh with the port/URL env, route
  // Caddy at a NAMESPACED https port (never the host's webapp+6000 scheme),
  // and write the .tunnels.env contract. Uses the LIVE Caddy admin API — all
  // routes/allocations are cleaned up here and in cleanup().
  console.log("\n══ preview + lifecycle ══");
  const previewMod =
    await import("../../packages/core/opensession-server/src/server/preview");
  const previewPortsMod =
    await import("../../packages/core/opensession-server/src/server/sandbox/preview-ports");
  await Bun.write(
    process.env.OPENSESSION_SANDBOX_CONFIG!,
    JSON.stringify({ provider: "docker", previewPorts: PRE_PORTS }),
  );
  mkdirSync(`${WT}/.agents`, { recursive: true });
  await Bun.write(
    `${WT}/.agents/setup`,
    `#!/usr/bin/env bash\necho "setup boot=$OPENSESSION_BOOT_MODE" >> .opensession-setup-runs\n`,
  );
  await Bun.write(
    `${WT}/.agents/start.sh`,
    `#!/usr/bin/env bash
echo "start boot=$OPENSESSION_BOOT_MODE port=$WEBAPP_PORT url=$PREVIEW_URL" > .opensession-start-ran
exec bun -e 'Bun.serve({ port: Number(process.env.WEBAPP_PORT), hostname: "0.0.0.0", fetch: () => new Response("lifecycle-preview-ok") })'
`,
  );

  const pre = await provider.ensure({ sessionId: PRE_SESSION_ID, cwd: WT });
  ok(
    "ensure() created the preview-section container",
    pre.id === PRE_CONTAINER,
    pre.id,
  );
  await provider.ensure({ sessionId: PRE_SESSION_ID, cwd: WT }); // second ensure — setup must not re-run
  const setupRuns = await sh(["cat", `${WT}/.opensession-setup-runs`]);
  ok(
    "setup.sh ran exactly once with boot mode (one-shot per materialization)",
    setupRuns.out.trim() === "setup boot=fresh",
    JSON.stringify(setupRuns.out.trim()),
  );
  const preMap = await pre.ports();
  ok(
    "pre-published preview range mapped to loopback host ports",
    PRE_PORTS.every((p) => typeof preMap[p] === "number"),
    JSON.stringify(preMap),
  );

  const started = await previewMod.startSandboxPreview(pre, WT);
  ok(
    "startSandboxPreview reports starting",
    started.starting === true,
    JSON.stringify({ running: started.running, starting: started.starting }),
  );
  let pst = started;
  for (let i = 0; i < 40 && !pst.running; i++) {
    await new Promise((r) => setTimeout(r, 500));
    pst = await previewMod.getSandboxPreviewStatus(pre, WT);
  }
  ok(
    "webapp came up in-container via .agents/start.sh",
    pst.running,
    pst.services.map((s) => `${s.key}=${s.port}:${s.running}`).join(","),
  );
  ok(
    "allocated webapp port came from the published range",
    pst.webappPort != null && PRE_PORTS.includes(pst.webappPort),
    String(pst.webappPort),
  );
  const startMarker = await sh(["cat", `${WT}/.opensession-start-ran`]);
  ok(
    "start.sh received WEBAPP_PORT / PREVIEW_URL / boot mode env",
    startMarker.out.includes(`port=${pst.webappPort}`) &&
      startMarker.out.includes("url=https://") &&
      startMarker.out.includes("boot=fresh"),
    startMarker.out.trim(),
  );

  // Namespaced https route: sandbox range only, disjoint from the host scheme.
  const httpsPort = pst.previewUrl ? Number(new URL(pst.previewUrl).port) : 0;
  ok(
    "previewUrl allocated from the sandbox https range [20000,28000)",
    httpsPort >= previewPortsMod.SANDBOX_HTTPS_BASE &&
      httpsPort <
        previewPortsMod.SANDBOX_HTTPS_BASE +
          previewPortsMod.SANDBOX_HTTPS_RANGE,
    pst.previewUrl || "no previewUrl",
  );
  const hostSchemePort = (pst.webappPort || 0) + 6000; // what a HOST preview of the same webapp port would claim
  ok(
    "no collision with a simulated host preview on the same webapp port number",
    hostSchemePort < previewPortsMod.SANDBOX_HTTPS_BASE &&
      hostSchemePort !== httpsPort,
    `host would use ${hostSchemePort}, sandbox got ${httpsPort}`,
  );
  const collisionPort = previewPortsMod.sandboxHttpsPortFor(
    COLLISION_SBX_ID,
    pst.webappPort!,
  );
  ok(
    "a second sandbox on the SAME webapp port allocates a different https port",
    collisionPort !== httpsPort,
    `${collisionPort} vs ${httpsPort}`,
  );

  const routeRes = await fetch(
    `http://localhost:2019/config/apps/http/servers/preview_${httpsPort}`,
  );
  const routeJson = routeRes.ok ? JSON.stringify(await routeRes.json()) : "";
  const publishedWebapp = preMap[pst.webappPort!];
  ok(
    "Caddy route exists and dials the published loopback port",
    routeJson.includes(`127.0.0.1:${publishedWebapp}`),
    routeJson.slice(0, 120) || `status ${routeRes.status}`,
  );
  const viaCaddy = await sh([
    "curl",
    "-ks",
    "--max-time",
    "10",
    pst.previewUrl || "https://invalid",
  ]);
  ok(
    "unauthenticated Portal request fails closed at Caddy",
    viaCaddy.out.includes("Sign in required"),
    JSON.stringify(viaCaddy.out.slice(0, 40)),
  );
  const directPreview = await sh([
    "curl",
    "-sS",
    "--max-time",
    "10",
    `http://127.0.0.1:${publishedWebapp}`,
  ]);
  ok(
    "Caddy upstream serves the in-container app",
    directPreview.out.includes("lifecycle-preview-ok"),
    JSON.stringify(directPreview.out.slice(0, 40)),
  );

  // .tunnels.env contract (bind mount → host-visible).
  const tunnels = await sh(["cat", `${WT}/.tunnels.env`]);
  ok(
    ".tunnels.env written with PREVIEW_URL + per-port var",
    tunnels.out.includes(`PREVIEW_URL=${pst.previewUrl}`) &&
      tunnels.out.includes(`PREVIEW_URL_${pst.webappPort}=${pst.previewUrl}`),
    tunnels.out.trim().split("\n").join(" | "),
  );

  // Stop: route dropped, dev process group dead, contract cleared.
  let stopped = await previewMod.stopSandboxPreview(pre, WT);
  for (let i = 0; i < 20 && stopped.running; i++) {
    await new Promise((r) => setTimeout(r, 250));
    stopped = await previewMod.getSandboxPreviewStatus(pre, WT);
  }
  ok("stopSandboxPreview took the dev server down", !stopped.running);
  const routeGone = await fetch(
    `http://localhost:2019/config/apps/http/servers/preview_${httpsPort}`,
  );
  const routeGoneBody = routeGone.ok ? await routeGone.text() : "";
  ok(
    "Caddy route removed on stop",
    !routeGone.ok || routeGoneBody.trim() === "null",
    `status ${routeGone.status}`,
  );
  ok(".tunnels.env cleared on stop", !existsSync(`${WT}/.tunnels.env`));

  // Range exhaustion: with every published port busy (and no .ports.conf to
  // reuse), start must refuse rather than pick an unroutable port — the
  // documented fallback is widening previewPorts + recreating the container.
  await pre.exec(["sh", "-c", "rm -f .ports.conf"]);
  for (const p of PRE_PORTS) {
    await sh([
      "docker",
      "exec",
      "-d",
      pre.id,
      "bun",
      "-e",
      `Bun.serve({ port: ${p}, hostname: "0.0.0.0", fetch: () => new Response("busy") });`,
    ]);
  }
  let occupied = 0;
  for (let i = 0; i < 20 && occupied < PRE_PORTS.length; i++) {
    await new Promise((r) => setTimeout(r, 250));
    occupied = 0;
    for (const p of PRE_PORTS) {
      if (
        (
          await pre.exec([
            "timeout",
            "2",
            "bash",
            "-c",
            `exec 3<>/dev/tcp/127.0.0.1/${p}`,
          ])
        ).exitCode === 0
      )
        occupied++;
    }
  }
  const exhausted = await previewMod.startSandboxPreview(pre, WT);
  ok(
    "published-range exhaustion refuses to start (recreate-with-wider-range fallback)",
    !exhausted.starting && !exhausted.running,
    JSON.stringify({ starting: exhausted.starting }),
  );
  await pre.exec(["pkill", "-f", "bun -e"]);

  // ══ TERMINAL (sandbox-aware Shell tab — src/server/terminals.ts) ══════════
  // The Shell tab's PTY must land INSIDE a docker sandbox (docker exec), wake
  // a stopped container on open, and degrade to a host shell (with a notice)
  // when the sandbox is gone. Daytona: same entry point over the SSH gateway,
  // exercised against a cheap BARE sandbox (the terminal needs no runner
  // payload) only when credentials are present.
  console.log("\n══ terminal ══");
  const termMod =
    await import("../../packages/core/opensession-server/src/server/terminals");
  const termCollect = () => {
    const st = { out: "", notices: 0, exited: false, ready: null as any };
    return {
      st,
      send: (m: any) => {
        if (m.type === "term_data")
          st.out += Buffer.from(m.data, "base64").toString();
        if (m.type === "term_notice") st.notices++;
        if (m.type === "term_ready") st.ready = m;
        if (m.type === "term_exit") st.exited = true;
      },
    };
  };
  const waitTerm = async (cond: () => boolean, ms = 20_000) => {
    for (let i = 0; i < ms / 250 && !cond(); i++)
      await new Promise((r) => setTimeout(r, 250));
    return cond();
  };
  // terminals are keyed by (socket, termId); each scratch socket below opens
  // exactly one shell, so a fixed id is correct.
  const TERM_ID = "verify";
  const typeInto = (ws: unknown, line: string) =>
    termMod.writeTerminal(
      ws,
      TERM_ID,
      Buffer.from(`${line}\n`).toString("base64"),
    );
  const termSession = {
    worktreeDir: WT,
    sandbox: { provider: "docker", sandboxId: pre.id },
  };

  const term1 = termCollect();
  const tws1 = {};
  await termMod.startSessionTerminal(tws1, TERM_ID, termSession, {
    cols: 100,
    rows: 30,
    send: term1.send,
  });
  ok(
    "terminal targets the docker sandbox",
    term1.st.ready?.target === "docker",
    JSON.stringify(term1.st.ready),
  );
  await new Promise((r) => setTimeout(r, 1200)); // let bash -il settle
  typeInto(tws1, "echo T_$([ -f /.dockerenv ] && echo IN)_SBX; pwd; exit");
  await waitTerm(() => term1.st.exited);
  ok(
    "shell ran inside the container in the workspace cwd",
    term1.st.out.includes("T_IN_SBX") && term1.st.out.includes(WT),
    JSON.stringify(term1.st.out.slice(-120)),
  );
  termMod.stopTerminal(tws1, TERM_ID);

  // Wake-on-demand: opening a terminal is an interactive gesture — it starts
  // a stopped container (unlike the read surfaces, which never wake one).
  await sh(["docker", "stop", "-t", "2", pre.id]);
  const term2 = termCollect();
  const tws2 = {};
  await termMod.startSessionTerminal(tws2, TERM_ID, termSession, {
    cols: 80,
    rows: 24,
    send: term2.send,
  });
  await new Promise((r) => setTimeout(r, 1200));
  typeInto(tws2, "echo WAKE_OK; exit");
  const wokeExited = await waitTerm(() => term2.st.exited);
  ok(
    "terminal wakes a stopped container and gets a live shell",
    term2.st.ready?.target === "docker" &&
      wokeExited &&
      term2.st.out.includes("WAKE_OK"),
    JSON.stringify({ ready: term2.st.ready?.target, exited: wokeExited }),
  );
  termMod.stopTerminal(tws2, TERM_ID);

  // Gone sandbox → host shell fallback with a notice (fail-open, never a
  // dead tab).
  const term3 = termCollect();
  const tws3 = {};
  await termMod.startSessionTerminal(
    tws3,
    TERM_ID,
    {
      worktreeDir: WT,
      sandbox: { provider: "docker", sandboxId: "bks-sbx-sbxtest-gone-p" },
    },
    { cols: 80, rows: 24, send: term3.send },
  );
  ok(
    "gone sandbox falls back to a host shell with a notice",
    term3.st.ready?.target === "host" &&
      term3.st.notices > 0 &&
      term3.st.ready?.cwd === WT,
    JSON.stringify(term3.st.ready),
  );
  termMod.stopTerminal(tws3, TERM_ID);

  // Daytona terminal (SSH gateway) — bare sandbox, only with credentials.
  const daytonaKey =
    process.env.DAYTONA_API_KEY ||
    (() => {
      try {
        return JSON.parse(
          readFileSync(statePath(".opensession-sandbox.json"), "utf-8"),
        )?.daytona?.apiKey as string | undefined;
      } catch {
        return undefined;
      }
    })();
  if (!daytonaKey) {
    console.log("  daytona terminal: SKIPPED (no credentials)");
  } else {
    process.env.DAYTONA_API_KEY ||= daytonaKey;
    const { Daytona } = await import("@daytonaio/sdk");
    const dclient = new Daytona({ apiKey: daytonaKey });
    console.log(
      "  creating bare daytona sandbox (terminal needs no runner payload)…",
    );
    const dsbx = await dclient.create(
      {
        labels: {
          "opensession.sandbox": "1",
          "opensession.probe": "terminal-verify",
        },
      } as any,
      { timeout: 300 },
    );
    try {
      const term4 = termCollect();
      const tws4 = {};
      await termMod.startSessionTerminal(
        tws4,
        TERM_ID,
        {
          worktreeDir: "/home/daytona",
          sandbox: { provider: "daytona", sandboxId: dsbx.id },
        },
        { cols: 100, rows: 30, send: term4.send },
      );
      ok(
        "terminal targets the daytona sandbox (SSH gateway)",
        term4.st.ready?.target === "daytona",
        JSON.stringify(term4.st.ready),
      );
      await new Promise((r) => setTimeout(r, 2000)); // gateway + bash settle
      typeInto(tws4, "echo DT_$(whoami)_OK; exit");
      await waitTerm(() => term4.st.exited, 30_000);
      ok(
        "daytona shell ran in-sandbox as the sandbox user",
        term4.st.out.includes("DT_daytona_OK"),
        JSON.stringify(term4.st.out.slice(-120)),
      );
      termMod.stopTerminal(tws4, TERM_ID);
    } finally {
      await dclient
        .delete(dsbx, 120)
        .catch((e: any) =>
          console.warn("  daytona sandbox delete failed:", e?.message || e),
        );
    }
  }

  // Destroy releases the sandbox's https allocations.
  await provider.destroy(pre.id);
  ok(
    "preview-section container removed",
    (await sh(["docker", "inspect", PRE_CONTAINER])).code !== 0,
  );
  ok(
    "https allocations released on destroy",
    previewPortsMod.lookupSandboxHttpsPort(pre.id, pst.webappPort!) === null,
  );
  previewPortsMod.releaseSandboxPreviewPorts(COLLISION_SBX_ID);
} finally {
  await cleanup();
}

console.log(
  `\n${pass} passed, ${fail} failed${fail ? ` — ${failures.join("; ")}` : ""}`,
);
process.exit(fail ? 1 : 0);
