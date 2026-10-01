/**
 * Scripted runs: bulk API work with a borrowed credential, without an open
 * broker URL.
 *
 * call_credential makes one call per tool call, which does not scale to a
 * script that pages through tens of thousands of records. A scripted run
 * starts ONE process and gives it a loopback base URL per credential that
 * only this run answers:
 *
 *   http://127.0.0.1:<port>/<secret>/<path on the credential's host>
 *
 * A run with one credential gets it as KEYCHAIN_PROXY_URL (and under the
 * per-credential name); a run with several gets one KEYCHAIN_PROXY_URL_<SLUG>
 * each (proxyEnvName in keychain.ts).
 *
 * - The owners approved this run explicitly: the exact command and a call
 *   cap per credential (request_credential with `run`, mode "run" in
 *   keychain.ts). A run with several credentials starts only once every
 *   credential's owner approved. An ordinary once or standing grant cannot
 *   start a run.
 * - Each credential has its own port and its own 32 random byte secret, and
 *   forwards only to its own credential's host: one credential's URL can
 *   never reach another's host. Secrets live only in the child's
 *   environment and are compared in constant time. All of a run's ports
 *   close together when its process exits, times out, is stopped, or any of
 *   its grants is revoked. A request after that, or with another secret, is
 *   refused.
 * - Every call is checked against its credential's grant and method and path
 *   ceiling, counted against that credential's cap, and audited. Redirects
 *   are not followed, the injected header cannot be overridden, and the
 *   secret is scrubbed from response headers and text bodies.
 *
 * The run lives in this server process. A restart ends it: the proxies go
 * with the process and keychain.ts settles the claimed grants on load,
 * marked interrupted with the call counts last saved, so asking again tells
 * the owners it resumes a run a restart cut off.
 *
 * Stated limitation: agent shells run as the same Unix user, so another local
 * process could read the child's environment while it runs. The exposure is
 * bounded by the run (one process, its lifetime, its cap), unlike the retired
 * broker URL, which any process could use for as long as the grant lived.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { auditAsync } from "./audit";
import { BROKER_METHODS, readCapped } from "./keychain-broker";
import {
  brokerHeaders,
  claimRunGrants,
  ensureKeychainLoaded,
  onGrantRevoked,
  proxyEnvName,
  saveRunProgress,
  scrubSecret,
  settleRunGrants,
  useRunGrant,
} from "./keychain";

export const DEFAULT_RUN_MINUTES = 60;
export const MAX_RUN_MINUTES = 12 * 60;
const UPSTREAM_TIMEOUT_MS = 60_000;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const KILL_GRACE_MS = 10_000;
const LOG_TAIL_BYTES = 4096;
const FINISHED_RETENTION_MS = 24 * 60 * 60 * 1000;
const PROGRESS_SAVE_MS = 60_000;

/** Request headers a script may not set: the credential, cookies, routing
 *  and framing are the proxy's. The credential's own header is added to this
 *  per call. */
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "connection",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "keep-alive",
]);

export type RunState =
  | "running"
  | "exited"
  | "timed_out"
  | "stopped"
  | "revoked"
  | "failed";

/** One credential of a run: its proxy's variable, and its own counts. */
export interface CredentialRunLeg {
  service: string;
  host: string;
  grantId: string;
  /** The environment variable the script reads this proxy's URL from. */
  env: string;
  calls: number;
  denied: number;
  maxCalls: number;
}

export interface CredentialRunSummary {
  id: string;
  sessionId: string;
  /** The credential of a single-credential run; see `credentials` for each
   *  credential of any run. */
  grantId?: string;
  service?: string;
  host?: string;
  command: string;
  cwd: string;
  logPath: string;
  state: RunState;
  startedAt: string;
  deadline: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  /** Totals over every credential of the run. */
  calls: number;
  denied: number;
  maxCalls: number;
  credentials: CredentialRunLeg[];
}

interface Leg extends CredentialRunLeg {
  secret: Buffer;
  proxyUrl: string;
  server?: ReturnType<typeof Bun.serve>;
}

