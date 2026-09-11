// WebRTC client for Desk voice mode on GPT-Live. The browser only carries
// audio: it posts its SDP offer to the server, which creates the Live session
// with the instance key and hands back the answer. Tool calls, transcript
// mirroring, and typed text all happen server-side over the session's
// sideband (src/server/desk-voice-live.ts); the data channel here is limited
// to lifecycle and transcript events plus `session.close`. The transcript
// events double as live captions (`onTranscript`): the server mirrors a row
// only once the utterance settles, and these arrive word by word.

import { z } from "zod";
import { BASE_PATH } from "./base";
import type { VoiceCaptionFragment, VoiceCaptionRole } from "./voice-captions";

export type DeskVoiceState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "action"
  | "error";

const API = `${BASE_PATH}/api/desk/voice`;
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const ICE_GATHER_TIMEOUT_MS = 10_000;
const SESSION_START_TIMEOUT_MS = 15_000;
/** Time to keep the call alive after asking to hang up, waiting for
 * `session.closed` so pending work drains and usage finalizes. */
const CLOSE_GRACE_MS = 5_000;
/** Assistant transcript deltas have no "done" event: after this quiet spell
 * the call is shown as listening again. */
const SPEAKING_SETTLE_MS = 1_500;

const liveResponseSchema = z.object({
  liveSessionId: z.string(),
  sdp: z.string(),
  sessionId: z.string(),
  backendModel: z.string().optional(),
});

const liveEventSchema = z.object({
  type: z.string(),
  reason: z.string().optional(),
  error: z
    .object({ message: z.string().optional() })
    .optional()
    .catch(undefined),
  message: z.string().optional(),
  // Transcript deltas: the text plus its place on the session timeline. A
  // malformed timestamp must not cost the state change the event carries.
  delta: z.string().optional().catch(undefined),
  start_ms: z.number().optional().catch(undefined),
  end_ms: z.number().optional().catch(undefined),
});

type LiveEvent = z.infer<typeof liveEventSchema>;

/** One audio-free, transcript-free line about how a call went, posted at
 * teardown to `/api/desk/voice/diag` (the server appends its own line with
 * the call's token totals under the same liveSessionId). Counters and
 * reasons only: nothing spoken or transcribed is ever in here. */
export interface DeskVoiceDiagReport {
  user: string;
  engine: "live";
  origin: "client";
  liveSessionId: string | null;
  backendModel: string | null;
  /** null when permission is still pending or was never requested. */
  micGranted: boolean | null;
  sawStarted: boolean;
  /** Why the client ended: hangup, idle, hidden, cancelled, connection
   * lost, data channel closed, start failed, session closed. */
  closeReason: string;
  /** OpenAI's reason from `session.closed`, when one was seen. */
  sessionCloseReason: string | null;
  /** From `session.started` to teardown. */
  durationSeconds: number;
  inputDeltas: number;
  outputDeltas: number;
  delegations: number;
  lastError: string | null;
}

type VoiceRequest =
  | { user: string; sdp: string }
  | { user: string; liveSessionId: string; text: string }
  | { user: string; liveSessionId: string }
  | DeskVoiceDiagReport;

const errorResponseSchema = z.object({ error: z.string().optional() });
const okResponseSchema = z.object({ ok: z.boolean() });

async function postJson<T>(
  path: string,
  body: VoiceRequest,
  responseSchema: z.ZodType<T>,
  init?: { keepalive?: boolean },
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: init?.keepalive,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = errorResponseSchema.safeParse(data);
    throw new Error(
      (error.success && error.data.error) || `${path}: HTTP ${res.status}`,
    );
  }
  return responseSchema.parse(data);
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onState);
      reject(new Error("Timed out gathering network candidates"));
    }, ICE_GATHER_TIMEOUT_MS);
    function onState() {
      if (pc.iceGatheringState !== "complete") return;
      window.clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onState);
      resolve();
    }
    pc.addEventListener("icegatheringstatechange", onState);
  });
}

