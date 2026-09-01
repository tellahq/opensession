/**
 * Session protocol — the client ↔ server contract for watching and driving a
 * cloud agent session: the durable record types (transcript entries, usage,
 * asks) and the core WebSocket frames every session viewer/driver speaks.
 *
 * This is the "bring your own UI" layer. A conformant client can render a
 * live session with nothing but these frames: watch → transcript_init (+
 * transcript_append / load_history pages), the stream_* / session_feed live
 * turn events, prompt/cancel/queue control to drive it, and ask_question /
 * ask_resolved for human-in-the-loop questions.
 *
 * The reference web UI multiplexes app extensions over the same socket —
 * collaborative notes, terminals, presence, PR/report/todo change
 * pings. Those are deliberately NOT here: they're the app, not the protocol.
 * The frontend composes its full unions as `ProtocolClientMessage | <app
 * variants>` (src/frontend/lib/types.ts), which keeps this file the single
 * authoritative statement of the core surface.
 *
 * Compatibility stance (same as the native clients document): fields are
 * added, never repurposed; a server ahead of a client adds keys, it never
 * breaks one. Unknown frame types must be ignored by clients.
 */

import type { AnsweredAskData, EntryNotice, NoticeKind } from "./notices";
import type { ToolPresentation } from "./tool-presentation";

/** The complete set of managed Executor providers. */
export const EXECUTOR_PROVIDERS = ["box", "daytona", "modal"] as const;
export type ExecutorProvider = (typeof EXECUTOR_PROVIDERS)[number];

export type ExecutorLifecycle =
  | "preparing"
  | "awake"
  | "sleeping"
  | "waking"
  | "needs_attention";

/** Where tool and workspace operations execute. This state contains no model
 * or conversation identity. Omission at creation normalizes to `local`. */
export type ExecutionTarget =
  | { kind: "local" }
  | { kind: "runner"; executorId: string; workspaceId: string }
  | {
      kind: "executor";
      provider: ExecutorProvider;
      executorId: string;
      workspaceId: string;
      instanceId?: string;
      lifecycle: ExecutorLifecycle;
      durableDeltaId?: string;
    };

export function isExecutorProvider(value: unknown): value is ExecutorProvider {
  return (
    typeof value === "string" &&
    (EXECUTOR_PROVIDERS as readonly string[]).includes(value)
  );
}

