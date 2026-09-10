// WebRTC client for Desk voice mode on GPT-Live. The browser only carries
// audio: it posts its SDP offer to the server, which creates the Live session
// with the instance key and hands back the answer. Tool calls, transcript
// mirroring, and typed text all happen server-side over the session's
// sideband (src/server/desk-voice-live.ts); the data channel here is limited
// to lifecycle and transcript events plus `session.close`.

import { z } from "zod";
import { BASE_PATH } from "./base";

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
});

const liveEventSchema = z.object({
  type: z.string(),
  reason: z.string().optional(),
  error: z
    .object({ message: z.string().optional() })
    .optional()
    .catch(undefined),
  message: z.string().optional(),
});

type VoiceRequest =
  | { user: string; sdp: string }
  | { user: string; liveSessionId: string; text: string }
  | { user: string; liveSessionId: string };

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
  private started: (() => void) | null = null;

  private onVisibilityChange = () => {
    if (document.hidden) this.stop();
  };

  constructor(opts: {
    user: string;
    onState: (s: DeskVoiceState, detail?: string) => void;
  }) {
    this.user = opts.user;
    this.onState = opts.onState;
  }

  get active(): boolean {
    return this.connected && !this.closing;
  }

  async start(): Promise<void> {
    if (this.connected) return;
    this.onState("connecting");
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
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
      this.onState("error", "Microphone permission denied");
      throw new Error("Microphone permission denied");
    }

    const pc = new RTCPeerConnection();
    this.pc = pc;
    for (const track of this.micStream.getTracks())
      pc.addTrack(track, this.micStream);

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
      this.liveSessionId = live.liveSessionId;
      await pc.setRemoteDescription({ type: "answer", sdp: live.sdp });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to start call";
      this.onState("error", message);
      this.teardown();
      throw new Error(message);
    }

    document.addEventListener("visibilitychange", this.onVisibilityChange);

    // The HTTP exchange started the session; it is live once the data
    // channel delivers session.started.
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.started = null;
        reject(new Error("Call did not start"));
      }, SESSION_START_TIMEOUT_MS);
      this.started = () => {
        window.clearTimeout(timer);
        this.started = null;
        resolve();
      };
    }).catch((e: Error) => {
      this.onState("error", e.message);
      this.teardown();
      throw e;
    });
  }

  /** Hang up. Asks the session to close and waits briefly for the final
   * `session.closed` so pending backend work drains; tears down regardless. */
  stop(): void {
    if (this.closing) return;
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
    if (this.liveSessionId && this.connected) {
      void postJson(
        "/live/close",
        { user: this.user, liveSessionId: this.liveSessionId },
        okResponseSchema,
        { keepalive: true },
      ).catch(() => {});
    }
    this.teardown();
  }

  private teardown() {
    for (const key of ["idleTimer", "speakingTimer", "closeTimer"] as const) {
      const t = this[key];
      if (t !== null) window.clearTimeout(t);
      this[key] = null;
    }
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
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
    this.started = null;
    if (wasConnected) this.onState("idle");
  }

  /** Typed text during a call: queued on the backend server-side, mirrored
   * there as a user turn. False when there is no live call to take it. */
  sendText(text: string): boolean {
    if (!this.active || !this.liveSessionId) return false;
    this.resetIdleTimer();
    void postJson(
      "/live/text",
      { user: this.user, liveSessionId: this.liveSessionId, text },
      okResponseSchema,
    ).catch((e) => {
      console.warn("desk voice typed message failed:", e);
    });
    return true;
  }

  private resetIdleTimer() {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.stop(), IDLE_TIMEOUT_MS);
  }

  private handleEvent(raw: string) {
    let event: z.infer<typeof liveEventSchema>;
    try {
      event = liveEventSchema.parse(JSON.parse(raw));
    } catch {
      return;
    }
    if (this.closing && event.type !== "session.closed") return;

    switch (event.type) {
      case "session.started":
        this.connected = true;
        this.resetIdleTimer();
        this.onState("listening");
        this.started?.();
        break;
      case "session.input_transcript.delta":
        this.resetIdleTimer();
        this.onState("listening");
        break;
      case "session.output_transcript.delta":
        this.resetIdleTimer();
        this.onState("speaking");
        if (this.speakingTimer !== null)
          window.clearTimeout(this.speakingTimer);
        this.speakingTimer = window.setTimeout(() => {
          this.speakingTimer = null;
          if (this.active) this.onState("listening");
        }, SPEAKING_SETTLE_MS);
        break;
      case "session.delegation.created":
        this.resetIdleTimer();
        this.onState("thinking");
        break;
      case "session.closed": {
        const reason = event.reason ?? "";
        const requested =
          this.closing ||
          reason === "close_requested" ||
          reason === "remote_hangup";
        if (!requested)
          this.onState("error", `Call ended (${reason || "unknown"})`);
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
