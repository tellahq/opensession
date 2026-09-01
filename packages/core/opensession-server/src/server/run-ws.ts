/**
 * run-ws — the WebSocket transport for sandboxed runs
 * (docs/self-hosting-sandboxes.md). Remote sandboxes can't share unix sockets with this host, so
 * both host-to-opensession channels get an outbound-dial WS mode: the sandbox
 * dials OUT to opensession (which already listens on the Tailscale bind), never
 * the other way around.
 *
 *  - `/run-ws/<hostId>` — the run host's event stream. The host
 *    entry (src/runner-host/host.ts, OPENSESSION_RUN_WS_URL) dials it and speaks the
 *    exact NDJSON protocol, one JSON message per text frame. Accepted sockets
 *    are bridged into the SAME HostHandle machinery as the unix-socket path:
 *    `runWsConnector(hostId)` implements host-client's HostConnector, so
 *    reconnect tolerance, respawn-to-resume, ask proxying and host-registry
 *    steer/cancel all carry over untouched. Host frames carry a monotonic
 *    `seq`; this side acks its consumed watermark (on open + periodically)
 *    and dedupes by it, so a reconnecting host replays the disconnect window
 *    without double-applying (see ws-buffer.ts; the unix-socket path stays
 *    live-only).
 *  - `/rpc-ws?host=<hostId>` — the opensession-* MCP proxy channel.
 *    mcp-proxy.ts (OPENSESSION_RPC_WS_URL) dials it; each request frame
 *    `{id, path, token, server, tool?, args?}` goes through the same
 *    dispatchRunRpc core as the unix RPC socket and answers with
 *    `{id, status, body}`.
 *
 * Auth: per-run bearer tokens, validated BEFORE the upgrade with a
 * constant-time compare — and BOTH routes validate against the WS token
 * registry only (spec.wsToken, minted at launch and registered by the
 * provider's launcher keyed by hostId). rpc-ws used to accept ANY registered
 * run-rpc token, which exposed the interactive-MCP RPC to the whole tailnet
 * for every proxied run — systemd hosts, codex, pi — even on a
 * sandbox-less deployment where nothing should dial back at all. Now the
 * upgrade requires the run's hostId + wsToken (only ws-transport launches
 * register one; the global run-rpc token set stays unix-socket-local), while
 * each FRAME still carries the rpc token that dispatchRunRpc resolves to the
 * run's {sessionId, user}. `{t:"ping"}` keepalive frames are answered here
 * with `{t:"pong"}` so quiet connections survive idle timers.
 *
 * Wired into the EXISTING Bun.serve in opensession.ts (fetch route + early
 * dispatch in the websocket open/message/close handlers). Those handlers are
 * captured at first server creation and survive hot reloads, so everything
 * here routes through a globalThis-parked impl table — an edit to this module
 * hot-applies through the old captured wrappers. First wire-up still needs a
 * real restart (routes don't hot-apply at all — CLAUDE.md).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { audit } from "./audit";
import { dispatchRunRpc, timingSafeEqStr } from "./run-rpc";
import type {
  HostConnection,
  HostConnectionHandlers,
  HostConnector,
} from "./host-client";
import { stateDir } from "./paths";

const g = globalThis as any;

/** The one Bun.serve capability this module needs; keeps the signature
 *  compatible with any Server<T> instantiation (opensession.ts's WSClientData
 *  server AND the verify suites' scratch servers). */
type UpgradableServer = {
  upgrade(req: Request, opts?: { data?: unknown }): boolean;
};

/** hostId → expected bearer for the run's dial-back. */
const wsTokens: Map<string, string> = (g.__runWsTokens ??= new Map());

// ── Seq/ack state (host-side buffering + replay; ws-buffer.ts is the peer) ───
// Host→server frames carry a monotonic `seq` (WS transport only). `seq` here
// is the CONSUMED watermark — the highest seq delivered to an attached
// HostHandle (frames parked in a pre-attach buffer don't count until flushed),
// which is exactly what we ack: the host keeps everything above it and
// replays it on reconnect; anything at/under it is a duplicate and dropped.
// `epoch` identifies this registration's watermark across sockets — it
// survives `bun --hot` (globalThis) but not a real restart, so a restarted
// opensession (whose consumers may have already applied pre-restart frames)
// presents a fresh epoch and the host skips the replay (old live-only
// semantics; hello/meta.done/journal cover catch-up).

