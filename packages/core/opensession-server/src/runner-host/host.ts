/**
 * Run host — a standalone bun process that owns ONE agent run, so the run (and
 * its Claude/Codex CLI child) survives opensession restarts.
 *
 * Spawned by src/server/host-client.ts as a transient systemd unit (escaping
 * the opensession.service cgroup — see spawn there for the IMDS deny and env).
 * Usage: bun run src/runner-host/host.ts <host-dir>/spec.json
 *
 * The host serves a unix socket in its dir; opensession connects as a client and
 * gets live StreamEvents, ask requests (AskUserQuestion / Stripe confirms), and
 * the end signal. Steer/interrupt/cancel come back over the same socket. If no
 * client is attached (opensession restarting), the run keeps going: events are
 * simply not observed live (the transcript jsonl is the durable copy), asks
 * wait until a client reattaches, and the terminal state lands in meta.json so
 * a rebooting opensession can finish the bookkeeping even if this process is gone.
 *
 * The run journal is redirected to a per-host file (OPENSESSION_RUN_JOURNAL) so
 * concurrent hosts never read-modify-write the shared active-runs.json.
 */

import { existsSync, unlinkSync, writeFileSync } from "fs";
import { processIdentity } from "../server/process-identity";
import { dirname, resolve } from "path";

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: bun run host.ts <host-dir>/spec.json");
  process.exit(2);
}
const hostDir = dirname(resolve(specPath));
const projectedGithubAuthPath = process.env.OPENSESSION_GITHUB_RUN_AUTH_FILE;
const cleanupProjectedGithubAuth = () => {
  if (
    projectedGithubAuthPath &&
    dirname(resolve(projectedGithubAuthPath)) === hostDir
  ) {
    try {
      unlinkSync(projectedGithubAuthPath);
    } catch {}
  }
};
// Covers validation/import failures as well as the ordinary terminal path.
process.once("exit", cleanupProjectedGithubAuth);
// Publish process identity before reading the cancellation marker. A stopper
// can now close the startup race without broad process-name matching.
writeFileSync(
  `${hostDir}/startup.json`,
  JSON.stringify({
    ...processIdentity(),
    pid: process.pid,
    specPath: resolve(specPath),
    startedAt: new Date().toISOString(),
  }),
  { mode: 0o600 },
);
if (existsSync(`${hostDir}/cancelled`)) {
  cleanupProjectedGithubAuth();
  console.log(`[run-host] ${hostDir}: cancelled before startup`);
  process.exit(0);
}

// Must be set before claude-runner is evaluated — it resolves the journal path
// at module load. The transient unit sets it too; this is the belt-and-braces
// for manual/debug launches. (agent-runner is imported dynamically below so
// this assignment reliably happens first.)
// New name primary; keep the deprecated alias in sync for anything that
// still reads it (both point at this host's private journal).
process.env.OPENSESSION_RUN_JOURNAL ||=
  process.env.OPENSESSION_RUN_JOURNAL || `${hostDir}/journal.json`;
process.env.OPENSESSION_RUN_JOURNAL = process.env.OPENSESSION_RUN_JOURNAL;

const {
  runAgent,
  cancelAgentRun,
  steerAgentRun,
  retractAgentSteer,
  interruptAndSteerAgentRun,
} = await import("../server/agent-runner");
const { shouldPersistModelSwitch } = await import("../server/run-events");
const { readFileSync } = await import("fs");
const { writeJsonAtomic } = await import("../server/shared/atomic-write");
const {
  ndjsonReader,
  HOST_SOCK_NAME,
  HOST_META_NAME,
  MCP_PROXY_ENTRY,
  mcpProxyArgv,
  rpcSocketPath,
} = await import("./protocol");
const { WsFrameBuffer, replayStartFor } = await import("./ws-buffer");
const { OPENSESSION_SESSIONS_DIR } = await import("../server/paths");

type RunHostSpec = import("./protocol").RunHostSpec;
type RunHostMeta = import("./protocol").RunHostMeta;
type HostToClientMsg = import("./protocol").HostToClientMsg;
type ClientToHostMsg = import("./protocol").ClientToHostMsg;
type AskResult = import("./protocol").AskResult;
type StreamEvent = import("../server/run-events").StreamEvent;