interface Run {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  logPath: string;
  state: RunState;
  startedAt: string;
  deadline: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  legs: Leg[];
  child?: ChildProcess;
  log?: FileHandle;
  timer?: ReturnType<typeof setTimeout>;
  progress?: ReturnType<typeof setInterval>;
  /** Set when finish() starts, since it awaits before setting endedAt. */
  finishing?: boolean;
  deps: Required<RunDeps>;
}

export interface RunDeps {
  /** Upstream fetch. Test seam. */
  fetchImpl?: typeof fetch;
  /** Audit sink. Test seam; the real one is a no-op under test. */
  audit?: (event: Record<string, unknown>) => void;
  /** How often call counts are saved while the run is live. Test seam. */
  progressEveryMs?: number;
}

const g = globalThis as any;
const runs: Map<string, Run> = (g.__keychainRuns ??= new Map());

/** Registered on the first run, not at import. */
function watchRevocations(): void {
  if (g.__keychainRunsWatching) return;
  g.__keychainRunsWatching = true;
  onGrantRevoked((grantId) => {
    for (const run of runs.values())
      if (run.legs.some((leg) => leg.grantId === grantId)) end(run, "revoked");
  });
}

export interface StartRunInput {
  sessionId: string;
  /** One credential, or several in `credentials`. */
  credential?: string;
  credentials?: string[];
  command: string;
  /** Existing directory the command runs in. */
  cwd: string;
  /** Where the combined stdout/stderr log goes. */
  logDir: string;
  timeoutMinutes?: number;
  /** Environment for the child, before the proxy URLs are added. */
  env: Record<string, string>;
  deps?: RunDeps;
}