interface HostSeqRec {
  epoch: string;
  seq: number;
  unacked: number;
  lastAckAt: number;
}

/** hostId → consumed-watermark record (lives for the registration, not the socket). */
const wsSeqs: Map<string, HostSeqRec> = (g.__runWsSeqs ??= new Map());

const ACK_EVERY_N_FRAMES = 50;
const ACK_MIN_INTERVAL_MS = 2_000;

function seqRecFor(hostId: string): HostSeqRec {
  let rec = wsSeqs.get(hostId);
  if (!rec) {
    rec = { epoch: crypto.randomUUID(), seq: 0, unacked: 0, lastAckAt: 0 };
    wsSeqs.set(hostId, rec);
  }
  return rec;
}

function sendAck(st: RunWsState): void {
  const rec = seqRecFor(st.hostId);
  rec.unacked = 0;
  rec.lastAckAt = Date.now();
  try {
    st.ws.send(JSON.stringify({ t: "ack", seq: rec.seq, epoch: rec.epoch }));
  } catch {}
}

interface RunWsState {
  ws: any; // ServerWebSocket
  hostId: string;
  /** Frames that arrived before a HostHandle attached (e.g. the hello a fresh
   *  host sends immediately after dialing). Flushed on attach. */
  buffer: unknown[];
  consumer: HostConnectionHandlers | null;
  closed: boolean;
}

/** hostId → the live dialed-in connection (at most one per host; a redial
 *  replaces the previous socket, mirroring host.ts's single-client rule). */
const wsConns: Map<string, RunWsState> = (g.__runWsConns ??= new Map());

/** hostId → connect() calls parked until the host's dial-back arrives.
 *  Resolution is EVENT-driven (wsOpen fires these) — never timer-polled: a
 *  failed `bun --hot` reload kills setTimeout delivery process-wide (see the
 *  tripwire at the bottom), which is exactly what parked the 2026-07-09
 *  launches (bks-019f46e9, bks-019f4729) — connectWithWait's 300ms poll died
 *  and the consumer never attached even though the host had dialed in. */
const wsDialWaiters: Map<
  string,
  Set<(err?: Error) => void>
> = (g.__runWsDialWaiters ??= new Map());

/** Park until the host dials in (resolved by wsOpen), the registration is
 *  dropped (rejected), or `timeoutMs` passes (rejected — but only in a
 *  process whose timers still work; the dial-in event needs no timer). */
function waitForDialIn(hostId: string, timeoutMs: number): Promise<void> {
  if (!wsTokens.get(hostId)) {
    // Nothing is registered to dial — fail fast instead of parking forever.
    return Promise.reject(
      new Error(`no run-ws token registered for ${hostId}`),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const set = wsDialWaiters.get(hostId) ?? new Set();
    wsDialWaiters.set(hostId, set);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter = (err?: Error) => {
      if (timer !== undefined) clearTimeout(timer);
      set.delete(waiter);
      if (set.size === 0 && wsDialWaiters.get(hostId) === set)
        wsDialWaiters.delete(hostId);
      if (err) reject(err);
      else resolve();
    };
    set.add(waiter);
    timer = setTimeout(
      () => waiter(new Error(`no live run-ws connection for ${hostId} yet`)),
      timeoutMs,
    );
    (timer as { unref?: () => void }).unref?.();
  });
}

function fireDialWaiters(hostId: string, err?: Error): void {
  const set = wsDialWaiters.get(hostId);
  if (!set) return;
  wsDialWaiters.delete(hostId);
  for (const w of [...set]) w(err);
}

/** WS client data marker; opensession.ts's handlers early-return on it. */
export interface SandboxWsData {
  sandboxWs: "run-host" | "rpc";
  hostId?: string;
}

// ── Token registry (launchers mint + register; dispose unregisters) ──────────