/** One rendered line of a session's durable transcript (the jsonl record). */
export interface TranscriptEntry {
  id: string;
  type: "user" | "assistant" | "tool_use" | "tool_result" | "system";
  content: string;
  timestamp: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  requestId?: string;
  /** Stable delivery identities whose accepted messages formed this user turn.
   * A batched engine turn can represent several independently sent messages. */
  sourceMessageIds?: string[];
  /** Content-free wire marker for a hidden system-triggered turn. It separates
   * completed assistant output from later background work without rendering a
   * fake user message. Stored context payloads remain private; the server
   * projects only this boolean boundary. */
  turnBoundary?: boolean;
  // Set on a tool_result whose block carried is_error — the UI shows the step
  // with an error state instead of a success check.
  isError?: boolean;
  // On assistant text entries: the model that wrote this message. Per-message —
  // mid-session switches and usage-limit fallbacks make the session-level
  // model unreliable history.
  model?: string;
  /** This assistant entry is a provider reasoning summary rather than model
   * output. It remains visible in the timeline, but clients present it as
   * quiet activity instead of answer markdown. */
  isReasoning?: boolean;
  // Set on a Task/Agent tool_result: the spawned sub-agent's id, linking a
  // tool call to that sub-agent's own transcript.
  agentId?: string;
  // Ready-to-render image srcs (http(s), data:, or authenticated local-media
  // URLs) extracted from image blocks — e.g. a Read or a pasted image.
  images?: string[];
  // Ready-to-render video srcs (served via the media endpoint) parsed from
  // `OPENSESSION_VIDEO: <path>` markers a tool printed.
  videos?: string[];
  /** The subset of `images`/`videos` the agent chose to SHOW rather than
   *  merely touched — srcs that came from an `OPENSESSION_IMAGE:` /
   *  `OPENSESSION_VIDEO:` marker. Only carried on tool_result entries, and
   *  it records provenance, not a verdict: a Read of a PNG and a path that
   *  merely appears in tool output are working artifacts, so they still
   *  attach but stay behind the fold, while a marker means "look at this".
   *  User and assistant media is deliberate by definition (a person attached
   *  it, or the agent named it in its own prose) and carries no subset.
   *  Absent on entries stored before the field existed — which reads as
   *  "nothing featured", i.e. old tool rows stop auto-opening. */
  featuredMedia?: string[];
  // Non-media composer attachments (staged to disk server-side) — rendered as
  // downloadable chips on the user bubble.
  files?: { name: string; path: string }[];
  // Set when `content` was clamped for the WebSocket wire — `contentLength`
  // is the full length; the full entry is at GET /api/sessions/:id/entry/:id.
  contentClamped?: boolean;
  contentLength?: number;
  /** Transcript v2: immutable display order plus monotonic mutation cursor.
   *  Present only on v2 frames; changeSeq advances on inserts and rewrites. */
  seq?: number;
  changeSeq?: number;
  /** What the transcript's raw form said this system entry is — set by
   *  whoever parsed the line (a `<compaction-summary>`, a `<recap>`), read
   *  only by classifyEntry, which turns it into `notice`. It exists because
   *  the marker is gone by the time an entry reaches the classifier; adding a
   *  kind must not add another boolean here. */
  noticeKind?: NoticeKind;
  /** Structured payload parsed from a durable answered-question record. The
   *  classifier moves it onto `notice.ask`; title + markdown content remain the
   *  compatibility path for clients that predate the richer card. */
  ask?: AnsweredAskData;
  /** What this tool call is and what it did (tool_use entries only), derived
   *  server-side so no client re-parses tool input — see tool-presentation.ts. */
  presentation?: ToolPresentation;
  /** How this entry reads: an operational notice rather than a message. Set by
   *  classifyEntry (notices.ts) on the way to a client, which also strips the
   *  delivery plumbing out of `content` — so a client renders `notice.title`,
   *  and `content` as the body when `notice.body` says to. Absent on ordinary
   *  messages, which is the whole point: one branch, not nine. */
  notice?: EntryNotice;
  /** Set on a `context-injection` or `standing-context` entry: the model-visible
   *  payload's provenance. `source` names what built it (a handoff, the repos
   *  note, an attached session's excerpt…); `turnId` is the prompt entry — or
   *  run token — the payload rode with, so a replay can group a turn's
   *  injections with the message they were attached to. On a standing-context
   *  entry `hash` is the sha256 of the recorded content and `bytes` its length:
   *  one version of one source is one row (the entry id is content-addressed,
   *  so re-asserting it upserts), and a reader reconstructs a turn's standing
   *  input by taking the newest record of each source at or before it.
   *  `turnId` there names the turn that recorded that version. Servers keep
   *  these entries out of
   *  the default projection (they're a debug/replay record, not conversation),
   *  so a client only ever sees one if it asked for them. */
  contextInjection?: {
    source: string;
    turnId?: string;
    hash?: string;
    bytes?: number;
  };
  /** Who sent this turn, when it wasn't the session's driver: a teammate who
   *  steered in, or one whose answer was routed back. The client credits them
   *  instead of the owner ("You" only when the sender is the viewer). */
  sender?: string;
  /** Where `sender` said it, when they weren't in the app. */
  senderVia?: "slack";
}

/** Display role needed to group a transcript without downloading its bodies. */
export type TranscriptIndexRole =
  | "user"
  | "notice"
  | "review_handoff"
  | "system"
  | "assistant"
  | "tool_use"
  | "tool_result"
  | "hidden";