const specBytes = readFileSync(specPath);
const expectedSpecHash = process.env.OPENSESSION_RUN_SPEC_HASH;
if (expectedSpecHash) {
  const actualSpecHash = new Bun.CryptoHasher("sha256")
    .update(specBytes)
    .digest("hex");
  if (actualSpecHash !== expectedSpecHash) {
    console.error("run host spec changed after executor validation");
    process.exit(2);
  }
}
const spec: RunHostSpec = JSON.parse(specBytes.toString("utf-8"));
const sockPath = `${hostDir}/${HOST_SOCK_NAME}`;
const metaPath = `${hostDir}/${HOST_META_NAME}`;

const meta: RunHostMeta = {
  hostId: spec.hostId,
  ...processIdentity(),
  pid: process.pid,
  osSessionId: spec.osSessionId,
  startedAt: new Date().toISOString(),
  selectedModel: spec.selectedModel ?? spec.model,
  effectiveModel: spec.model,
  transientFallback: spec.transientFallback,
};
const saveMeta = () => writeJsonAtomic(metaPath, meta);
saveMeta();

const log = (...args: unknown[]) =>
  console.log(`[host ${spec.hostId.slice(0, 11)}]`, ...args);

// ── Transport (single client: the opensession process) ─────────────────────────
// Two modes, same protocol:
//  - default: serve a unix socket in the run dir; opensession dials in (NDJSON).
//  - OPENSESSION_RUN_WS_URL set: DIAL OUT to opensession's /run-ws/<hostId>
//    WebSocket route (one JSON message per text frame) — for sandboxes that
//    can't share a unix socket with the host (remote providers; docker
//    dogfoods it). Reconnects with backoff on drop, mirroring the socket
//    path's tolerance: the run never stops, events are simply unobserved
//    until opensession (re)attaches.
//
// FRAME-LOSS WINDOW:
//  - unix-socket mode (deliberately unchanged): the stream is live-only — no
//    buffering or replay. `send()` drops messages while no client is attached
//    and a reconnect resumes from "now"; `hello` carries the catch-up state
//    (engine session id, pending asks, terminal event), the transcript jsonl
//    is the durable copy of everything else, and meta.done + the journal
//    cover a run that FINISHES while disconnected. Fine there: for docker
//    bind-mode the transcript is host-visible anyway.
//  - WS mode: outbound frames now carry a monotonic seq and sit in a bounded
//    ring buffer (ws-buffer.ts: 5k frames / 5MB) until opensession acks its
//    consumed watermark; a reconnect replays everything after the ack, and
//    the server dedupes by seq — so frames emitted during a disconnect DO
//    reach the live viewer once the link is back. Remaining edges: (a) ring
//    overflow while disconnected drops the oldest frames — the replay then
//    reports a `gap` and the server logs it (transcript still has it all);
//    (b) a full opensession RESTART mints a new server epoch, so pre-restart
//    frames are not replayed (they may already have been applied) — the old
//    hello/meta.done/journal catch-up covers that case, exactly as before.

const RUN_WS_URL = process.env.OPENSESSION_RUN_WS_URL || "";
const RUN_WS_TOKEN = process.env.OPENSESSION_RUN_WS_TOKEN || "";

/** The currently attached opensession, whichever transport carried it. */
let client: {
  write: (line: string) => void;
  drain?: () => void;
  raw: unknown;
} | null = null;
let ended = false;
let exiting = false; // stops the WS redial loop once we're done
let terminal: StreamEvent | undefined;
let shutdownAcked: (() => void) | null = null;

/** WS mode's sequenced sender (buffer + replay); null on the socket path. */
let wsSequencedSend: ((msg: HostToClientMsg) => void) | null = null;

const pendingAsks = new Map<
  string,
  { input: Record<string, unknown>; resolve: (r: AskResult) => void }
>();

