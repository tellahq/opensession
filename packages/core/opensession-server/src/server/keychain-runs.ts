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
 * - The owners approved this run explicitly: the exact command, with each
 *   credential named (request_credential with `run`, mode "run" in
 *   keychain.ts). A run with several credentials starts only once every
 *   credential's owner approved. An ordinary once or standing grant cannot
 *   start a run.
 * - Each credential has its own URL and its own 32 random byte secret, and
 *   forwards only to its own credential's host: one credential's URL can
 *   never reach another's host. Secrets live only in the script's
 *   environment and are compared in constant time (by hash). Every URL of
 *   a run stops working when its process exits, times out, is stopped, or
 *   any of its grants is revoked. A request after that, or with another
 *   secret, is refused.
 * - Every call is checked against its credential's grant and method and path
 *   ceiling, counted, and audited. There is no call cap: a run is bounded by
 *   its lifetime (and deadline), its credentials' method and path limits,
 *   stop_credential_run and revocation. Redirects
 *   are not followed, the injected header cannot be overridden, and the
 *   secret is scrubbed from response headers and text bodies.
 *
 * The process is a script run (script-runs.ts): its script host lives in its
 * own scope and outlives a server restart. The host answers the script's
 * URLs and relays each request to this server, holding requests while the
 * server is down, and this module's relay handler injects the credential.
 * The grants stay claimed for as long as the run lives and are settled when
 * it ends. Only a run whose host is gone without a record is marked
 * interrupted, so asking again tells the owners it resumes a cut-off run.
 *
 * Stated limitation: agent shells run as the same Unix user, so another local
 * process could read the script's environment while it runs. The exposure is
 * bounded by the run (one process, its lifetime), unlike the retired
 * broker URL, which any process could use for as long as the grant lived.
 */

import { auditAsync } from "./audit";
import { BROKER_METHODS, readCapped } from "./keychain-broker";
import {
  brokerHeaders,
  claimRunGrants,
  ensureKeychainLoaded,
  onGrantRevoked,
  proxyEnvName,
  scrubSecret,
  settleOrphanRunGrants,
  settleRunGrants,
  useRunGrant,
} from "./keychain";
import {
  endScriptRun,
  getScriptRun,
  listScriptRuns,
  newScriptRunId,
  onScriptRunEnded,
  readLogTail,
  runningScriptRunIds,
  scriptRunRecord,
  setScriptRelayHandler,
  startScriptRun,
  stopScriptRun,
  summarizeScriptRun,
  type ScriptRelayInfo,
  type ScriptRunRecord,
  type ScriptRunSummary,
} from "./script-runs";
import { RELAY_INDEX_HEADER } from "../script-host/main";

export const DEFAULT_RUN_MINUTES = 60;
export const MAX_RUN_MINUTES = 12 * 60;
const UPSTREAM_TIMEOUT_MS = 60_000;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const LOG_TAIL_BYTES = 4096;

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
  // The script host's own routing header.
  RELAY_INDEX_HEADER,
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "connection",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "keep-alive",
]);

export type RunState = ScriptRunSummary["state"];

/** One credential of a run: its proxy's variable, and its own counts. */
export interface CredentialRunLeg {
  service: string;
  host: string;
  grantId: string;
  /** The environment variable the script reads this proxy's URL from. */
  env: string;
  calls: number;
  denied: number;
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
  credentials: CredentialRunLeg[];
}

export interface RunDeps {
  /** Upstream fetch. Test seam. */
  fetchImpl?: typeof fetch;
  /** Audit sink. Test seam; the real one is a no-op under test. */
  audit?: (event: Record<string, unknown>) => void;
}

const realDeps: Required<RunDeps> = {
  fetchImpl: ((...args: Parameters<typeof fetch>) =>
    fetch(...args)) as typeof fetch,
  // Every proxied call is audited; never block the thread on it.
  audit: auditAsync,
};
let defaultDeps = realDeps;

const g = globalThis as any;
/** Test seams of runs started by this process. A run reattached after a
 *  restart uses the real ones. */
const runDeps: Map<string, Required<RunDeps>> = (g.__keychainRunDeps ??=
  new Map());

function depsOf(runId: string): Required<RunDeps> {
  return runDeps.get(runId) ?? defaultDeps;
}

/** Runs between claiming their grants and being recorded as script runs.
 *  The boot sweep must not take their grants. */
const starting: Set<string> = (g.__keychainRunsStarting ??= new Set());

/**
 * Hook scripted runs into script runs: the relay handler, settling grants
 * when a run ends, and ending a run when one of its grants is revoked.
 * Idempotent. Boot calls it before script runs reattach, so a run that
 * ended while the server was down still settles its grants.
 */