export class DeskVoiceClient {
  private user: string;
  private onState: (s: DeskVoiceState, detail?: string) => void;
  private onCallStarted?: (callId: string) => void;
  private onTranscript?: (fragment: VoiceCaptionFragment) => void;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private micStream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private liveSessionId: string | null = null;

  private idleTimer: number | null = null;
  private speakingTimer: number | null = null;
  private closeTimer: number | null = null;
  private connected = false;
  private closing = false;
  /** `start()` is between its first await and `session.started`. */
  private starting = false;
  /** `stop()` came during `start()`; every later step bails out quietly. */
  private aborted = false;
  private startWaiter: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;

  // Diagnostics, kept as plain counters so the teardown line has nothing
  // to redact. See DeskVoiceDiagReport.
  private diagPosted = false;
  private backendModel: string | null = null;
  private micGranted: boolean | null = null;
  private startedAt: number | null = null;
  private closeReason: string | null = null;
  private sessionCloseReason: string | null = null;
  private inputDeltas = 0;
  private outputDeltas = 0;
  private delegations = 0;
  private lastError: string | null = null;

  private onVisibilityChange = () => {
    if (document.hidden) this.onPageHide();
  };

  private onPageHide = () => {
    this.closeReason ??= "hidden";
    this.aborted = true;
    if (this.liveSessionId) this.closeServerSide(this.liveSessionId);
    this.startWaiter?.reject(new Error("Call cancelled"));
    // A backgrounded/closing tab may never run the grace timer. Send the
    // keepalive diagnostic now rather than waiting for session.closed.
    this.teardown();
    this.onState("idle");
  };

  constructor(opts: {
    user: string;
    onState: (s: DeskVoiceState, detail?: string) => void;
    /** Every transcript fragment as the call delivers it, both speakers. */
    onTranscript?: (fragment: VoiceCaptionFragment) => void;
    onCallStarted?: (callId: string) => void;
  }) {
    this.user = opts.user;
    this.onState = (s, detail) => {
      if (s === "error") this.lastError = detail ?? "error";
      opts.onState(s, detail);
    };
    this.onTranscript = opts.onTranscript;
    this.onCallStarted = opts.onCallStarted;
  }

  /** Connecting or connected, and not hanging up: the handset shows this
   * state and `stop()` is the way out of it. */
  get active(): boolean {
    return (this.connected || this.starting) && !this.closing;
  }

  /** Resolves once the call is live, or returns early without an error when
   * `stop()` cancelled it midway. Throws on a failed start. */
  async start(): Promise<void> {
    if (this.connected || this.starting || this.aborted) return;
    this.starting = true;
    window.addEventListener("pagehide", this.onPageHide);
    try {
      await this.connect();
    } finally {
      this.starting = false;
    }
  }

  private async connect(): Promise<void> {
    this.onState("connecting");
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        // Explicit processing constraints: mobile browsers don't reliably
        // default to echo cancellation, and without it the phone's own
        // speaker output comes back in as user speech.
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      if (this.aborted) return;
      this.micGranted = false;
      this.onState("error", "Microphone permission denied");
      this.closeReason = "microphone denied";
      this.teardown();
      throw new Error("Microphone permission denied");
    }
    this.micGranted = true;
    if (this.aborted) {
      // Hung up while the permission prompt was open: teardown ran before
      // the stream existed, so release it here.
      for (const track of mic.getTracks()) track.stop();
      return;
    }
    this.micStream = mic;

