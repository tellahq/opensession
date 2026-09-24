/**
 * Live check of remote workspaces (the agent loop on this server, its tools
 * in a Sandbox; packages/core/opensession-server/src/server/remote-workspace.ts)
 * against a real provider. Run MANUALLY:
 *
 *   bun run deploy/sandbox/verify-remote-workspace.ts [box|daytona]
 *
 * Prepares one base-runtime Sandbox for a scratch session on a small public
 * repository, drives every tool operation through the same server handler a
 * run's tool calls reach (sandbox/workspace-rpc.ts), prints the round-trip
 * time of each, and destroys the Sandbox. Like conformance.ts, every store is
 * redirected to a scratch directory before any server import; credentials
 * are read from the live connection store and only written there.
 */

const SCRATCH = `${process.env.HOME || homedir()}/.sandbox-remote-workspace-scratch`;
process.env.OPENSESSION_RUN_JOURNAL = `${SCRATCH}/active-runs.json`;
process.env.OPENSESSION_SANDBOX_CONFIG = `${SCRATCH}/sandbox-config.json`;
process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = `${SCRATCH}/workspace-secrets.json`;
process.env.OPENSESSION_SESSIONS_DIR = `${SCRATCH}/sessions`;
process.env.OPENSESSION_CONFIG = `${SCRATCH}/opensession-config.json`;
process.env.OPENSESSION_SANDBOX_CERTIFICATION_RUN = "1";

import { homedir } from "os";
import { mkdirSync, readFileSync, rmSync } from "fs";

const HOME = process.env.HOME || homedir();
const providerId = (process.argv[2] || "box") as "box" | "daytona";

function live(): any {
  try {
    return JSON.parse(
      readFileSync(`${HOME}/.opensession-sandbox.json`, "utf8"),
    );
  } catch {
    return {};
  }
}
const liveCfg = live();
const connection = (liveCfg.connections || []).find(
  (c: any) => c?.provider === providerId,
);
function secret(ref?: string): string {
  if (!ref) return "";
  try {
    const store = JSON.parse(
      readFileSync(`${HOME}/.opensession-workspace-secrets.json`, "utf8"),
    );
    return String(store?.secrets?.find((s: any) => s?.id === ref)?.value || "");
  } catch {
    return "";
  }
}
const key = secret(connection?.credentialRef);
if (!key) {
  console.log(`SKIPPED: no ${providerId} connection`);
  process.exit(0);
}

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(`${SCRATCH}/sessions`, { recursive: true });
// The Sandbox dials this server's public ingress (for Portals); reuse the
// live ingress setting so the provider's reachability probe passes.
let liveIngress: unknown;
try {
  liveIngress = JSON.parse(
    readFileSync(`${HOME}/.opensession/config.json`, "utf8"),
  )?.ingress;
} catch {}
await Bun.write(
  process.env.OPENSESSION_CONFIG!,
  JSON.stringify({
    ...(liveIngress ? { ingress: liveIngress } : {}),
    repos: {
      sbxrw: {
        repo: `${SCRATCH}/no-local-checkout`,
        wtPrefix: "sbxrw",
        defaultBranch: "main",
        ghRepo: "tellahq/opensession",
        depsInstall: "true",
      },
    },
  }),
);
await Bun.write(
  process.env.OPENSESSION_SANDBOX_CONFIG!,
  JSON.stringify({
    provider: providerId,
    prewarm: { enabled: false },
  }),
);

const { connectSandboxProvider, setSandboxConnectionQualification } =
  await import("../../packages/core/opensession-server/src/server/sandbox/connections");
connectSandboxProvider(providerId, {
  secret: key,
  settings: connection?.settings || {},
});
setSandboxConnectionQualification(providerId, { status: "ready" });

const { getSandboxProvider } =
  await import("../../packages/core/opensession-server/src/server/sandbox/index");
const { dispatchWorkspaceExec, primeWorkspaceSandbox } =
  await import("../../packages/core/opensession-server/src/server/sandbox/workspace-rpc");
const remote =
  await import("../../packages/core/opensession-server/src/server/remote-workspace");
const { sandboxSessionScratchDir } =
  await import("../../packages/core/opensession-server/src/server/session-scratch");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const value = await fn();
  console.log(`    ${name}: ${Math.round(performance.now() - started)} ms`);
  return value;
}

const sessionId = `sbxtest-rw-${Date.now().toString(36)}`;
const provider = getSandboxProvider(providerId);
const ensureStarted = performance.now();
const { listRemoteStates } =
  await import("../../packages/core/opensession-server/src/server/sandbox/adapters/bootstrap");
