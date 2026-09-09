#!/usr/bin/env bun
/**
 * Control-plane load generator.
 *
 * Boots an isolated Open Session instance (its own state dir, kernel service
 * and gateway, no executor, no agents, the synthetic engine instead of Pi) and
 * drives it the way a busy fleet does: many sessions each running paced turns,
 * many sidebar sockets subscribed to row frames, a share of them watching a
 * session's transcript. It measures what the gateway and kernel do under that
 * load, not what a model does:
 *
 *   - HTTP latency (p50/p95/p99) for create, prompt, the sidebar list and health
 *   - WebSocket frames by type, and how many `sessions_invalidated` whole-list
 *     refetch orders the fleet still emits (the target is zero on the hot path)
 *   - `session_row` delivery latency from the prompt that caused it
 *   - transcript frame throughput seen by watchers
 *   - peak RSS of the gateway and kernel processes
 *
 * No model tokens are spent and production is never touched: the script
 * refuses a `--url` that names the live instance or its ports.
 *
 *   bun scripts/load-control-plane.ts [--sessions 200] [--clients 50] [--turns 2]
 *       [--rate 20] [--chunks 40] [--tools 4] [--chunk-ms 25] [--keep]
 *       [--url http://127.0.0.1:PORT]   # drive an already running isolated instance
 *
 * Writes a JSON report under artifacts/load/ and prints a summary.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

function flag(name: string): boolean {
  return process.argv.includes(name);
}
function value(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]!
    : fallback;
}
function num(name: string, fallback: number): number {
  const parsed = Number(value(name, String(fallback)));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const SESSIONS = num("--sessions", 200);
const CLIENTS = num("--clients", 50);
const TURNS = num("--turns", 2);
const RATE = Math.max(1, num("--rate", 20));
const CHUNKS = num("--chunks", 40);
const TOOLS = num("--tools", 4);
const CHUNK_MS = num("--chunk-ms", 25);
const KEEP = flag("--keep");
const TARGET_URL = value("--url", "");
const USER = "Load";
const SIDEBAR_QUERY = `?archived=exclude&view=sidebar&user=${USER}&person=me&repo=all&autoCreated=hide`;

if (/os\.tella\.dev|:3850\b|:3849\b/.test(TARGET_URL))
  throw new Error("Refusing to load the live instance");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Latency samples ────────────────────────────────────────────────────────
class Samples {
  values: number[] = [];
  add(ms: number) {
    this.values.push(ms);
  }
  quantile(q: number): number {
    if (!this.values.length) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  }
  summary() {
    return {
      n: this.values.length,
      p50: Math.round(this.quantile(0.5)),
      p95: Math.round(this.quantile(0.95)),
      p99: Math.round(this.quantile(0.99)),
      max: Math.round(Math.max(0, ...this.values)),
    };
  }
}

const http = {
  create: new Samples(),
  prompt: new Samples(),
  list: new Samples(),
  health: new Samples(),
};
const rowLatency = new Samples();
const frames = new Map<string, number>();
let invalidations = 0;
let transcriptFrames = 0;
const httpErrors: string[] = [];

async function timed<T>(bucket: Samples, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await run();
  } finally {
    bucket.add(performance.now() - start);
  }
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    httpErrors.push(
      `${init?.method ?? "GET"} ${path} -> ${response.status} ${text.slice(0, 120)}`,
    );
    throw new Error(`${path} ${response.status}`);
  }
  return response.json();
}

// ── Instance lifecycle ─────────────────────────────────────────────────────
async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port!;
  server.stop(true);
  return port;
}

async function waitFor(url: string, timeoutMs: number, proc?: Bun.Subprocess) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null)
      throw new Error(`process exited early with ${proc.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${url}`);
}

const runId = `load-${Date.now().toString(36)}`;
const runDir = `/tmp/opensession-${runId}`;
const stateDir = join(runDir, "state");
let kernel: Bun.Subprocess | undefined;
let gateway: Bun.Subprocess | undefined;
let baseUrl = TARGET_URL;

async function launch(): Promise<void> {
  mkdirSync(stateDir, { recursive: true });
  const port = await freePort();
  const kernelPort = await freePort();
  const kernelUrl = `http://127.0.0.1:${kernelPort}`;
  const kernelToken = crypto.randomUUID() + crypto.randomUUID();
  const baseEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    LANG: "C.UTF-8",
    NODE_ENV: "development",
    OPENSESSION_STATE_DIR: stateDir,
    OPENSESSION_SESSION_KERNEL_TOKEN: kernelToken,
  };
  kernel = Bun.spawn(
    [
      "bun",
      "run",
      "packages/core/opensession-server/src/session-kernel-service.ts",
    ],
    {
      cwd: ROOT,
      env: { ...baseEnv, OPENSESSION_SESSION_KERNEL_PORT: String(kernelPort) },
      stdout: Bun.file(join(runDir, "session-kernel.log")),
      stderr: Bun.file(join(runDir, "session-kernel.log")),
    },
  );
  await waitFor(`${kernelUrl}/ready`, 60_000, kernel);
  baseUrl = `http://127.0.0.1:${port}`;
  gateway = Bun.spawn(
    ["bun", "run", "packages/core/opensession-server/opensession.ts"],
    {
      cwd: ROOT,
      env: {
        ...baseEnv,
        PORT: String(port),
        HOST: "127.0.0.1",
        OPENSESSION_DEV: "1",
        OPENSESSION_SYNTHETIC_ENGINE: "1",
        OPENSESSION_SYNTHETIC_CHUNKS: String(CHUNKS),
        OPENSESSION_SYNTHETIC_TOOLS: String(TOOLS),
        OPENSESSION_SYNTHETIC_CHUNK_MS: String(CHUNK_MS),
        OPENSESSION_TEST_IN_PROCESS_RUNS: "1",
        OPENSESSION_EXECUTOR: "0",
        OPENSESSION_DEPLOY_STATE: join(stateDir, "deploy"),
        OPENSESSION_GATEWAY_LEASE: join(stateDir, "gateway-active.lock"),
        OPENSESSION_GATEWAY_LEASE_WAIT_SECS: "1",
        OPENSESSION_SESSION_KERNEL_URL: kernelUrl,
        OPENSESSION_ENV_FILE: "/dev/null",
        OPENSESSION_UI_BASE: baseUrl,
        OPENSESSION_GITHUB_AUTH_STORE: join(stateDir, "github-auth.json"),
        OPENSESSION_WEB_SESSIONS_STORE: join(stateDir, "web-sessions.json"),
        OPENSESSION_KEYCHAIN_STORE: join(stateDir, "keychain.json"),
        OPENSESSION_SEARCH_DB: join(stateDir, "search.db"),
        ENABLE_SLACK_AGENT: "false",
        ENABLE_LINEAR_AGENT: "false",
        ENABLE_PLAIN_AGENT: "false",
        ENABLE_STRIPE_AGENT: "false",
        ENABLE_GITHUB_AGENT: "false",
        ENABLE_GRAFANA_POLLER: "false",
      },
      stdout: Bun.file(join(runDir, "server.log")),
      stderr: Bun.file(join(runDir, "server.log")),
    },
  );
  await waitFor(`${baseUrl}/api/health?brief=1`, 180_000, gateway);
  console.log(`[load] instance up at ${baseUrl} (state ${stateDir})`);
}

function rss(pid: number | undefined): number {
  if (!pid) return 0;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf-8");
    const match = /VmRSS:\s+(\d+) kB/.exec(status);
    return match ? Math.round(Number(match[1]) / 1024) : 0;
  } catch {
    return 0;
  }
}

async function shutdown(): Promise<void> {
  for (const proc of [gateway, kernel]) {
    if (!proc || proc.exitCode !== null) continue;
    proc.kill("SIGTERM");
  }
  const deadline = Date.now() + 15_000;
  while (
    Date.now() < deadline &&
    [gateway, kernel].some((p) => p && p.exitCode === null)
  )
    await sleep(200);
  for (const proc of [gateway, kernel])
    if (proc && proc.exitCode === null) proc.kill("SIGKILL");
  if (!KEEP && !TARGET_URL) rmSync(runDir, { recursive: true, force: true });
  else if (!TARGET_URL) console.log(`[load] kept ${runDir}`);
}

// ── Clients ────────────────────────────────────────────────────────────────
const lastPromptAt = new Map<string, number>();
const rowSeenAfterPrompt = new Set<string>();
const sockets: WebSocket[] = [];

function openClient(): Promise<WebSocket> {
  return new Promise((resolveOpen, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({ type: "sessions_subscribe", query: SIDEBAR_QUERY }),
      );
      resolveOpen(ws);
    };
    ws.onerror = () => reject(new Error("socket failed to open"));
    ws.onmessage = (event) => {
      let message: { type?: string; row?: { id?: string } };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const type = message.type ?? "unknown";
      frames.set(type, (frames.get(type) ?? 0) + 1);
      if (type === "sessions_invalidated") invalidations++;
      else if (type === "session_row" && message.row?.id) {
        const id = message.row.id;
        const promptedAt = lastPromptAt.get(id);
        if (promptedAt !== undefined && !rowSeenAfterPrompt.has(id)) {
          rowSeenAfterPrompt.add(id);
          rowLatency.add(performance.now() - promptedAt);
        }
      } else if (type.startsWith("stream_") || type.startsWith("transcript"))
        transcriptFrames++;
    };
    sockets.push(ws);
  });
}

// ── Drive ──────────────────────────────────────────────────────────────────
async function paced<T>(
  items: T[],
  perSecond: number,
  run: (item: T, index: number) => Promise<void>,
) {
  const interval = 1000 / perSecond;
  const start = performance.now();
  const pending: Promise<void>[] = [];
  for (let index = 0; index < items.length; index++) {
    const due = start + index * interval;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    pending.push(run(items[index]!, index).catch(() => {}));
  }
  await Promise.all(pending);
}

async function listRows(): Promise<Array<{ id: string; isRunning?: boolean }>> {
  return timed(http.list, () => api(`/api/sessions${SIDEBAR_QUERY}`));
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  if (!TARGET_URL) await launch();
  const gatewayPid = gateway?.pid;
  const kernelPid = kernel?.pid;
  let peakGatewayRss = 0;
  let peakKernelRss = 0;

  console.log(`[load] opening ${CLIENTS} sidebar client(s)`);
  await Promise.all(Array.from({ length: CLIENTS }, () => openClient()));

  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        await timed(http.health, () => api("/api/health?brief=1"));
        await listRows();
      } catch {}
      peakGatewayRss = Math.max(peakGatewayRss, rss(gatewayPid));
      peakKernelRss = Math.max(peakKernelRss, rss(kernelPid));
      await sleep(1000);
    }
  })();

  console.log(`[load] creating ${SESSIONS} session(s) at ${RATE}/s`);
  const ids: string[] = [];
  const t0 = performance.now();
  await paced(
    Array.from({ length: SESSIONS }, (_, i) => i),
    RATE,
    async (i) => {
      const created = await timed(http.create, () =>
        api("/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: `load session ${i}: summarize the control plane`,
            mode: "scratch",
            user: USER,
          }),
        }),
      );
      if (typeof created?.id === "string") {
        ids.push(created.id);
        lastPromptAt.set(created.id, performance.now());
      }
    },
  );
  console.log(
    `[load] ${ids.length} created in ${Math.round(performance.now() - t0)}ms`,
  );

  // A share of clients watch a transcript, so the fan-out path carries
  // per-session frames too, not only rows.
  sockets.forEach((ws, index) => {
    const id = ids[index % Math.max(1, ids.length)];
    if (id && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "watch", sessionId: id, user: USER }));
  });

  for (let turn = 1; turn <= TURNS; turn++) {
    await drain(ids);
    console.log(
      `[load] turn ${turn}/${TURNS}: prompting ${ids.length} session(s) at ${RATE}/s`,
    );
    rowSeenAfterPrompt.clear();
    await paced(ids, RATE, async (id, i) => {
      lastPromptAt.set(id, performance.now());
      await timed(http.prompt, () =>
        api(`/api/sessions/${encodeURIComponent(id)}/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: `turn ${turn} prompt ${i}`,
            user: USER,
          }),
        }),
      );
    });
  }
  const drained = await drain(ids);
  sampling = false;
  await sampler;

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    target: baseUrl,
    config: { SESSIONS, CLIENTS, TURNS, RATE, CHUNKS, TOOLS, CHUNK_MS },
    created: ids.length,
    drained,
    http: {
      create: http.create.summary(),
      prompt: http.prompt.summary(),
      list: http.list.summary(),
      health: http.health.summary(),
    },
    ws: {
      frames: Object.fromEntries([...frames.entries()].sort()),
      invalidations,
      transcriptFrames,
      rowLatencyMs: rowLatency.summary(),
    },
    rssMb: { gateway: peakGatewayRss, kernel: peakKernelRss },
    httpErrors: httpErrors.slice(0, 20),
    httpErrorCount: httpErrors.length,
  };
  const outDir = join(ROOT, "artifacts", "load");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `control-plane-${runId}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  const row = (label: string, s: ReturnType<Samples["summary"]>) =>
    `${label.padEnd(8)} n=${String(s.n).padStart(5)}  p50=${String(s.p50).padStart(5)}ms  p95=${String(s.p95).padStart(5)}ms  p99=${String(s.p99).padStart(5)}ms  max=${String(s.max).padStart(6)}ms`;
  console.log("");
  console.log(
    `[load] sessions=${SESSIONS} clients=${CLIENTS} turns=${TURNS} rate=${RATE}/s chunks=${CHUNKS} tools=${TOOLS} chunkMs=${CHUNK_MS}`,
  );
  console.log(row("create", report.http.create));
  console.log(row("prompt", report.http.prompt));
  console.log(row("list", report.http.list));
  console.log(row("health", report.http.health));
  console.log(row("row lat", report.ws.rowLatencyMs));
  console.log(
    `frames: ${[...frames.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
  );
  console.log(
    `sessions_invalidated: ${invalidations}   transcript frames: ${transcriptFrames}`,
  );
  console.log(
    `peak RSS: gateway ${peakGatewayRss} MB, kernel ${peakKernelRss} MB   http errors: ${httpErrors.length}`,
  );
  console.log(
    `drained: ${drained ? "yes" : "NO (timed out)"}   report: ${outPath}`,
  );
  for (const error of httpErrors.slice(0, 5)) console.log(`  ${error}`);
}

/** Wait until no created session reports a live run, up to a bound. */
async function drain(ids: string[]): Promise<boolean> {
  const want = new Set(ids);
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    try {
      const rows = await listRows();
      const running = rows.filter((r) => want.has(r.id) && r.isRunning).length;
      if (running === 0) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

try {
  await main();
} finally {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {}
  }
  await shutdown();
  if (existsSync(runDir) && !KEEP && !TARGET_URL)
    rmSync(runDir, { recursive: true, force: true });
}