/** One compact durable-row descriptor in a complete transcript outline. */
export interface TranscriptIndexEntry {
  id: string;
  seq: number;
  changeSeq: number;
  timestampMs: number;
  role: TranscriptIndexRole;
  contentLength: number;
  /** Present only on review handoffs, for the collapsed loop label. */
  reviewPrNumber?: number;
}

/** Cumulative token/cost accounting for a session, as viewers render it. */
export interface SessionUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Most recent turn's full prompt size (context currently in use). */
  contextTokens: number;
  /** Token ceiling of the model that produced `contextTokens`. */
  contextWindow: number;
  /** Number of completed turns folded into these totals. */
  turns: number;
  /** ISO time of the last update. */
  updatedAt: string;
}

/** One question of a human-in-the-loop ask (AskUserQuestion payload). */
export interface AskQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** A prompt waiting in (or steered out of) a session's queue. */
export interface QueuedPrompt {
  id: string;
  content: string;
  user?: string;
  images?: string[];
  files?: unknown;
  /** Sibling-session transcripts attached to this prompt. */
  contextSessions?: string[];
  /** False for routed/system items that must keep queue-only metadata. */
  editable?: boolean;
  /**
   * When the engine ACCEPTED this message as a steer (epoch ms). Acceptance
   * is not delivery: the current tool or assistant message must still reach
   * its boundary. A long test run or subagent can therefore hold it for
   * minutes. Clients count from here so a still chip cannot read as a hang.
   */
  steeredAt?: number;
}

/**
 * Core client → server frames: everything needed to watch and drive a
 * session. The reference UI's full union adds app variants on top.
 */