export function hookKeychainRuns(): void {
  if (g.__keychainRunsHooked) return;
  g.__keychainRunsHooked = true;
  setScriptRelayHandler(relay);
  onScriptRunEnded(async (run) => {
    if (run.kind === "credential") await settle(run);
  });
  onGrantRevoked((grantId) => {
    void (async () => {
      for (const id of await runningScriptRunIds())
        if (
          (await scriptRunRecord(id))?.relays?.some(
            (r) => r.grantId === grantId,
          )
        )
          await endScriptRun(id, "revoked");
    })().catch((error) =>
      console.error("[keychain] couldn't end a revoked run:", error),
    );
  });
}

/**
 * At boot, after script runs reattached: settle every claimed grant whose
 * run is not live (a run from before scripted runs were script runs, or one
 * whose record was lost), as cut off.
 */
export async function startKeychainRuns(): Promise<void> {
  hookKeychainRuns();
  await ensureKeychainLoaded();
  const live = new Set(await runningScriptRunIds());
  const settled = await settleOrphanRunGrants(
    (runId) => live.has(runId) || starting.has(runId),
  );
  if (settled)
    console.log(`[keychain] settled ${settled} grant(s) of runs that are gone`);
}

/** Forget the hooks. Tests only, after resetting script runs. */
export function __resetKeychainRunsForTest(): void {
  g.__keychainRunsHooked = false;
  runDeps.clear();
  starting.clear();
  defaultDeps = realDeps;
}

/** The seams a run reattached after a restart uses. Tests only. */
export function __setKeychainRunDefaultsForTest(deps: Required<RunDeps>): void {
  defaultDeps = deps;
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
  /** Short name on the session's card. */
  title?: string;
  startedBy?: string;
  /** Wake the session when the run ends (default true). */
  notify?: boolean;
  deps?: RunDeps;
}

export async function startCredentialRun(
  input: StartRunInput,
): Promise<{ run: CredentialRunSummary } | { error: string }> {
  hookKeychainRuns();
  await ensureKeychainLoaded();
  const minutes = input.timeoutMinutes ?? DEFAULT_RUN_MINUTES;
  if (!(minutes > 0 && minutes <= MAX_RUN_MINUTES))
    return {
      error: `timeoutMinutes must be more than 0 and at most ${MAX_RUN_MINUTES}`,
    };
  const refs =
    input.credentials ?? (input.credential ? [input.credential] : []);
  if (!refs.length || (input.credential && input.credentials))
    return { error: "name the credential, or the credentials, of the run" };

  const id = newScriptRunId();
  starting.add(id);
  try {
    return await claimAndStart(id, refs, minutes, input);
  } finally {
    starting.delete(id);
  }
}

async function claimAndStart(
  id: string,
  refs: string[],
  minutes: number,
  input: StartRunInput,
): Promise<{ run: CredentialRunSummary } | { error: string }> {
  // The grants live exactly as long as the run may.
  const deadline = Date.now() + minutes * 60_000;
  const claim = await claimRunGrants({
    sessionId: input.sessionId,
    credentials: refs,
    command: input.command,
    runId: id,
    deadline,
  });
  if ("error" in claim) return claim;
  const relays: ScriptRelayInfo[] = claim.claims.map(
    ({ grant, credential }) => ({
      env: [
        proxyEnvName(credential.service),
        ...(claim.claims.length === 1 ? ["KEYCHAIN_PROXY_URL"] : []),
      ],
      service: credential.service,
      host: credential.host,
      grantId: grant.id,
      calls: 0,
      denied: 0,
    }),
  );
  const deps: Required<RunDeps> = {
    fetchImpl: input.deps?.fetchImpl ?? defaultDeps.fetchImpl,
    audit: input.deps?.audit ?? defaultDeps.audit,
  };
  // A grant revoked while the run is being prepared found no run to end.
  // Then the approved command must not start at all.
  const revoked = () =>
    claim.claims.some(({ grant }) => grant.status !== "active")
      ? "the run was revoked before it started"
      : undefined;
  const notStarted = async (error: string, state: string) => {
    await settleRunGrants(
      id,
      relays.map((r) => ({ grantId: r.grantId, calls: 0 })),
    ).catch(() => {});
    deps.audit({
      kind: "keychain_run_ended",
      run_id: id,
      ...(relays.length === 1 ? { grant_id: relays[0]!.grantId } : {}),
      session_id: input.sessionId,
      state,
      exit_code: null,
      calls: 0,
      denied: 0,
    });
    return { error };
  };
  if (revoked()) return notStarted(revoked()!, "revoked");

  runDeps.set(id, deps);
  const started = await startScriptRun({
    id,
    sessionId: input.sessionId,
    kind: "credential",
    command: input.command,
    cwd: input.cwd,
    logDir: input.logDir,
    // Only what the caller passed: never the server's own environment.
    env: input.env,
    title: input.title ?? `Run with ${relays.map((r) => r.service).join(", ")}`,
    timeoutMinutes: minutes,
    relays,
    shouldStart: revoked,
    ...(input.startedBy ? { startedBy: input.startedBy } : {}),
    ...(input.notify !== undefined ? { notify: input.notify } : {}),
  });
  if ("error" in started) {
    runDeps.delete(id);
    const wasRevoked = Boolean(revoked());
    return notStarted(
      wasRevoked || started.error.startsWith("couldn't")
        ? started.error
        : `couldn't start the run: ${started.error}`,
      wasRevoked ? "revoked" : "failed",
    );
  }
  // Revoked after the host was launched: its listener found the run and is
  // ending it (the host never starts the command once told to stop).
  if (revoked()) {
    await endScriptRun(id, "revoked");
    return { error: revoked()! };
  }
  return { run: credentialSummary(started.run) };
}