export function registerRunWsHost(hostId: string, token: string): void {
  wsTokens.set(hostId, token);
}

export function unregisterRunWsHost(hostId: string): void {
  wsTokens.delete(hostId);
  wsSeqs.delete(hostId);
  fireDialWaiters(hostId, new Error(`run-ws host ${hostId} unregistered`));
  const st = wsConns.get(hostId);
  if (st) {
    wsConns.delete(hostId);
    st.closed = true;
    try {
      st.ws.close();
    } catch {}
  }
}

// ── Upgrade handling (called from opensession.ts's fetch, and verify suites) ───

function bearerFrom(req: Request): string {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  // Fallback for dialers that can't set headers.
  try {
    return new URL(req.url).searchParams.get("token") || "";
  } catch {
    return "";
  }
}

function handleUpgrade(
  req: Request,
  server: UpgradableServer,
  path: string,
): Response | undefined {
  if (path === "/rpc-ws") {
    // WS-transport runs ONLY: authenticate with the run's hostId + wsToken
    // (the same registry as the run-ws route). A plain run-rpc token — which
    // every proxied run has, sandboxed or not — is deliberately NOT accepted
    // here; that registry stays local to the unix RPC socket.
    let hostId = "";
    try {
      hostId = new URL(req.url).searchParams.get("host") || "";
    } catch {}
    const expected = hostId ? wsTokens.get(hostId) : undefined;
    const presented = bearerFrom(req);
    if (!expected || !presented || !timingSafeEqStr(expected, presented)) {
      return new Response("unauthorized", { status: 403 });
    }
    const data: SandboxWsData = { sandboxWs: "rpc" };
    if (!server.upgrade(req, { data })) {
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return undefined;
  }
  const m = path.match(/^\/run-ws\/([A-Za-z0-9_.-]+)$/);
  if (!m) return new Response("not found", { status: 404 });
  const hostId = m[1];
  const expected = wsTokens.get(hostId);
  const presented = bearerFrom(req);
  if (!expected || !presented || !timingSafeEqStr(expected, presented)) {
    return new Response("unauthorized", { status: 403 });
  }
  const data: SandboxWsData = { sandboxWs: "run-host", hostId };
  if (!server.upgrade(req, { data })) {
    return new Response("WebSocket upgrade failed", { status: 400 });
  }
  return undefined;
}

// ── WS event dispatch (early-return hooks for opensession.ts's handlers) ───────

function wsOpen(ws: any): boolean {
  const data = ws.data as Partial<SandboxWsData> | undefined;
  if (data?.sandboxWs === "run-host" && data.hostId) {
    const prev = wsConns.get(data.hostId);
    if (prev && prev.ws !== ws) {
      // Redial replaces the previous socket (host.ts keeps only one client).
      prev.closed = true;
      try {
        prev.ws.close();
      } catch {}
    }
    const st: RunWsState = {
      ws,
      hostId: data.hostId,
      buffer: [],
      consumer: null,
      closed: false,
    };
    (ws as any).__runWsState = st;
    wsConns.set(data.hostId, st);
    // Hello-ack: tell the (re)dialing host our consumed watermark + epoch so
    // it knows exactly what to replay (ws-buffer.ts replayStartFor).
    sendAck(st);
    console.log(`[run-ws] host ${data.hostId.slice(0, 11)} dialed in`);
    // Wake connect() calls parked on this dial-in — the event IS the attach
    // trigger (no polling; see wsDialWaiters).
    fireDialWaiters(data.hostId);
    return true;
  }
  if (data?.sandboxWs === "rpc") return true;
  return false;
}

function wsMessage(ws: any, message: string | Buffer): boolean {
  const data = ws.data as Partial<SandboxWsData> | undefined;
  if (data?.sandboxWs === "run-host") {
    const st: RunWsState | undefined = (ws as any).__runWsState;
    if (!st) return true;
    let msg: any;
    try {
      msg = JSON.parse(String(message));
    } catch {
      console.warn(`[run-ws] dropping malformed frame from ${st.hostId}`);
      return true;
    }
    if (msg?.t === "ping") {
      // Answer keepalives here — they must work even while no HostHandle is
      // attached (opensession mid-reattach). Piggyback an ack: on a quiet link
      // this is the periodic watermark refresh that lets the host trim its
      // replay buffer.
      try {
        ws.send('{"t":"pong"}');
      } catch {}
      sendAck(st);
      return true;
    }
    if (msg?.t === "gap") {
      // The host's replay buffer overflowed while we were unreachable — those
      // frames are gone from the stream (the transcript jsonl still has them).
      console.warn(
        `[run-ws] host ${st.hostId.slice(0, 11)} lost frames ${msg.from}..${msg.to} to buffer overflow`,
      );
      return true;
    }
    const rec = seqRecFor(st.hostId);
    if (typeof msg?.seq === "number" && msg.seq <= rec.seq) {
      return true; // replay overlap — already consumed, never double-apply
    }
    if (st.consumer) {
      st.consumer.onMsg(msg);
      if (typeof msg?.seq === "number") {
        rec.seq = msg.seq;
        if (
          ++rec.unacked >= ACK_EVERY_N_FRAMES ||
          Date.now() - rec.lastAckAt >= ACK_MIN_INTERVAL_MS
        ) {
          sendAck(st);
        }
      }
    } else {
      // No HostHandle yet — park it. Deliberately NOT counted as consumed:
      // if this socket dies before a consumer attaches, the un-acked frames
      // are replayed on the next dial instead of vanishing with the buffer.
      // Parking is normal for a beat after dial-in; a TERMINAL frame parking
      // is the signature of a stuck launch (2026-07-09: a failed --hot reload
      // killed setTimeout process-wide, so connectWithWait's poll loop parked
      // forever while the whole run streamed into this buffer — see the
      // timer-poisoning tripwire below) — log those so it's never silent.
      if (msg?.t === "end") {
        console.warn(
          `[run-ws] host ${st.hostId.slice(0, 11)} streamed its terminal frame with no consumer attached — ` +
            "the launch path may be stuck; frames stay parked for a late attach",
        );
      }
      st.buffer.push(msg);
    }
    return true;
  }
  if (data?.sandboxWs === "rpc") {
    void handleRpcFrame(ws, message);
    return true;
  }
  return false;
}

function wsClose(ws: any): boolean {
  const data = ws.data as Partial<SandboxWsData> | undefined;
  if (data?.sandboxWs === "run-host") {
    const st: RunWsState | undefined = (ws as any).__runWsState;
    if (st && !st.closed) {
      st.closed = true;
      if (wsConns.get(st.hostId) === st) wsConns.delete(st.hostId);
      st.consumer?.onClose();
    }
    return true;
  }
  return data?.sandboxWs === "rpc";
}

async function handleRpcFrame(
  ws: any,
  message: string | Buffer,
): Promise<void> {
  let frame: any;
  try {
    frame = JSON.parse(String(message));
  } catch {
    return;
  }
  if (frame?.t === "ping") {
    try {
      ws.send('{"t":"pong"}');
    } catch {}
    return;
  }
  const id = String(frame?.id || "");
  if (!id) return;
  const reply = (status: number, body: unknown) => {
    try {
      ws.send(JSON.stringify({ id, status, body }));
    } catch {}
  };
  try {
    // Same core as the unix RPC socket — token re-validated per frame.
    const d = await dispatchRunRpc(String(frame?.path || ""), frame);
    if (d.kind === "immediate") reply(d.status, d.body);
    else reply(200, await d.done); // WS needs no heartbeat wrapper — pings keep the socket alive
  } catch (e: any) {
    reply(500, { error: e?.message || String(e) });
  }
}

// ── HostConnector over a dialed-in run-ws connection ──────────────────────────

function makeRunWsConnector(hostId: string): HostConnector {
  return {
    async connect(handlers: HostConnectionHandlers): Promise<HostConnection> {
      let st = wsConns.get(hostId);
      if (!st || st.closed) {
        // Wait for the dial-in EVENT instead of failing so the caller polls:
        // host-client's retry cadence is timer-driven, and a failed --hot
        // reload kills timers process-wide — the attach chain must be able to
        // ride the dial-back event alone. Bounded (8s) for healthy processes
        // so the crashed-host reconnect loop still gets its rejection.
        await waitForDialIn(hostId, 8_000);
        st = wsConns.get(hostId);
        if (!st || st.closed) {
          throw new Error(`no live run-ws connection for ${hostId} yet`);
        }
      }
      st.consumer = handlers;
      if (st.buffer.length) {
        console.log(
          `[run-ws] consumer attached for ${hostId.slice(0, 11)}, flushing ${st.buffer.length} parked frame(s)`,
        );
      }
      // Flushing the pre-attach buffer is the consumption moment — advance the
      // watermark now and ack it, so the host can trim its replay buffer.
      const rec = seqRecFor(hostId);
      let advanced = false;
      for (const m of st.buffer.splice(0)) {
        handlers.onMsg(m as any);
        const s = (m as any)?.seq;
        if (typeof s === "number" && s > rec.seq) {
          rec.seq = s;
          advanced = true;
        }
      }
      if (advanced) sendAck(st);
      return {
        send: (msg) => {
          if (st.closed) return false;
          try {
            // Bun's ServerWebSocket.send returns 0 when the socket is
            // closed/closing — report that as undeliverable so steers queue.
            return st.ws.send(JSON.stringify(msg)) !== 0;
          } catch {
            return false;
          }
        },
        close: () => {
          try {
            st.ws.close();
          } catch {}
        },
      };
    },
    dispose() {
      unregisterRunWsHost(hostId);
    },
  };
}

// ── Hot-reload indirection ────────────────────────────────────────────────────
// opensession.ts's Bun.serve handlers are captured once (the server object is
// reused across --hot reloads); they call the exported wrappers below, which
// resolve the freshest impl through globalThis on every call.

const impl = {
  handleUpgrade,
  wsOpen,
  wsMessage,
  wsClose,
  makeRunWsConnector,
};

g.__runWsImpl = impl;
type Impl = typeof impl;
const live = (): Impl => (g.__runWsImpl as Impl) ?? impl;

/** Route handler for /run-ws/:hostId and /rpc-ws.
 *  Returns undefined when the socket was upgraded. */
export function handleSandboxWsUpgrade(
  req: Request,
  server: UpgradableServer,
  path: string,
): Response | undefined {
  return live().handleUpgrade(req, server, path);
}

/** Early-dispatch hooks for the shared websocket handlers; true = handled. */
export function sandboxWsOpen(ws: any): boolean {
  return live().wsOpen(ws);
}
export function sandboxWsMessage(ws: any, message: string | Buffer): boolean {
  return live().wsMessage(ws, message);
}
export function sandboxWsClose(ws: any): boolean {
  return live().wsClose(ws);
}

/** HostConnector for a run whose host dials back over WS (spec.wsToken set). */
export function runWsConnector(hostId: string): HostConnector {
  return live().makeRunWsConnector(hostId);
}

// ── Test/verification helpers (conformance/verify suites) ─────────────────────

/** Is there a live dialed-in connection for this host right now? */
export function hasLiveRunWsConnection(hostId: string): boolean {
  const st = wsConns.get(hostId);
  return !!st && !st.closed;
}

/**
 * Force-close a host's live connection WITHOUT unregistering its token — the
 * host redials with backoff and replays unacked frames, exactly as after a
 * network drop. Used by the conformance suite's disconnect/replay check.
 */
export function dropRunWsConnection(hostId: string): boolean {
  const st = wsConns.get(hostId);
  if (!st || st.closed) return false;
  try {
    st.ws.close();
  } catch {}
  return true;
}

// ── Timer-poisoning tripwire ──────────────────────────────────────────────────
// Bun 1.3.14 can permanently lose setTimeout/setInterval delivery for this
// WHOLE process (originally reproduced through failed `bun --hot` reloads;
// the production unit no longer uses --hot). Network IO keeps working, so
// the process looks healthy while every timer-driven loop — schedulers, idle
// sweeps, shutdown drain, connect polls, SDK waitUntilStarted polls — is
// silently dead (that's what stalled bks-019f46e9 / bks-019f4729 and the
// daytona Shell tab). There is no in-process recovery; the only fix is a
// restart — so once poisoning is CONFIRMED we self-restart: exit the process
// and let systemd (Restart=always) boot a clean one. Detached engine servers
// survive the exit and the boot reattaches their runs (2026-07-11 incident:
// both stalled sessions reattached mid-turn with nothing lost), so the exit
// costs seconds of availability, not work.
//
// Detection can't use timers, so it rides events that still work: the fetch
// preamble calls timerPoisonRequestCheck() on every HTTP request. A stale stamp
// alone is only SUSPICION (a long synchronous stall also delays the stamp);
// confirmation is a zero-delay probe setTimeout — a live-but-delayed timer
// wheel fires it as soon as the loop frees, a poisoned one never does.

const POISON_STALE_MS = 20_000; // heartbeat stamps every 5s; 20s = 4 missed beats
const POISON_CONFIRM_MS = 3_000; // suspicion age before a silent probe convicts
// Host-wide starvation override: when the box is at runnable-task capacity
// (or beyond it — IO storms, swap thrash), the event loop stalls for 30s+
// with timers ALIVE, and the probe protocol above still convicts (2026-07-27:
// six false-positive self-restarts in 100 minutes, each reboot's IO making the
// next stall more likely). A restart cannot cure starvation, only worsen it —
// so under sustained load we hold conviction until the heartbeat has been stale
// for STARVATION_HOLD_MS (true poisoning survives that; a starved-but-alive
// loop stamps the heartbeat long before it).
const STARVATION_LOAD_PER_CORE = 1;
const STARVATION_HOLD_MS = 300_000;

export function shouldDeferTimerPoisonForStarvation(
  load1: number,
  cores: number,
  staleMs: number,
): boolean {
  return (
    load1 >= Math.max(1, cores) * STARVATION_LOAD_PER_CORE &&
    staleMs < STARVATION_HOLD_MS
  );
}

/**
 * Per-request timer-poisoning check (called from the Bun.serve fetch preamble
 * — O(1), no IO on the healthy path). Two-phase so a long synchronous stall
 * can't cause a false restart: first stale sighting schedules a zero-delay
 * probe and returns; if a LATER request (≥POISON_CONFIRM_MS after) finds the
 * probe never fired, timers are provably dead and we escalate.
 */
export function timerPoisonRequestCheck(): void {
  const hb = g.__timerPoisonHeartbeat as
    | { at: number; armed: boolean }
    | undefined;
  if (!hb?.armed || g.__timerPoisonExiting || g.__timerPoisonHalted) return;
  if (Date.now() - hb.at < POISON_STALE_MS) {
    g.__timerPoisonSuspicion = undefined;
    return;
  }
  let s = g.__timerPoisonSuspicion as
    | { since: number; probeFired: boolean }
    | undefined;
  if (!s) {
    s = g.__timerPoisonSuspicion = { since: Date.now(), probeFired: false };
    const captured = s;
    try {
      setTimeout(() => {
        captured.probeFired = true;
      }, 0);
    } catch {}
    return;
  }
  if (s.probeFired) {
    // Timers were merely delayed (blocked event loop), not dead.
    g.__timerPoisonSuspicion = undefined;
    return;
  }
  if (Date.now() - s.since >= POISON_CONFIRM_MS)
    escalateTimerPoison(Date.now() - hb.at);
}

function escalateTimerPoison(staleMs: number): void {
  const load1 = loadavg()[0];
  const cores = cpus().length || 1;
  if (shouldDeferTimerPoisonForStarvation(load1, cores, staleMs)) {
    const lastLog = (g.__timerPoisonStarvedLogAt as number | undefined) ?? 0;
    if (Date.now() - lastLog > 60_000) {
      g.__timerPoisonStarvedLogAt = Date.now();
      audit({
        msg: "timer_poison_deferred_starved",
        staleSeconds: Math.round(staleMs / 1000),
        load1: Math.round(load1),
        cores,
      });
      console.error(
        `[run-ws] timer heartbeat stale ${Math.round(staleMs / 1000)}s but host load is ` +
          `${load1.toFixed(0)} on ${cores} cores — treating as starvation, not poisoning. ` +
          `Holding self-restart unless staleness reaches ${STARVATION_HOLD_MS / 1000}s.`,
      );
    }
    // Drop the suspicion so the next sighting re-probes with a fresh timer —
    // a starved loop that frees up clears itself instead of convicting on a
    // minutes-old probe.
    g.__timerPoisonSuspicion = undefined;
    return;
  }
  g.__timersPoisonedAt ??= new Date().toISOString();
  // Restart-loop guard: a persistent runtime failure can poison FRESH boots
  // too, so unbounded auto-exits would flap forever. Track recent auto-exits
  // in a state file; after 3 in 30 minutes stop exiting and just scream — at
  // that point the tree needs a human (or a fixing agent), not a restart.
  const guardPath = stateDir("timer-poison.json");
  let exits: string[] = [];
  try {
    exits = (JSON.parse(readFileSync(guardPath, "utf8")).exits ??
      []) as string[];
  } catch {}
  const cutoff = Date.now() - 30 * 60_000;
  exits = exits.filter((t) => Date.parse(t) > cutoff);
  if (exits.length >= 3) {
    if (!g.__timerPoisonHalted) {
      g.__timerPoisonHalted = true;
      audit({
        msg: "timer_poison_halted",
        staleSeconds: Math.round(staleMs / 1000),
        recentExits: exits,
        load1: Math.round(load1),
        cores,
      });
      console.error(
        "[run-ws] TIMERS ARE DEAD and 3 auto-restarts in 30m did not cure it. NOT exiting again; " +
          "inspect the preceding runtime errors, then systemctl restart opensession.",
      );
    }
    return;
  }
  exits.push(new Date().toISOString());
  try {
    writeFileSync(guardPath, JSON.stringify({ exits }));
  } catch {}
  g.__timerPoisonExiting = true;
  audit({
    msg: "timer_poison_restart",
    staleSeconds: Math.round(staleMs / 1000),
    autoExitsLast30m: exits.length,
    load1: Math.round(load1),
    cores,
  });
  console.error(
    `[run-ws] TIMERS ARE DEAD — heartbeat stale ${Math.round(staleMs / 1000)}s and a probe timer never ` +
      "fired. Timer delivery is dead process-wide. Self-restarting: " +
      "exiting now; systemd (Restart=always) boots a clean process, detached engine runs reattach.",
  );
  const poisonExit = g.__poisonExit as (() => void) | undefined;
  if (poisonExit) {
    poisonExit(); // opensession.ts's gracefulShutdown in timers-dead mode (snapshot + exit)
  } else {
    process.exit(1);
  }
}

/**
 * Arm the timer-poison heartbeat: a 5s stamp whose staleness tells a later
 * request that this process's timers died (the bun --hot poisoning failure,
 * where every timer stops while HTTP keeps serving).
 *
 * Called from opensession.ts on every evaluation of the entry — including a
 * hot reload, which is when the staleness check below earns its keep. Not at
 * module scope: this file is on the routes import chain, so a script or test
 * would arm a heartbeat for a process that has no timers to watch.
 */
export function startTimerPoisonHeartbeat(): void {
  const hb = (g.__timerPoisonHeartbeat ??= { at: Date.now(), armed: false });
  if (hb.armed && Date.now() - hb.at > 15_000) {
    console.error(
      `[run-ws] timer heartbeat stale ${Math.round((Date.now() - hb.at) / 1000)}s — ` +
        "probing for timer poisoning (self-restart follows if confirmed).",
    );
    timerPoisonRequestCheck(); // seeds the suspicion + probe; next request confirms
    hb.armed = false; // re-arm below; if timers are actually alive the interval resumes stamping
  }
  if (!hb.armed) {
    hb.armed = true;
    hb.at = Date.now();
    const t = setInterval(() => {
      hb.at = Date.now();
    }, 5_000);
    (t as { unref?: () => void }).unref?.();
  }
}
