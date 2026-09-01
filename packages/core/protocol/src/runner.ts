/**
 * Run-host protocol: the wire contract between a detached run-host process
 * (the reference implementation: src/runner-host/host.ts) and the Open Session
 * server (src/server/host-client.ts).
 *
 * A run host is a small standalone process that owns ONE agent run (the
 * engine driver plus its CLI child). It is spawned OUTSIDE the server's
 * process group, so a server restart — graceful or crash — never touches the
 * run. The server connects to the host's unix socket as a client; if the
 * server goes down mid-run, the host keeps working and the new server
 * process reattaches to the same socket.
 *
 * Framing: newline-delimited JSON, both directions. JSON.stringify never emits
 * raw newlines, so a line is always exactly one message.
 *
 * The UNIX-SOCKET stream is LIVE-ONLY by design — no event replay. A
 * reattaching server missed some stream events, but the transcript jsonl on
 * disk is the durable copy (viewers re-sync from it on watch), and everything
 * else a consumer needs to catch up is carried in `hello`: the engine session
 * id, any asks still blocked waiting for a human, and the terminal event if
 * the run already ended. The WS transport (remote sandboxes) layers seq/ack
 * replay on top — see `seq` below and src/runner-host/ws-buffer.ts — because
 * there the transcript is NOT host-visible, so a flaky link would otherwise
 * lose mid-run events for good.
 */
import type { StreamEvent, ImageInput } from "./events";
import type { GitIdentity } from "./identity";
import type { TranscriptEntry } from "./session";

/**
 * What MCP surface a run gets. There is no implicit default: `"all"` is a
 * decision a caller has to write down, exactly like an allowlist is.
 *
 * This used to be `string[] | undefined`, where omitting the field meant every
 * configured connector. That default is how the github PR flows silently
 * mounted ~430 external tool schemas on 1,410 sessions to serve the ~20 that
 * ever called one (2026-08-03) — nobody chose it, they just didn't pass the
 * argument. Spelling `"all"` out costs a caller five characters and makes the
 * wide grant reviewable in a diff.
 *
 * `[]` is a third, distinct meaning: no external servers at all.
 */
export type McpScope = "all" | string[];

/** Everything a host needs to drive one run — a serializable RunAgentOpts. */
export interface RunHostSpec {
  hostId: string;
  /** Open Session session this run belongs to (busy/steer/cancel key, journal). */
  osSessionId: string;
  /** Session runs participate in the owning actor's run lifecycle. Auxiliary
   *  runs (for example workflow workers) use the same isolated host machinery
   *  without claiming the parent session's run slot. */
  lifecycle?: "session" | "auxiliary";
  /** Session runs project forwarded transcript rows onto osSessionId.
   *  Auxiliary workers may retain engine-keyed history or suppress forwarding
   *  when their workflow journal already owns the visible result. */
  transcriptTarget?: "session" | "engine" | "none";
  prompt: string;
  /** Transcript uuid of the server's already-written user line for this
   *  prompt. The in-host engine threads it into its own user-line write so
   *  the row upserts instead of duplicating the bubble (the same contract as
   *  RunAgentOpts.promptEntryId for in-process runs). */
  promptEntryId?: string;
  /** Server-owned transcript snapshot for engines that need a context fallback
   *  inside a detached host. Hosts must not open the server's transcript DB. */
  seedTranscriptEntries?: TranscriptEntry[];
  /** Engine session id to resume (claude session id / codex thread id). */
  engineSessionId?: string;
  cwd: string;
  mode?: "ask" | "code" | "scratch";
  /** MCP OAuth identity: the session creator (see agent-runner RunAgentOpts). */
  mcpGrantUser?: string;
  model?: string;
  selectedModel?: string;
  transientFallback?: boolean;
  images?: ImageInput[];
  forkSession?: boolean;
  resumeSessionAt?: string;
  /** MCP scope for the run: an allowlist, [] for none, or "all". Optional
   *  for back-compat with specs sent before McpScope; absent reads as "all". */
  mcpServers?: McpScope;
  /**
   * opensession-* in-process servers to expose via the RPC proxy (mcp-proxy.ts →
   * opensession-rpc.sock). Names must match what the server-side builder
   * produces for this session. Automation-owned sessions may name only their
   * deliberately registered report/workflow/self-improvement tools.
   */
  proxyMcpServers?: string[];
  /** Per-run bearer for the RPC socket; maps to {sessionId, user} on the server side. */
  rpcToken?: string;
  /**
   * Per-run bearer for the WS transport (Phase 3). Present = this run's host
   * dials the server's run-ws WS route (/run-ws/<hostId>) instead of serving a
   * unix socket in its run dir; the launcher passes it to the host process as
   * OPENSESSION_RUN_WS_TOKEN and registers it (keyed by hostId) so the route can
   * validate the dial-back. Persisted in spec.json so a restarted server
   * re-registers it on reattach (the host's WS reconnect must keep working).
   */
  wsToken?: string;
  reposNote?: string;
  deniedTools?: Record<string, string>;
  publicationPolicy?: { repo: string; branch: string; headBranch: string };
  confirmTools?: Record<string, string>;
  aws?: boolean;
  /** Provision pool credentials for run-spawned Claude/Codex CLI tools. */
  claudeCliEnv?: boolean;
  codexCliEnv?: boolean;
  author?: GitIdentity | null;
  user?: string;
  fallbackModel?: string;
  /** Stable provider-account affinity for internal fan-out workers. */
  accountAffinityKey?: string;
  /** Reasoning effort for the run (UI scale; each runner normalizes it). */
  effort?: string;
  /** OpenAI priority service tier for ChatGPT OAuth Codex runs. */
  fastMode?: boolean;
  /** Pinned account in the active model provider's pool; pool fallback applies. */
  accountId?: string;
  /** Hard accountId pin — never rotate into the shared pool (cost cap). */
  accountStrict?: boolean;
  /** Allow accounts spending usage-credits past their subscription limits. */
  usageCredits?: boolean;
  /** Reviewer(s) requested on PRs this run opens (GitHub login, org/team
   *  slug, or comma-separated list): an automation-owned session keeps its
   *  automation's PR-review policy when its turn moves into a host. */
  prReviewer?: string;
  journalKind?: string;
  /** Durable restart-recovery lineage (see server/run-journal.ts). */
  firstJournaledAt?: string;
  resumeAttempts?: number;
  lastResumeAt?: string;
  /** Trust boundary selected by the caller. Automation hosts receive only
   *  their pinned model credential and explicitly proxied MCP servers. */
  trustProfile?: "interactive" | "automation";
}