    const pc = new RTCPeerConnection();
    this.pc = pc;
    for (const track of mic.getTracks()) pc.addTrack(track, mic);

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.srcObject = stream;
      this.audioEl = audio;
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "failed" || state === "disconnected") {
        this.onState("error", "connection lost");
        this.closeReason ??= "connection lost";
        this.teardown();
      }
    };

    // The data channel and its listeners exist before the offer so no
    // early event is missed.
    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.onmessage = (event) => this.handleEvent(event.data);
    dc.onclose = () => {
      if (this.connected && !this.closing) this.onState("error", "call ended");
      this.closeReason ??= "data channel closed";
      this.teardown();
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("No local offer");
      const live = await postJson(
        "/live",
        { user: this.user, sdp },
        liveResponseSchema,
      );
      if (this.aborted) {
        // Hung up while the server was creating the session: it exists and
        // bills now, so close it from the server side.
        this.closeServerSide(live.liveSessionId);
        return;
      }
      this.liveSessionId = live.liveSessionId;
      this.backendModel = live.backendModel ?? null;
      this.onCallStarted?.(live.liveSessionId);
      await pc.setRemoteDescription({ type: "answer", sdp: live.sdp });
    } catch (e) {
      if (this.aborted) return;
      const message = e instanceof Error ? e.message : "Failed to start call";
      this.onState("error", message);
      this.closeReason ??= "start failed";
      this.teardown();
      throw new Error(message);
    }

    document.addEventListener("visibilitychange", this.onVisibilityChange);

    // The HTTP exchange started the session; it is live once the data
    // channel delivers session.started.
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.startWaiter = null;
        reject(new Error("Call did not start"));
      }, SESSION_START_TIMEOUT_MS);
      this.startWaiter = {
        resolve: () => {
          window.clearTimeout(timer);
          this.startWaiter = null;
          resolve();
        },
        reject: (error) => {
          window.clearTimeout(timer);
          this.startWaiter = null;
          reject(error);
        },
      };
    }).catch((e: Error) => {
      if (this.aborted) return;
      this.onState("error", e.message);
      this.closeReason ??= "start failed";
      this.teardown();
      throw e;
    });
  }

  /** Hang up. Asks the session to close and waits briefly for the final
   * `session.closed` so pending backend work drains; tears down regardless.
   * `reason` is for the diag line only: who decided the call was over. */
  stop(reason = "hangup"): void {
    if (this.closing || this.aborted) return;
    if (this.starting) {
      // Cancel the start in progress. Whatever step is awaiting sees
      // `aborted` and returns; a session the server already created is
      // closed here or by that step once its id is known.
      this.aborted = true;
      this.closeReason ??= "cancelled";
      if (this.liveSessionId) this.closeServerSide(this.liveSessionId);
      this.startWaiter?.reject(new Error("Call cancelled"));
      this.teardown();
      this.onState("idle");
      return;
    }
    this.closeReason ??= reason;
    if (this.dc && this.dc.readyState === "open" && this.connected) {
      this.closing = true;
      this.onState("idle");
      this.dc.send(JSON.stringify({ type: "session.close" }));
      this.closeTimer = window.setTimeout(
        () => this.teardown(),
        CLOSE_GRACE_MS,
      );
      return;
    }
    // No usable data channel: ask the server to close it from its side.
    if (this.liveSessionId && this.connected)
      this.closeServerSide(this.liveSessionId);
    this.teardown();
  }

  private closeServerSide(liveSessionId: string) {
    void postJson(
      "/live/close",
      { user: this.user, liveSessionId },
      okResponseSchema,
      { keepalive: true },
    ).catch(() => {});
  }

  private teardown() {
    this.postDiag("teardown");
    for (const key of ["idleTimer", "speakingTimer", "closeTimer"] as const) {
      const t = this[key];
      if (t !== null) window.clearTimeout(t);
      this[key] = null;
    }
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("pagehide", this.onPageHide);
    if (this.dc) {
      this.dc.onmessage = null;
      this.dc.onclose = null;
      this.dc.close();
      this.dc = null;
    }
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.ontrack = null;
      this.pc.close();
      this.pc = null;
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop();
      this.micStream = null;
    }
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
      this.audioEl = null;
    }
    const wasConnected = this.connected;
    this.connected = false;
    this.closing = false;
    this.liveSessionId = null;
    this.startWaiter = null;
    if (wasConnected) this.onState("idle");
  }

  /** Once per client, at the end of the call, whatever ended it. Keepalive
   * so a closed tab (the most common way a call ends) still reports. Best
   * effort: a failure here is not worth surfacing. */
  private postDiag(fallbackReason: string) {
    if (this.diagPosted) return;
    this.diagPosted = true;
    const report: DeskVoiceDiagReport = {
      user: this.user,
      engine: "live",
      origin: "client",
      liveSessionId: this.liveSessionId,
      backendModel: this.backendModel,
      micGranted: this.micGranted,
      sawStarted: this.startedAt !== null,
      closeReason: this.closeReason ?? fallbackReason,
      sessionCloseReason: this.sessionCloseReason,
      durationSeconds:
        this.startedAt === null
          ? 0
          : Math.round((Date.now() - this.startedAt) / 1000),
      inputDeltas: this.inputDeltas,
      outputDeltas: this.outputDeltas,
      delegations: this.delegations,
      lastError: this.lastError?.slice(0, 500) ?? null,
    };
    void postJson("/diag", report, okResponseSchema, { keepalive: true }).catch(
      () => {},
    );
  }

  /** Typed text during a call: queued on the backend server-side, mirrored
   * there as a user turn. Resolves true only once the server has taken it;
   * false when there is no live call or the request failed, so the caller
   * keeps the draft instead of losing the message. */
  async sendText(text: string): Promise<boolean> {
    if (!this.connected || this.closing || !this.liveSessionId) return false;
    this.resetIdleTimer();
    try {
      const res = await postJson(
        "/live/text",
        { user: this.user, liveSessionId: this.liveSessionId, text },
        okResponseSchema,
      );
      return res.ok;
    } catch (e) {
      console.warn("desk voice typed message failed:", e);
      return false;
    }
  }

  private resetIdleTimer() {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(
      () => this.stop("idle"),
      IDLE_TIMEOUT_MS,
    );
  }

  private transcript(role: VoiceCaptionRole, event: LiveEvent) {
    if (!event.delta || !this.onTranscript) return;
    // The same fallbacks the server's row grouping applies to these fields.
    const startMs = event.start_ms ?? 0;
    this.onTranscript({
      role,
      delta: event.delta,
      startMs,
      endMs: event.end_ms ?? startMs,
    });
  }

  private handleEvent(raw: string) {
    let event: LiveEvent;
    try {
      event = liveEventSchema.parse(JSON.parse(raw));
    } catch {
      return;
    }
    if (this.closing && event.type !== "session.closed") return;

    switch (event.type) {
      case "session.started":
        this.connected = true;
        this.startedAt ??= Date.now();
        this.resetIdleTimer();
        this.onState("listening");
        this.startWaiter?.resolve();
        break;
      case "session.input_transcript.delta":
        this.inputDeltas += 1;
        this.resetIdleTimer();
        this.onState("listening");
        this.transcript("user", event);
        break;
      case "session.output_transcript.delta":
        this.outputDeltas += 1;
        this.resetIdleTimer();
        this.onState("speaking");
        this.transcript("assistant", event);
        if (this.speakingTimer !== null)
          window.clearTimeout(this.speakingTimer);
        this.speakingTimer = window.setTimeout(() => {
          this.speakingTimer = null;
          if (this.active) this.onState("listening");
        }, SPEAKING_SETTLE_MS);
        break;
      case "session.delegation.created":
        this.delegations += 1;
        this.resetIdleTimer();
        this.onState("thinking");
        break;
      case "session.closed": {
        const reason = event.reason ?? "";
        this.sessionCloseReason = reason || "unknown";
        const requested =
          this.closing ||
          reason === "close_requested" ||
          reason === "remote_hangup";
        if (!requested)
          this.onState("error", `Call ended (${reason || "unknown"})`);
        this.closeReason ??= "session closed";
        this.teardown();
        break;
      }
      case "error":
        this.onState("error", event.error?.message ?? event.message);
        break;
      default:
        break; // unknown event types are ignored
    }
  }
}