async function destroyLeftovers(): Promise<void> {
  for (const state of listRemoteStates(providerId))
    await provider
      .destroy(state.sandboxId)
      .then(() => console.log(`destroyed ${state.sandboxId}`))
      .catch((error) =>
        console.error(`could not destroy ${state.sandboxId}:`, error),
      );
}
let sandbox: Awaited<ReturnType<typeof provider.ensure>>;
try {
  sandbox = await provider.ensure({
    sessionId,
    repo: "sbxrw",
    branch: "main",
    mode: "code",
  });
} catch (error) {
  console.error("prepare failed:", error);
  await destroyLeftovers();
  process.exit(1);
}
console.log(
  `prepared ${sandbox.id} in ${Math.round(performance.now() - ensureStarted)} ms (${sandbox.cwd})`,
);
try {
  primeWorkspaceSandbox(sessionId, sandbox);
  const token = crypto.randomUUID();
  const ws = new remote.RemoteWorkspace(
    {
      provider: providerId,
      sandboxId: sandbox.id,
      cwd: sandbox.cwd,
      scratchDir: sandboxSessionScratchDir(sessionId, providerId),
    },
    async (body) => {
      const reply = await dispatchWorkspaceExec({ sessionId }, token, body);
      if (typeof reply.error === "string") throw new Error(reply.error);
      return reply as unknown as {
        exitCode: number;
        stdout: string;
        stderr: string;
      };
    },
  );
  const ops = remote.makeRemoteToolOps(ws);

  const noRunner = await ws.exec({
    script:
      "test -e ~/.bks-bootstrapped && echo runner || echo base; command -v opensession; command -v bun; command -v rg",
  });
  check(
    "base runtime only, guest tools on PATH",
    noRunner.stdout.startsWith("base") &&
      noRunner.stdout.includes("/.local/bin/opensession") &&
      noRunner.stdout.includes("/bun"),
    noRunner.stdout.trim().replaceAll("\n", " "),
  );

  const readme = await timed("read README.md", () =>
    ops.read.readFile("README.md"),
  );
  check("read", readme.length > 0, `${readme.length} bytes`);
  await timed("write file", () =>
    ops.write.writeFile(`${sandbox.cwd}/.rw-check/hello.txt`, "hello\n"),
  );
  const back = await timed("read it back", () =>
    ops.read.readFile(`${sandbox.cwd}/.rw-check/hello.txt`),
  );
  check("write round trip", back.toString() === "hello\n");
  const entries = await timed("ls", () => ops.ls.readdir(sandbox.cwd));
  check("ls", entries.includes("README.md"), `${entries.length} entries`);
  const found = await timed("find *.md", () =>
    ops.find.glob("*.md", sandbox.cwd, { ignore: [], limit: 20 }),
  );
  check("find", found.length > 0, `${found.length} files`);
  const grep = await timed("grep", () =>
    remote.makeRemoteGrepExecute(ws)("t", {
      pattern: "Open Session",
      limit: 5,
    }),
  );
  check("grep", grep.content[0].text !== "No matches found");
  const status = await timed("bash git status", () =>
    remote.runRemoteCommand(ws, {
      command: "git status --short | head -5; git rev-parse --abbrev-ref HEAD",
      timeoutS: 60,
      outputCap: 40_000,
      env: remote.remoteCommandEnv({}, ws, "rw", false),
      signals: [],
    }),
  );
  check("bash", status.exitCode === 0, status.output.trim().slice(-40));
  const controller = new AbortController();
  const stopStarted = performance.now();
  const stopping = remote.runRemoteCommand(ws, {
    command: "sleep 120",
    timeoutS: 300,
    outputCap: 1_000,
    env: remote.remoteCommandEnv({}, ws, "rw", false),
    signals: [controller.signal],
  });
  await Bun.sleep(1_500);
  controller.abort();
  const stopped = await stopping;
  check(
    "stop kills the command",
    stopped.cancelled && performance.now() - stopStarted < 30_000,
    `${Math.round(performance.now() - stopStarted)} ms`,
  );
  const mirror = await timed("mirror context", () =>
    remote.mirrorRemoteContext(ws, `${SCRATCH}/mirror`),
  );
  let agents = "";
  try {
    agents = readFileSync(`${mirror.dir}/AGENTS.md`, "utf8");
  } catch {}
  check("AGENTS.md mirrored", agents.length > 0);
} finally {
  await destroyLeftovers();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