export type ProtocolClientMessage =
  // Liveness probe — the server echoes `pong`. Detects half-open sockets
  // (iOS/Safari kills backgrounded connections without firing onclose).
  | { type: "ping" }
  | { type: "command_ack"; sessionId: string; requestId: string }
  | {
      type: "watch";
      sessionId: string;
      user?: string;
      /** Reconnect resume cursor: the endOffset/rev of the last
       *  transcript_init/append this client received for the session. When
       *  they still match the live mirror file, the server skips the full
       *  transcript_init replace and replays only the gap from the jsonl. */
      sinceOffset?: number;
      sinceRev?: string;
      /** Transcript v2 capability: this client understands seq-cursor
       *  frames (docs/transcripts.md). Old servers ignore it. */
      supportsSeq?: boolean;
      /** This client resumes every mutation, including old-seq rewrites. */
      supportsChangeSeq?: boolean;
      /** This client can render a complete lightweight transcript outline and
       *  hydrate arbitrary seq ranges as they approach the viewport. */
      supportsTranscriptIndex?: boolean;
      /** Seq-mode resume cursor: the lastSeq of the last v2 frame this
       *  client received for the session (used instead of offset/rev). */
      sinceSeq?: number;
      sinceChangeSeq?: number;
      /** Ordered ephemeral-feed capability and reconnect cursor. */
      supportsFeed?: boolean;
      sinceFeedSeq?: number;
      feedEpoch?: string;
    }
  | { type: "unwatch"; sessionId: string }
  | { type: "load_transcript_index"; sessionId: string }
  | {
      type: "load_transcript_range";
      sessionId: string;
      requestId: string;
      firstSeq: number;
      lastSeq: number;
      /** Continue a block larger than one bounded response. */
      afterSeq?: number;
      /** Index generation this request was planned against. */
      epoch: number;
    }
  /** The client half of `ask_question`: answers keyed by question TEXT, or
   *  null to dismiss. Only applied while `questionId` is still the session's
   *  pending ask, so a stale card can't answer a newer question. */
  | {
      type: "answer_question";
      sessionId: string;
      requestId?: string;
      questionId: string;
      answers: Record<string, string> | null;
    }
  | {
      type: "load_history";
      sessionId: string;
      beforeOffset?: number;
      beforeRev?: string;
      /** Transcript v2 seq paging: earliest seq the client holds — the
       *  server returns the page just before it. */
      beforeSeq?: number;
      /** Entries per page (seq paging only), server-capped. */
      limit?: number;
    }
  | {
      type: "prompt";
      sessionId: string;
      requestId?: string;
      content: string;
      user?: string;
      images?: string[];
      files?: unknown;
      busyMode?: "queue" | "steer";
      /** Reasoning effort — persisted on the session and enforced per run. */
      effort?: "low" | "medium" | "high" | string;
      fastMode?: boolean;
      /** Sibling-session ids whose transcripts ride along as context. */
      contextSessions?: string[];
      /** @deprecated Use contextSessions. */
      contextChats?: string[];
    }
  | {
      type: "interrupt_prompt";
      sessionId: string;
      requestId?: string;
      content: string;
      user?: string;
      images?: string[];
      files?: unknown;
      effort?: "low" | "medium" | "high" | string;
      fastMode?: boolean;
    }
  | {
      type: "delete_queued_prompt";
      sessionId: string;
      requestId?: string;
      queueId?: string;
      queueIndex?: number;
    }
  | {
      type: "take_queued_prompt";
      sessionId: string;
      requestId?: string;
      queueId: string;
    }
  | {
      type: "take_steered_prompt";
      sessionId: string;
      requestId?: string;
      queueId: string;
    }
  | {
      /** @deprecated Current clients take the item back into the composer. */
      type: "update_queued_prompt";
      sessionId: string;
      requestId?: string;
      queueId?: string;
      queueIndex?: number;
      content: string;
      images?: string[];
    }
  | {
      type: "steer_queued_prompt";
      sessionId: string;
      requestId?: string;
      queueId?: string;
      queueIndex?: number;
    }
  | {
      type: "interrupt_queued_prompt";
      sessionId: string;
      requestId?: string;
      queueId?: string;
      queueIndex?: number;
    }
  | {
      // Drag-to-reorder: `order` is the queued items' ids in their new send
      // order. The server reconciles its queue array to match.
      type: "reorder_queued_prompt";
      sessionId: string;
      requestId?: string;
      order: string[];
    }
  | { type: "cancel"; sessionId?: string; requestId?: string }
  | {
      type: "create_session";
      requestId?: string;
      /** Client-minted native id. Replaying the same create after reconnect is idempotent. */
      clientSessionId?: string;
      branch: string;
      prompt: string;
      /** Prompt projected with visible session names, used only for naming this session. */
      titlePrompt?: string;
      user: string;
      /** Local-profile bridge only: create this session on the hosted upstream. */
      cloud?: boolean;
      mode?: "ask" | "code" | "scratch";
      repo?: string;
      /** Existing workspace to add this new session to. */
      workspaceId?: string;
      /** Create a new workspace for this session. */
      createWorkspace?: { name?: string };
      /**
       * How the session relates to its workspace's worktree: share it (default),
       * stack a new worktree off it, or ask (no worktree).
       */
      worktreeMode?: "share" | "stack" | "ask";
      /**
       * Where a new code workspace starts. `default` follows the repository's
       * setting; the explicit choices are that user's override for this repo.
       */
      checkoutMode?: "default" | "checkout" | "worktree";
      model?: string;
      /** Optional MCP server allowlist for the opening run. [] means none. */
      mcpServers?: string[];
      /** Execute on a managed Executor from this provider. Omit to use this machine. */
      executor?: ExecutorProvider;
      /** @deprecated Transitional pre-Executor selection. Use executor. */
      sandbox?: boolean | string;
      images?: string[];
      /** Non-image composer attachments, staged server-side or kept inline. */
      files?: unknown;
      /** Reasoning effort persisted on the new session and enforced per run. */
      effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
      /** OpenAI priority service tier for the opening and later turns. */
      fastMode?: boolean;
      /** Pinned provider account; omitted means automatic pool selection. */
      accountId?: string;
      /** Fork an existing session, keeping its real conversation history. */
      forkFrom?: { sourceId: string; messageId?: string };
      /**
       * Session opened from a PR: `branch` is the PR's existing head branch —
       * check it out (isolated worktree) instead of branching off the default.
       */
      fromPr?: boolean;
    };