function credentialSummary(run: ScriptRunSummary): CredentialRunSummary {
  const credentials: CredentialRunLeg[] = (run.credentials ?? []).map(
    ({ env, service, host, grantId, calls, denied }) => ({
      service,
      host,
      grantId,
      env: env[0] ?? "",
      calls,
      denied,
    }),
  );
  const only = credentials.length === 1 ? credentials[0]! : undefined;
  const total = (key: "calls" | "denied") =>
    credentials.reduce((sum, leg) => sum + leg[key], 0);
  return {
    id: run.id,
    sessionId: run.sessionId,
    ...(only
      ? { grantId: only.grantId, service: only.service, host: only.host }
      : {}),
    command: run.command,
    cwd: run.cwd,
    logPath: run.logPath,
    state: run.state,
    startedAt: run.startedAt,
    deadline: run.deadline,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    ...(run.signal !== undefined ? { signal: run.signal } : {}),
    calls: total("calls"),
    denied: total("denied"),
    credentials,
  };
}

/** A run of this session, with the tail of its output. */
export async function credentialRunStatus(
  runId: string,
  sessionId: string,
): Promise<(CredentialRunSummary & { outputTail: string }) | undefined> {
  const run = await getScriptRun(runId, sessionId);
  if (!run || run.kind !== "credential") return undefined;
  return {
    ...credentialSummary(summarizeScriptRun(run)),
    outputTail: await readLogTail(run.logPath, LOG_TAIL_BYTES),
  };
}

export async function listCredentialRuns(
  sessionId: string,
): Promise<CredentialRunSummary[]> {
  return (await listScriptRuns(sessionId))
    .filter((run) => run.kind === "credential")
    .map(credentialSummary);
}

export async function stopCredentialRun(
  runId: string,
  sessionId: string,
): Promise<{ run: CredentialRunSummary } | { error: string }> {
  const run = await getScriptRun(runId, sessionId);
  if (!run || run.kind !== "credential")
    return { error: "no run with that id in this session" };
  const result = await stopScriptRun(runId, sessionId);
  if ("error" in result) return result;
  return { run: credentialSummary(result.run) };
}

/** Resolves once the run has ended and released its grants. */
export async function waitForCredentialRun(
  runId: string,
  timeoutMs: number,
): Promise<CredentialRunSummary | undefined> {
  const { __waitForScriptRunForTest } = await import("./script-runs");
  const run = await __waitForScriptRunForTest(runId, timeoutMs);
  return run ? credentialSummary(summarizeScriptRun(run)) : undefined;
}

/** Close the run's grants and record how it went. */
async function settle(run: ScriptRunRecord): Promise<void> {
  const relays = run.relays ?? [];
  await settleRunGrants(
    run.id,
    relays.map((r) => ({ grantId: r.grantId, calls: r.calls })),
    { interrupted: run.state === "lost" },
  ).catch((error) =>
    console.error("[keychain] failed to settle a run's grants:", error),
  );
  const only = relays.length === 1 ? relays[0] : undefined;
  depsOf(run.id).audit({
    kind: "keychain_run_ended",
    run_id: run.id,
    ...(only ? { grant_id: only.grantId } : {}),
    session_id: run.sessionId,
    state: run.state,
    exit_code: run.exitCode ?? null,
    calls: relays.reduce((sum, r) => sum + r.calls, 0),
    denied: relays.reduce((sum, r) => sum + r.denied, 0),
    ...(relays.length > 1
      ? {
          credentials: relays.map((r) => ({
            service: r.service,
            grant_id: r.grantId,
            calls: r.calls,
            denied: r.denied,
          })),
        }
      : {}),
  });
  runDeps.delete(run.id);
}

function refuse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

type Run = ScriptRunRecord;
type Leg = ScriptRelayInfo;

/** One relayed request of a run. script-runs.ts has already checked the
 *  URL's secret for this credential and that the run is live; `rest` is the
 *  path after the secret. */
async function relay(
  run: Run,
  leg: Leg,
  rest: string,
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);

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
      setTimeout(() => void endScriptRun(run.id, "revoked"), 0);
    return deny(run, leg, method, target.pathname, use.status, use.error);
  }
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
    res = await depsOf(run.id).fetchImpl(target, {
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
  depsOf(run.id).audit({
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
  depsOf(run.id).audit({
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