// ── Transcript relay (in-process engines: pi) ────────────────────────────────
// Engine drivers that persist transcript entries in-process consult the
// forwarder seam (src/server/transcript-forward.ts). Registered here, it
// turns every append into a `transcript` frame so the SERVER stays the
// store's only writer. WS mode: frames ride the sequenced ring buffer and
// replay after a reconnect like any event frame. Socket mode is live-only,
// so a bounded history (transcript-relay.ts) is re-sent after every
// (re)attach; lines carry stable uuids and upsert server-side, so
// re-delivery is exact.
const { TranscriptRelay } = await import("./transcript-relay");
const { SocketWriteQueue } = await import("./socket-write-queue");
const transcriptRelay = new TranscriptRelay();
{
  const { setTranscriptForwarder } =
    await import("../server/transcript-forward");
  let warnedOverflow = false;
  setTranscriptForwarder((engineSessionId, lines) => {
    if (!transcriptRelay.record(engineSessionId, lines) && !warnedOverflow) {
      warnedOverflow = true;
      log(
        "transcript history exceeded its byte budget; reattach resend will be partial (live frames unaffected)",
      );
    }
    send({ t: "transcript", engineSessionId, lines });
  });
}

function send(msg: HostToClientMsg): void {
  // hello/ping are per-connection transport chatter — never sequenced,
  // never replayed; everything else goes through the WS buffer in WS mode.
  if (wsSequencedSend && msg.t !== "hello" && msg.t !== "ping") {
    wsSequencedSend(msg);
    return;
  }
  if (!client) return;
  try {
    client.write(JSON.stringify(msg) + "\n");
  } catch (e) {
    log("send failed:", e);
  }
}

function sendHello(): void {
  send({
    t: "hello",
    hostId: spec.hostId,
    pid: process.pid,
    osSessionId: spec.osSessionId,
    engineSessionId: meta.engineSessionId,
    state: ended ? "ended" : "running",
    pendingAsks: [...pendingAsks.entries()].map(([askId, a]) => ({
      askId,
      input: a.input,
    })),
    selectedModel: meta.selectedModel,
    effectiveModel: meta.effectiveModel,
    transientFallback: meta.transientFallback,
    done: ended ? terminal : undefined,
  });
  // Socket mode is live-only: re-send the transcript history so a
  // reattaching server upserts anything it missed while detached. The marker
  // is the terminal fence: an ended hello cannot close the connection before
  // these replay frames have been consumed.
  if (!RUN_WS_URL) {
    for (const batch of transcriptRelay.replay())
      send({ t: "transcript", ...batch });
    send({ t: "catchup_complete" });
  }
}

function handleClientMsg(msg: ClientToHostMsg): void {
  switch (msg.t) {
    case "ask_answer": {
      const ask = pendingAsks.get(msg.askId);
      if (ask) {
        pendingAsks.delete(msg.askId);
        ask.resolve(msg.result);
      }
      break;
    }
    case "steer": {
      // Attachments ride the steer into the live turn (pi's session.steer
      // takes image parts). A bounce carries the text alone on purpose: the
      // server matches its steer receipt by text and re-queues the ORIGINAL
      // item, images included.
      if (
        !steerAgentRun(
          [spec.osSessionId, meta.engineSessionId],
          msg.text,
          msg.images,

          msg.steerId,
        )
      ) {
        // Too late (run finishing) or backend can't steer — bounce it back so
        // opensession queues it instead of the message evaporating.
        send({ t: "steer_failed", text: msg.text });
      }
      break;
    }
    case "retract_steer": {
      void retractAgentSteer(
        [spec.osSessionId, meta.engineSessionId],
        msg.steerId,
      ).then((retracted) => {
        send({
          t: "steer_retracted",
          requestId: msg.requestId,
          steerId: msg.steerId,
          retracted,
        });
      });
      break;
    }
    case "interrupt_steer": {
      if (
        !interruptAndSteerAgentRun(
          [spec.osSessionId, meta.engineSessionId],
          msg.text,
          msg.images,
        ) &&
        !steerAgentRun(
          [spec.osSessionId, meta.engineSessionId],
          msg.text,
          msg.images,
        )
      ) {
        send({ t: "steer_failed", text: msg.text });
      }
      break;
    }
    case "cancel": {
      log("cancel requested");
      void cancelAgentRun(spec.osSessionId, meta.engineSessionId);
      break;
    }
    case "shutdown": {
      shutdownAcked?.();
      break;
    }
    case "pong": {
      break; // WS keepalive answer — nothing to do
    }
  }
}