/**
 * The live half of a turn: the frames a session emits while it runs, plus the
 * committed transcript_append that lands the result.
 *
 * Declared once and used twice on purpose. A server that speaks the feed
 * wraps these in `session_feed` (`event`); one that doesn't sends the same
 * frame at the top level of ProtocolServerMessage. Both routes carry the
 * identical shape, so a client can unwrap a feed frame straight into its
 * ordinary handler, and a new field can never reach one route only.
 */
export interface SessionSafetyState {
  status: "paused_for_safety";
  explanation: string;
  automaticReconciliationRunning: boolean;
  pausedAt: string;
  operation: string;
  repairAvailable: boolean;
}

export type SessionLiveEvent =
  | {
      type: "transcript_append";
      sessionId?: string;
      entries: TranscriptEntry[];
      /** Resume cursor after this append (see transcript_init.endOffset). */
      endOffset?: number;
      rev?: string;
      /** Transcript v2 seq bounds. Upsert republishes reuse the entry's
       *  ORIGINAL seq, so firstSeq can sit below the client's lastSeq —
       *  merge by id, track lastSeq as a max, never assume monotonic. */
      v2?: boolean;
      firstSeq?: number;
      lastSeq?: number;
      lastChangeSeq?: number;
    }
  | { type: "stream_start"; sessionId: string; by?: string }
  | {
      type: "stream_text";
      sessionId?: string;
      text: string;
      /** The assistant block this text belongs to, when the engine names its
       *  blocks. The durable entry that lands it carries the same id — see
       *  `LiveTextBuffer`, which every live surface dedups with. */
      blockId?: string;
    }
  | { type: "stream_tool_use"; sessionId?: string; entry: TranscriptEntry }
  | { type: "stream_tool_result"; sessionId?: string; entry: TranscriptEntry }
  | { type: "stream_done"; sessionId?: string }
  | {
      type: "session_status";
      sessionId?: string;
      isRunning: boolean;
      safety?: SessionSafetyState;
    };

/**
 * Core server → client frames. sessionId on the session-scoped messages lets
 * viewers drop events meant for a different session (socket races,
 * creator-side direct sends); optional where a few direct replies
 * legitimately have no session.
 */