/** Mutable host state, persisted to meta.json in the host dir. This is what a
 *  rebooting server reads to decide reattach vs finish vs resume. */
export interface RunHostMeta {
  hostId: string;
  pid: number;
  bootId?: string;
  startTicks?: string;
  osSessionId: string;
  startedAt: string;
  engineSessionId?: string;
  selectedModel?: string;
  effectiveModel?: string;
  transientFallback?: boolean;
  /** Terminal done/error StreamEvent once the run generator finished. */
  done?: StreamEvent;
  endedAt?: string;
}

export interface PendingAskView {
  askId: string;
  input: Record<string, unknown>;
}

export type AskResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/**
 * WS transport only: host→server frames (except `hello`/`ping`, which are
 * per-connection transport chatter) carry a monotonic per-host `seq`. The
 * server acks its consumed watermark and dedupes replayed frames by it; the
 * unix-socket transport never sets it. See src/runner-host/ws-buffer.ts.
 */
export type HostToClientMsg = HostToClientPayload & { seq?: number };

type HostToClientPayload =
  | {
      t: "hello";
      hostId: string;
      pid: number;
      osSessionId: string;
      engineSessionId?: string;
      /** "ended" = run finished while nobody was attached; `done` has the terminal event. */
      state: "running" | "ended";
      pendingAsks: PendingAskView[];
      selectedModel?: string;
      effectiveModel?: string;
      transientFallback?: boolean;
      done?: StreamEvent;
    }
  | { t: "event"; event: StreamEvent }
  /**
   * Per-connection catch-up fence. On attach, the host sends hello, replays
   * every recoverable frame, then sends this marker. An ended hello is not a
   * safe terminal fence by itself because its missing transcript tail follows
   * it on the wire.
   */
  | { t: "catchup_complete" }
  | { t: "ask"; askId: string; input: Record<string, unknown> }
  /**
   * A steer/interrupt_steer arrived too late (run already finishing, or the
   * backend doesn't support steering). The client should queue the text for
   * delivery after the run instead — never drop a user's message.
   */
  | { t: "steer_failed"; text: string }
  /** Reply to a retract_steer request. False means the message already crossed
   * the engine's step boundary, so the client must not restore it as a draft. */
  | {
      t: "steer_retracted";
      requestId: string;
      steerId: string;
      retracted: boolean;
    }
  /** Run generator finished; meta.done is written. Client should ack with shutdown. */
  | { t: "end"; done?: StreamEvent }
  /**
   * WS-transport keepalive (host → server every 30s). A unix socket never
   * idles out, but WS intermediaries (and Bun.serve's per-socket idle timer)
   * close quiet connections — e.g. during a minutes-long tool call with no
   * stream events. Answered with `pong`; the socket transport never sends it.
   */
  | { t: "ping" }
  /**
   * WS transport only: the host's replay buffer overflowed while the server
   * was unreachable — frames `from..to` are gone from the stream (the
   * transcript jsonl still has everything). Sent once at replay time; the
   * server logs it.
   */
  | { t: "gap"; from: number; to: number }
  /**
   * Proxied transcript append for in-process engines (Pi today). The host's
   * engine driver persists full-fidelity transcript lines, but the host may
   * not own the live transcript store (a sandbox has its own filesystem; a
   * local detached host must not be a second writer on the server's
   * transcripts.db), so the lines are forwarded and the server applies them.
   * `engineSessionId` keys the append (the server records the
   * engine→unified-session mapping first); it may equal the run's
   * osSessionId for lines persisted before the engine session exists. Lines
   * carry stable uuids, so re-delivery (socket-mode reattach resend, WS
   * replay) upserts instead of duplicating.
   */
  | {
      t: "transcript";
      engineSessionId: string;
      lines: Record<string, unknown>[];
    };