if (RUN_WS_URL) {
  // ── WS mode: dial out to opensession and keep redialing until we exit ────────
  // Outbound frames are sequenced + ring-buffered (ws-buffer.ts) and replayed
  // after the server's consumed-watermark ack on every (re)connect — see the
  // FRAME-LOSS WINDOW note above for the exact semantics and remaining edges.
  const buf = new WsFrameBuffer();
  let lastEpoch: string | null = null; // server-side seq record we last streamed to
  let streaming = false; // current socket finished its ack handshake + replay
  let liveSock: WebSocket | null = null;
  wsSequencedSend = (msg) => {
    // Always buffered (that's the replay source); only written through once
    // the handshake settled, so replay order is preserved.
    const line = buf.stamp(msg as unknown as Record<string, unknown>);
    if (streaming && liveSock?.readyState === WebSocket.OPEN) {
      try {
        liveSock.send(line);
      } catch (e) {
        log("ws send failed (frame stays buffered):", e);
      }
    }
  };
  let backoff = 500;
  const redial = (): void => {
    if (exiting) return;
    setTimeout(dialWs, backoff);
    backoff = Math.min(backoff * 2, 5_000);
  };
  const dialWs = (): void => {
    if (exiting) return;
    let sock: WebSocket;
    try {
      // Bun extension: custom headers on the client handshake.
      sock = new WebSocket(RUN_WS_URL, {
        headers: { authorization: `Bearer ${RUN_WS_TOKEN}` },
      } as unknown as string[]);
    } catch (e) {
      log("ws dial failed:", e);
      redial();
      return;
    }
    let openSeq = 0;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    /** Replay everything after `after`, then open the live tap. A fresh server
     *  epoch has no safe event watermark, so recover its idempotent transcript
     *  projection separately from the bounded transcript history. */
    const beginStream = (after: number, freshServer: boolean): void => {
      const { gap, lines } = buf.replayFrom(after);
      try {
        if (freshServer) {
          for (const batch of transcriptRelay.replay()) {
            sock.send(JSON.stringify({ t: "transcript", ...batch }));
          }
        }
        if (gap) {
          log(
            `replay gap: frames ${gap.from}..${gap.to} were dropped (buffer overflow)`,
          );
          sock.send(JSON.stringify({ t: "gap", ...gap }));
        }
        for (const line of lines) sock.send(line);
        // Connection-specific and deliberately unsequenced: it fences both
        // transcript catch-up and the sequenced replay from this handshake.
        sock.send(JSON.stringify({ t: "catchup_complete" }));
      } catch (e) {
        log("ws replay failed (frames stay buffered):", e);
      }
      buf.ack(after); // the watermark below `after` will never be replayed again
      streaming = true;
      if (lines.length)
        log(`replayed ${lines.length} frame(s) after seq ${after}`);
    };
    sock.onopen = () => {
      backoff = 500;
      liveSock = sock;
      streaming = false;
      client = { write: (line) => sock.send(line), raw: sock };
      log("opensession attached (ws)");
      sendHello();
      openSeq = buf.lastSeq;
      // A pre-ack opensession never acks: fall back to live-only streaming from
      // this connection onward (the old semantics) so mixed versions still run.
      ackTimer = setTimeout(() => beginStream(openSeq, true), 3_000);
    };
    sock.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch (e) {
        log("dropping malformed ws message:", e);
        return;
      }
      if (msg?.t === "ack") {
        const ack = {
          seq: Number(msg.seq) || 0,
          epoch: typeof msg.epoch === "string" ? msg.epoch : undefined,
        };
        if (!streaming) {
          if (ackTimer) clearTimeout(ackTimer);
          const freshServer = !ack.epoch || ack.epoch !== lastEpoch;
          const from = replayStartFor(ack, lastEpoch, openSeq);
          lastEpoch = ack.epoch ?? null;
          beginStream(from, freshServer);
        } else {
          buf.ack(ack.seq); // periodic watermark — release delivered frames
        }
        return;
      }
      handleClientMsg(msg);
    };
    sock.onclose = () => {
      if (ackTimer) clearTimeout(ackTimer);
      if (liveSock === sock) {
        liveSock = null;
        streaming = false;
      }
      if (client?.raw === sock) {
        client = null;
        log("opensession detached (ws)");
      }
      redial();
    };
    sock.onerror = () => {}; // onclose follows and owns the redial
  };
  dialWs();
  // Keepalive: WS paths have idle timers (Bun.serve's per-socket idleTimeout,
  // proxies); a long quiet tool call must not look like a dead peer.
  setInterval(() => send({ t: "ping" }), 30_000);
  log(`dialing ${RUN_WS_URL}`);
} else {
  if (existsSync(sockPath)) unlinkSync(sockPath); // stale socket from a crashed twin
  Bun.listen({
    unix: sockPath,
    socket: {
      open(socket) {
        if (client?.raw === socket) return;
        if (client) {
          try {
            (client.raw as any)?.end?.();
          } catch {}
        }
        const writer = new SocketWriteQueue(
          (data) => socket.write(data),
          32 * 1024 * 1024,
          () => {
            log("socket client stopped reading; closing for a clean replay");
            try {
              socket.end();
            } catch {}
          },
        );
        client = {
          write: (line) => writer.write(line),
          drain: () => writer.drain(),
          raw: socket,
        };
        (socket as any).__read = ndjsonReader(handleClientMsg, "host");
        log("opensession attached");
        sendHello();
      },
      data(socket, data) {
        (socket as any).__read?.(data);
      },
      drain(socket) {
        if (client?.raw === socket) client.drain?.();
      },
      close(socket) {
        if (client?.raw === socket) {
          client = null;
          log("opensession detached");
        }
      },
      error(socket, error) {
        log("socket error:", error);
      },
    },
  });
  log(`listening on ${sockPath}`);
}