export async function startCredentialRun(
  input: StartRunInput,
): Promise<{ run: CredentialRunSummary } | { error: string }> {
  await ensureKeychainLoaded();
  watchRevocations();
  pruneFinished();
  const minutes = input.timeoutMinutes ?? DEFAULT_RUN_MINUTES;
  if (!(minutes > 0 && minutes <= MAX_RUN_MINUTES))
    return {
      error: `timeoutMinutes must be more than 0 and at most ${MAX_RUN_MINUTES}`,
    };
  const dir = await stat(input.cwd).catch(() => null);
  if (!dir?.isDirectory())
    return { error: `cwd ${input.cwd} is not a directory` };

  const refs =
    input.credentials ?? (input.credential ? [input.credential] : []);
  if (!refs.length || (input.credential && input.credentials))
    return { error: "name the credential, or the credentials, of the run" };

  const id = `kr-${crypto.randomUUID()}`;
  const deadline = Date.now() + minutes * 60_000;
  const claim = await claimRunGrants({
    sessionId: input.sessionId,
    credentials: refs,
    command: input.command,
    runId: id,
    deadline,
  });
  if ("error" in claim) return claim;

  const run: Run = {
    id,
    sessionId: input.sessionId,
    command: input.command,
    cwd: input.cwd,
    logPath: join(input.logDir, `${id}.log`),
    state: "running",
    startedAt: new Date().toISOString(),
    deadline: new Date(deadline).toISOString(),
    legs: claim.claims.map(({ grant, credential }) => ({
      service: credential.service,
      host: credential.host,
      grantId: grant.id,
      env: proxyEnvName(credential.service),
      calls: 0,
      denied: 0,
      maxCalls: grant.run?.maxCalls ?? 0,
      secret: randomBytes(32),
      proxyUrl: "",
    })),
    deps: {
      fetchImpl: input.deps?.fetchImpl ?? fetch,
      // Every proxied call is audited; never block the thread on it.
      audit: input.deps?.audit ?? auditAsync,
      progressEveryMs: input.deps?.progressEveryMs ?? PROGRESS_SAVE_MS,
    },
  };
  runs.set(id, run);
  // The claim awaited its write; a revocation in that window found no run
  // to end. Then the approved command must not start at all.
  if (claim.claims.some(({ grant }) => grant.status !== "active")) {
    await finish(run, "revoked");
    return { error: "the run was revoked before it started" };
  }

  try {
    for (const leg of run.legs) {
      leg.server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (req) => proxy(run, leg, req),
      });
      leg.proxyUrl = `http://127.0.0.1:${leg.server.port}/${leg.secret.toString("base64url")}`;
    }
    await mkdir(input.logDir, { recursive: true });
    run.log = await open(run.logPath, "a", 0o600);
    // A grant may have been revoked, or the run stopped, while this
    // awaited. Then the approved command must not start at all.
    if (run.state !== "running") {
      const state = run.state;
      await finish(run, state);
      return { error: `the run was ${state} before it started` };
    }
    // Only what the caller passed: never the server's own environment.
    const env: Record<string, string> = { ...input.env };
    for (const leg of run.legs) env[leg.env] = leg.proxyUrl;
    if (run.legs.length === 1) env.KEYCHAIN_PROXY_URL = run.legs[0]!.proxyUrl;
    const child = spawn(Bun.which("bash") ?? "/bin/sh", ["-c", input.command], {
      cwd: input.cwd,
      env: env as unknown as NodeJS.ProcessEnv,
      // Its own process group, so a stop or timeout reaches what it spawned.
      detached: true,
      stdio: ["ignore", run.log.fd, run.log.fd],
    });
    run.child = child;
    child.once("exit", (code, signal) => {
      run.exitCode = code;
      run.signal = signal;
      void finish(run, run.state === "running" ? "exited" : run.state);
    });
    child.once("error", () => {
      run.exitCode = null;
      void finish(run, "failed");
    });
    run.timer = setTimeout(() => end(run, "timed_out"), deadline - Date.now());
    run.progress = setInterval(
      () =>
        void saveRunProgress(run.id, legCalls(run)).catch((error) =>
          console.error("[keychain] failed to save a run's progress:", error),
        ),
      run.deps.progressEveryMs,
    );
    run.progress.unref?.();
  } catch (error) {
    await finish(run, "failed");
    return {
      error: `couldn't start the run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { run: summary(run) };
}

function legCalls(run: Run): Array<{ grantId: string; calls: number }> {
  return run.legs.map((leg) => ({ grantId: leg.grantId, calls: leg.calls }));
}

/** A run of this session, with the tail of its output. */
export async function credentialRunStatus(
  runId: string,
  sessionId: string,
): Promise<(CredentialRunSummary & { outputTail: string }) | undefined> {
  const run = runs.get(runId);
  if (!run || run.sessionId !== sessionId) return undefined;
  return { ...summary(run), outputTail: await tail(run.logPath) };
}

export function listCredentialRuns(sessionId: string): CredentialRunSummary[] {
  return [...runs.values()]
    .filter((r) => r.sessionId === sessionId)
    .map(summary)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function stopCredentialRun(
  runId: string,
  sessionId: string,
): { run: CredentialRunSummary } | { error: string } {
  const run = runs.get(runId);
  if (!run || run.sessionId !== sessionId)
    return { error: "no run with that id in this session" };
  if (run.state !== "running") return { error: `the run already ${run.state}` };
  end(run, "stopped");
  return { run: summary(run) };
}

/** Resolves once the run has ended and released its grant. */
export async function waitForCredentialRun(
  runId: string,
  timeoutMs: number,
): Promise<CredentialRunSummary | undefined> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const run = runs.get(runId);
    if (!run) return undefined;
    if (run.endedAt || Date.now() > until) return summary(run);
    await Bun.sleep(20);
  }
}

function summary(run: Run): CredentialRunSummary {
  const {
    legs,
    child: _child,
    log: _log,
    timer: _timer,
    progress: _progress,
    finishing: _finishing,
    deps: _deps,
    ...rest
  } = run;
  const credentials = legs.map(
    ({ secret: _secret, proxyUrl: _proxyUrl, server: _server, ...leg }) => ({
      ...leg,
    }),
  );
  const only = credentials.length === 1 ? credentials[0]! : undefined;
  const total = (key: "calls" | "denied" | "maxCalls") =>
    credentials.reduce((sum, leg) => sum + leg[key], 0);
  return {
    ...rest,
    ...(only
      ? { grantId: only.grantId, service: only.service, host: only.host }
      : {}),
    calls: total("calls"),
    denied: total("denied"),
    maxCalls: total("maxCalls"),
    credentials,
  };
}

/** Close the proxies now and signal the process group; finish() runs on exit. */
function end(run: Run, state: Exclude<RunState, "running" | "exited">): void {
  if (run.state !== "running") return;
  run.state = state;
  closeProxy(run);
  signalGroup(run, "SIGTERM");
  const kill = setTimeout(() => signalGroup(run, "SIGKILL"), KILL_GRACE_MS);
  kill.unref?.();
}

async function finish(run: Run, state: RunState): Promise<void> {
  if (run.finishing) return;
  run.finishing = true;
  run.state = state;
  if (run.timer) clearTimeout(run.timer);
  if (run.progress) clearInterval(run.progress);
  closeProxy(run);
  // The script is done. Anything it left running in the background has lost
  // the proxies with it, and is told to stop.
  signalGroup(run, "SIGTERM");
  await settleRunGrants(run.id, legCalls(run)).catch((error) =>
    console.error("[keychain] failed to settle a run's grants:", error),
  );
  const totals = summary(run);
  run.deps.audit({
    kind: "keychain_run_ended",
    run_id: run.id,
    ...(totals.grantId ? { grant_id: totals.grantId } : {}),
    session_id: run.sessionId,
    state,
    exit_code: run.exitCode ?? null,
    calls: totals.calls,
    denied: totals.denied,
    ...(run.legs.length > 1
      ? {
          credentials: run.legs.map((leg) => ({
            service: leg.service,
            grant_id: leg.grantId,
            calls: leg.calls,
            denied: leg.denied,
          })),
        }
      : {}),
  });
  await run.log?.close().catch(() => {});
  run.log = undefined;
  run.endedAt = new Date().toISOString();
}

function closeProxy(run: Run): void {
  for (const leg of run.legs) {
    leg.server?.stop(true);
    leg.server = undefined;
  }
}

function signalGroup(run: Run, signal: NodeJS.Signals): void {
  const pid = run.child?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

function pruneFinished(): void {
  const cutoff = Date.now() - FINISHED_RETENTION_MS;
  for (const [id, run] of runs)
    if (run.endedAt && new Date(run.endedAt).getTime() < cutoff)
      runs.delete(id);
}

function refuse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** The rest of the path after this credential's secret, or null when the
 *  first segment is not the secret. Compared in constant time. */
function authorizedPath(leg: Leg, pathname: string): string | null {
  const slash = pathname.indexOf("/", 1);
  const segment = pathname.slice(1, slash === -1 ? undefined : slash);
  const presented = Buffer.from(segment, "base64url");
  if (
    presented.length !== leg.secret.length ||
    presented.toString("base64url") !== segment ||
    !timingSafeEqual(presented, leg.secret)
  )
    return null;
  return slash === -1 ? "/" : pathname.slice(slash);
}

async function proxy(run: Run, leg: Leg, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rest = authorizedPath(leg, url.pathname);
  if (rest === null) return refuse(404, "not found");
  if (run.state !== "running") return refuse(410, `this run ${run.state}`);

  const method = req.method.toUpperCase();
  if (!(BROKER_METHODS as readonly string[]).includes(method))
    return deny(
      run,
      leg,
      method,
      rest,
      405,
      `method ${method} is not supported`,
    );
  let target: URL;
  try {
    target = new URL(`https://${leg.host}${rest}${url.search}`);
  } catch {
    return deny(run, leg, method, rest, 400, "not a valid path");
  }
  if (target.hostname !== leg.host || target.port || target.username)
    return deny(
      run,
      leg,
      method,
      rest,
      400,
      `path must stay on https://${leg.host}`,
    );

  const use = useRunGrant(leg.grantId, run.id, method, target.pathname);
  if ("error" in use) {
    // A grant that is no longer active ends the run, after this response
    // has gone out.
    if (/grant is|no longer exists/.test(use.error))
      setTimeout(() => end(run, "revoked"), 0);
    return deny(run, leg, method, target.pathname, use.status, use.error);
  }
  if (leg.calls >= leg.maxCalls)
    return deny(
      run,
      leg,
      method,
      target.pathname,
      429,
      `this run reached its approved cap of ${leg.maxCalls} calls with ${leg.service}`,
    );
  leg.calls++;
  const { credential } = use;

  const injected = brokerHeaders(credential);
  const dropped = new Set(DROPPED_REQUEST_HEADERS);
  for (const name of Object.keys(injected)) dropped.add(name.toLowerCase());
  const headers = new Headers();
  req.headers.forEach((value, name) => {
    if (!dropped.has(name.toLowerCase())) headers.set(name, value);
  });
  for (const [name, value] of Object.entries(injected))
    headers.set(name, value);

  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body =
      Number(req.headers.get("content-length") || 0) > MAX_REQUEST_BYTES
        ? undefined
        : await req.arrayBuffer();
    if (!body || body.byteLength > MAX_REQUEST_BYTES)
      return upstreamError(
        run,
        leg,
        method,
        target,
        413,
        "request body is too large",
      );
  }

  let res: Response;
  try {
    res = await run.deps.fetchImpl(target, {
      method,
      headers,
      body,
      // A redirect's Location can point anywhere; following it would send the
      // credential somewhere the owner never approved.
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e: any) {
    const reason = e?.name === "TimeoutError" ? "timed out" : "failed";
    return upstreamError(
      run,
      leg,
      method,
      target,
      502,
      `the request to ${leg.host} ${reason}`,
    );
  }
  auditCall(run, leg, method, target.pathname, res.status);

  if (credential.statusOnly) {
    await res.body?.cancel().catch(() => {});
    return new Response(null, { status: res.status });
  }
  const scrub = (text: string) => scrubSecret(text, credential.secret);
  const outHeaders = new Headers();
  res.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()))
      outHeaders.set(name, scrub(value));
  });
  const { bytes, cut } = await readCapped(res, MAX_RESPONSE_BYTES);
  if (cut)
    return refuse(
      502,
      `the response from ${leg.host} is larger than ${MAX_RESPONSE_BYTES} bytes`,
    );
  const contentType = res.headers.get("content-type") || "";
  const textual =
    !contentType || /text\/|json|xml|x-www-form-urlencoded/i.test(contentType);
  const empty = res.status === 204 || res.status === 304 || method === "HEAD";
  return new Response(
    empty
      ? null
      : textual
        ? scrub(new TextDecoder().decode(bytes))
        : (bytes as BodyInit),
    { status: res.status, headers: outHeaders },
  );
}

function auditCall(
  run: Run,
  leg: Leg,
  method: string,
  path: string,
  status: number,
) {
  run.deps.audit({
    kind: "keychain_run_call",
    run_id: run.id,
    grant_id: leg.grantId,
    session_id: run.sessionId,
    service: leg.service,
    method,
    host: leg.host,
    path,
    status,
  });
}

function upstreamError(
  run: Run,
  leg: Leg,
  method: string,
  target: URL,
  status: number,
  error: string,
): Response {
  auditCall(run, leg, method, target.pathname, status);
  return refuse(status, error);
}

function deny(
  run: Run,
  leg: Leg,
  method: string,
  path: string,
  status: number,
  reason: string,
): Response {
  leg.denied++;
  run.deps.audit({
    kind: "keychain_run_denied",
    run_id: run.id,
    grant_id: leg.grantId,
    session_id: run.sessionId,
    service: leg.service,
    method,
    path,
    reason,
  });
  return refuse(status, reason);
}

async function tail(path: string): Promise<string> {
  const file = await open(path, "r").catch(() => null);
  if (!file) return "";
  try {
    const { size } = await file.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    return buffer.toString("utf-8");
  } finally {
    await file.close();
  }
}