export type ProtocolServerMessage =
  // First frame on every socket: the server process's bootId, so a reconnect
  // can tell a real restart (changed) from a transient blip (unchanged).
  // `restartBy` (when the boot was seconds after a shutdown) names the
  // session that likely triggered that restart.
  | {
      type: "hello";
      bootId: string;
      restartBy?: string;
      capabilities?: { commandResults?: boolean };
      /** Verified durable-command partition. Never derived from client claims. */
      commandScope?: string;
    }
  | {
      type: "transcript_init";
      sessionId?: string;
      entries: TranscriptEntry[];
      truncated?: boolean;
      /** Byte offset the shipped tail begins at — the "load earlier"
       *  pagination cursor (absent on older servers → full-resend fallback). */
      startOffset?: number;
      /** Resume cursor: where this snapshot ends in the mirror file, and an
       *  opaque tag identifying which file that was. Echoed back on a
       *  reconnect watch as sinceOffset/sinceRev. */
      endOffset?: number;
      rev?: string;
      /** Transcript v2 (seq protocol): present iff served from the owned
       *  store. firstSeq/lastSeq bound the shipped entries' seqs; their
       *  presence switches the client into seq mode for the session. */
      v2?: boolean;
      firstSeq?: number;
      lastSeq?: number;
      lastChangeSeq?: number;
    }
  | {
      /** Complete content-free outline for full-range virtual scrolling. */
      type: "transcript_index";
      sessionId: string;
      entries: TranscriptIndexEntry[];
      firstSeq: number;
      lastSeq: number;
      lastChangeSeq: number;
      /** Authoritative replacement generation; stale range replies are ignored. */
      epoch: number;
    }
  | {
      /** One bounded chunk of an arbitrary indexed range. */
      type: "transcript_range";
      sessionId: string;
      requestId: string;
      entries: TranscriptEntry[];
      firstSeq: number;
      lastSeq: number;
      coveredThroughSeq: number;
      complete: boolean;
      epoch: number;
      lastChangeSeq: number;
    }
  | {
      /** Older entries from one "load earlier" page. Client merges by id and
       *  re-sorts by time (prepend semantics). */
      type: "transcript_history";
      sessionId?: string;
      entries: TranscriptEntry[];
      truncated?: boolean;
      startOffset?: number;
      /** Transcript v2 seq page bounds (see transcript_init). */
      v2?: boolean;
      firstSeq?: number;
      lastSeq?: number;
    }
  | {
      type: "session_feed";
      sessionId: string;
      feedEpoch: string;
      feedSeq: number;
      runId?: string;
      turnId?: string;
      entryId?: string;
      phase: "delta" | "committed" | "status";
      event: SessionLiveEvent;
    }
  | {
      type: "feed_snapshot";
      sessionId: string;
      feedEpoch: string;
      feedSeq: number;
      active: null | {
        runId: string;
        turnId: string;
        entryId: string;
        by?: string;
        text: string;
        startedAt: number;
      };
    }
  // The same live-turn frames a feed server wraps in session_feed.event.
  | SessionLiveEvent
  | { type: "usage_update"; sessionId: string; usage: SessionUsage }
  | {
      type: "session_created";
      id: string;
      workspaceId?: string;
      /** True when this create made a brand-new workspace (vs. adding a session). */
      newWorkspace?: boolean;
      /** True while the session's worktree is still being created. */
      preparingWorkspace?: boolean;
      /** Stored result of an already-completed durable create command. */
      replayed?: boolean;
    }
  // The create run finished (or failed) preparing the session's worktree.
  | { type: "workspace_status"; sessionId: string; ready: boolean }
  | {
      type: "model_changed";
      sessionId: string;
      model: string;
      from?: string;
      by?: string;
    }
  | {
      type: "queue_update";
      sessionId: string;
      queued: QueuedPrompt[];
      steered?: QueuedPrompt[];
      /** Transcript entry ids accepted by the conversation but not yet read by
       *  the engine. Clients may render these sent bubbles with a quiet pending
       *  treatment without putting them back in the composer queue. */
      pendingDeliveryIds?: string[];
    }
  | {
      type: "queued_prompt_taken";
      sessionId: string;
      queueId: string;
      item?: QueuedPrompt;
      message?: string;
    }
  | {
      type: "ask_question";
      sessionId: string;
      questionId: string;
      questions: AskQuestion[];
    }
  | { type: "ask_resolved"; sessionId: string; questionId: string }
  | {
      /**
       * Quick-reply chips for the turn that just ended (server/reply-suggestions.ts).
       * `null` retires the row: the turn they answered has been answered.
       * Picking a chip fills the composer, so `text` is a draft, never a send.
       */
      type: "reply_suggestions";
      sessionId: string;
      suggestions: { label: string; text: string }[] | null;
    }
  | {
      type: "slack_composer";
      sessionId: string;
      request: {
        id: string;
        message: string;
        channel?: string;
        images: string[];
      } | null;
    }
  | {
      type: "slack_composer_resolved";
      sessionId: string;
      requestId: string;
      status: "sent" | "cancelled";
      /** Set when the message was sent, so viewers can show where it landed. */
      channel?: { id: string; name: string };
      permalink?: string;
      /** Message timestamp, so the sender can undo the post. */
      ts?: string;
    }
  | { type: "command_ack_result"; sessionId: string; requestId: string }
  | {
      type: "command_result";
      sessionId: string;
      requestId: string;
      status: "completed" | "failed";
      result?: unknown;
      error?: string;
      /** Failed validation is terminal; transient ownership/storage failures stay queued. */
      terminal?: boolean;
    }
  | { type: "notice"; sessionId?: string; message: string }
  | { type: "pong" }
  | { type: "error"; sessionId?: string; message: string };