// ── Ask proxy: block the run on a human answer delivered over the socket ─────
// No timeout here — the timeout/Slack-escalation policy lives in opensession's
// makeAskHandler. If opensession restarts mid-ask, the fresh process gets the
// pending asks in `hello` and re-runs its handler for each.
function onAskUser(input: Record<string, unknown>): Promise<AskResult> {
  const askId = crypto.randomUUID();
  return new Promise<AskResult>((resolvePromise) => {
    pendingAsks.set(askId, { input, resolve: resolvePromise });
    send({ t: "ask", askId, input });
  });
}

// ── mcp-proxy config for the opensession-* servers ───────────────────────────────
// Each named server becomes a stdio MCP proxy that forwards tools/list +
// tools/call to opensession over its RPC socket — so session-control/self-admin
// tools keep working across opensession restarts (calls retry while it's down).
function proxyMcpConfigs(): Record<string, unknown> | undefined {
  const names = spec.proxyMcpServers || [];
  if (!names.length || !spec.rpcToken) return undefined;
  // WS transport: the proxies dial opensession's /rpc-ws route instead
  // of the unix RPC socket (which isn't shareable across a remote boundary).
  // The upgrade there authenticates with THIS run's hostId + wsToken (only
  // ws-transport launches register one server-side); the per-frame rpc token
  // stays what dispatchRunRpc resolves to the run's session/user.
  const rpcWsUrl = process.env.OPENSESSION_RPC_WS_URL || "";
  const transportEnv = rpcWsUrl
    ? {
        OPENSESSION_RPC_WS_URL: rpcWsUrl,
        OPENSESSION_RPC_WS_HOST: spec.hostId,
        OPENSESSION_RPC_WS_AUTH: RUN_WS_TOKEN,
      }
    : { OPENSESSION_RPC_SOCKET: rpcSocketPath(OPENSESSION_SESSIONS_DIR) };
  const out: Record<string, unknown> = {};
  // The interpreter running THIS process re-launches the proxy: from source
  // that is `bun run <mcp-proxy.ts>` (process.execPath is bun — resolves both
  // on the host and inside a sandbox container where protocol.ts's BUN_BIN host
  // path doesn't exist); as a compiled binary it is `<exe> mcp-proxy`.
  const [proxyCommand, ...proxyArgs] = mcpProxyArgv(
    process.execPath,
    MCP_PROXY_ENTRY,
  );
  for (const name of names) {
    out[name] = {
      command: proxyCommand,
      args: proxyArgs,
      env: {
        ...transportEnv,
        OPENSESSION_RPC_TOKEN: spec.rpcToken,
        OPENSESSION_MCP_SERVER: name,
      },
    };
  }
  return out;
}