export type ClientToHostMsg =
  | { t: "ask_answer"; askId: string; result: AskResult }
  /**
   * Mid-run steer. `images` carries composer attachments the same way the
   * opening prompt's `RunHostSpec.images` does, so a screenshot folds into
   * the live turn instead of waiting for the run to end. It was text-only
   * until 2026-08-19, which made every attachment unsteerable once local
   * runs moved into detached hosts: the server declined the steer rather
   * than send one that would silently drop the picture, and the message
   * bounced back to the queue with a notice. Hosts built before that field
   * existed ignore it, which degrades to the old behavior rather than
   * breaking.
   */
  | { t: "steer"; text: string; images?: ImageInput[]; steerId?: string }
  /** Remove one exact steer while it is still in the engine queue. The host
   * acknowledges after the engine has either removed it or already delivered it. */
  | { t: "retract_steer"; requestId: string; steerId: string }
  | { t: "interrupt_steer"; text: string; images?: ImageInput[] }
  | { t: "cancel" }
  /** Ack of `end`: everything consumed, host may exit and the client cleans up the dir. */
  | { t: "shutdown" }
  /** WS keepalive answer (see `ping`). */
  | { t: "pong" }
  /**
   * WS transport only: server→host consumed-watermark ack (sent on socket
   * open, then periodically). `epoch` identifies the server-side seq record —
   * the host only replays into a matching epoch (src/runner-host/ws-buffer.ts).
   */
  | { t: "ack"; seq: number; epoch: string };

/**
 * Line-buffered NDJSON reader. Feed it raw socket chunks; it invokes onMsg per
 * complete JSON line. Malformed lines are logged and skipped (a torn line can
 * only happen on a crash mid-write, and losing one message beats killing the
 * connection).
 *
 * Buffers BYTES, not a string. Decoding each chunk on arrival splits multi-byte
 * UTF-8 sequences at chunk boundaries — the socket cuts wherever it likes — and
 * each half decodes to U+FFFD, so `café` arrived as `caf<?><?>` and any line
 * carrying non-ASCII was silently corrupted (or dropped, when the replacement
 * chars landed inside JSON syntax). Accumulating the raw bytes and decoding
 * once per complete line makes the boundary invisible. Scanning each chunk from
 * where the last line ended also keeps a line assembled from many chunks linear
 * rather than re-scanning the whole pending buffer per chunk.
 */
export function ndjsonReader(
  onMsg: (msg: any) => void,
  label: string,
  options?: {
    maxBufferedBytes?: number;
    onInvalid?: () => void;
  },
): (data: Buffer | string) => void {
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  let invalid = false;
  const fail = () => {
    invalid = true;
    options?.onInvalid?.();
  };
  const emit = (line: Buffer): boolean => {
    const text = line.toString();
    if (!text.trim()) return true;
    try {
      onMsg(JSON.parse(text));
      return true;
    } catch (e) {
      if (options?.onInvalid) {
        fail();
        return false;
      }
      console.error(`[${label}] dropping malformed NDJSON line:`, e);
      return true;
    }
  };
  return (data) => {
    if (invalid) return;
    const chunk = typeof data === "string" ? Buffer.from(data) : data;
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      if (newline < 0) {
        if (start < chunk.length) {
          const fragment = Buffer.from(chunk.subarray(start));
          if (
            options?.maxBufferedBytes !== undefined &&
            fragmentBytes + fragment.length > options.maxBufferedBytes
          ) {
            fail();
            fragments = [];
            fragmentBytes = 0;
            return;
          }
          fragments.push(fragment);
          fragmentBytes += fragment.length;
        }
        return;
      }
      const tail = chunk.subarray(start, newline);
      if (
        options?.maxBufferedBytes !== undefined &&
        fragmentBytes + tail.length > options.maxBufferedBytes
      ) {
        fail();
        fragments = [];
        fragmentBytes = 0;
        return;
      }
      if (fragments.length) {
        const line = Buffer.concat(
          [...fragments, tail],
          fragmentBytes + tail.length,
        );
        fragments = [];
        fragmentBytes = 0;
        if (!emit(line)) return;
      } else {
        if (!emit(tail)) return;
      }
      start = newline + 1;
    }
  };
}

/** Root of all run-host dirs: one subdir per host with spec/meta/journal/sock/log. */
export function runHostsDir(sessionsDir: string): string {
  return `${sessionsDir}/run-hosts`;
}

export const HOST_SOCK_NAME = "host.sock";
export const HOST_SPEC_NAME = "spec.json";
export const HOST_META_NAME = "meta.json";
export const HOST_JOURNAL_NAME = "journal.json";
export const HOST_LOG_NAME = "host.log";

/** The server-side RPC socket the mcp-proxy talks to. Stable path (the
 *  literal filename is historical — a wire constant, not branding). */
export function rpcSocketPath(sessionsDir: string): string {
  return `${sessionsDir}/opensession-rpc.sock`;
}
