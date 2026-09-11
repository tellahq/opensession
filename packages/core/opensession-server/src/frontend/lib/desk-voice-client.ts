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
  /** `start()` is between its first await and `session.started`. */
  private starting = false;
  /** `stop()` came during `start()`; every later step bails out quietly. */
  private aborted = false;
  private startWaiter: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;

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
      this.onState("error", "Microphone permission denied");
      throw new Error("Microphone permission denied");
    }
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
      if (this.aborted) {
        // Hung up while the server was creating the session: it exists and
        // bills now, so close it from the server side.
        this.closeServerSide(live.liveSessionId);
        return;
      }
      this.liveSessionId = live.liveSessionId;
      await pc.setRemoteDescription({ type: "answer", sdp: live.sdp });
    } catch (e) {
      if (this.aborted) return;
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
      this.teardown();
      throw e;
    });
  }

  /** Hang up. Asks the session to close and waits briefly for the final
   * `session.closed` so pending backend work drains; tears down regardless. */
  stop(): void {
    if (this.closing || this.aborted) return;
    if (this.starting) {
      // Cancel the start in progress. Whatever step is awaiting sees
      // `aborted` and returns; a session the server already created is
      // closed here or by that step once its id is known.
      this.aborted = true;
      if (this.liveSessionId) this.closeServerSide(this.liveSessionId);
      this.startWaiter?.reject(new Error("Call cancelled"));
      this.teardown();
      this.onState("idle");
      return;
    }
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
    this.startWaiter = null;
    if (wasConnected) this.onState("idle");
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
        this.startWaiter?.resolve();
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