// ── Drive the run ─────────────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  // A deliberate `systemctl stop` of this unit: the child dies with us; the
  // journal file survives, so opensession's boot sweep resumes the run.
  log("SIGTERM — exiting (journal remains for resume)");
  process.exit(143);
});

try {
  for await (const event of runAgent({
    prompt: spec.prompt,
    promptEntryId: spec.promptEntryId,
    seedTranscriptEntries: spec.seedTranscriptEntries,
    sessionId: spec.engineSessionId || undefined,
    cwd: spec.cwd,
    mode: spec.mode,
    mcpGrantUser: spec.mcpGrantUser,
    model: spec.model,
    selectedModel: spec.selectedModel,
    transientFallback: spec.transientFallback,
    images: spec.images,
    forkSession: spec.forkSession,
    resumeSessionAt: spec.resumeSessionAt,
    mcpServers: spec.mcpServers ?? "all",
    inProcessMcp: proxyMcpConfigs(),
    reposNote: spec.reposNote,
    deniedTools: spec.deniedTools,
    publicationPolicy: spec.publicationPolicy,
    confirmTools: spec.confirmTools,
    aws: spec.aws,
    claudeCliEnv: spec.claudeCliEnv,
    codexCliEnv: spec.codexCliEnv,
    author: spec.author,
    user: spec.user,
    fallbackModel: spec.fallbackModel,
    accountAffinityKey: spec.accountAffinityKey,
    effort: spec.effort,
    fastMode: spec.fastMode,
    accountId: spec.accountId,
    accountStrict: spec.accountStrict,
    usageCredits: spec.usageCredits,
    prReviewer: spec.prReviewer,
    journal: {
      ...(spec.lifecycle === "auxiliary"
        ? {}
        : { osSessionId: spec.osSessionId }),
      kind: spec.journalKind || "prompt",
      firstJournaledAt: spec.firstJournaledAt,
      resumeAttempts: spec.resumeAttempts,
      lastResumeAt: spec.lastResumeAt,
    },
    onAskUser,
  })) {
    if (event.type === "init" && event.sessionId) {
      meta.engineSessionId = event.sessionId;
      saveMeta();
    }
    if (event.type === "model_switch") {
      meta.effectiveModel = event.toModel || meta.effectiveModel;
      meta.transientFallback = event.temporaryFallback === true;
      if (event.toModel && shouldPersistModelSwitch(event)) {
        meta.selectedModel = event.toModel;
      }
      saveMeta();
    }
    if (event.type === "done" || event.type === "error") terminal = event;
    send({ t: "event", event });
  }
} catch (e: any) {
  log("run threw:", e);
  terminal = { type: "error", content: e?.message || String(e) };
  send({ t: "event", event: terminal });
}

ended = true;
meta.done = terminal ?? {
  type: "error",
  content: "Run ended without a result",
};
meta.endedAt = new Date().toISOString();
saveMeta();
send({ t: "end", done: terminal });
log("run ended:", terminal?.type || "no-terminal");

// Linger for the client's shutdown ack (or a late reattach that consumes the
// end state). If nobody comes, exit anyway — meta.done lets the boot sweep
// finish the bookkeeping without us.
await new Promise<void>((resolveWait) => {
  shutdownAcked = resolveWait;
  setTimeout(resolveWait, 5 * 60_000);
});

exiting = true; // stop the WS redial loop
if (!RUN_WS_URL) {
  try {
    unlinkSync(sockPath);
  } catch {}
}
// Remote interactive runs receive a short-lived access token in their private
// run directory. Remove it on every ordinary host exit; a crashed sandbox is
// still bounded by the token's own expiry and the sandbox lifecycle cleanup.
cleanupProjectedGithubAuth();
log("exiting");
process.exit(0);
