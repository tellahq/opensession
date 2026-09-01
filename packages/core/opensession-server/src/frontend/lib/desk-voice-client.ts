// WebRTC client for Desk voice mode, driving a live call against OpenAI's
// Realtime API. The server hands out a short-lived client secret (never the
// real API key) plus a model id; this module opens the peer connection
// directly to OpenAI, mirrors the call's transcript back to the server, and
// routes function calls through the server's tool endpoint.

import { BASE_PATH } from "./base";
import { randomUUID } from "./random-uuid";

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

interface SecretResponse {
  clientSecret: string;
  expiresAt: number;
  model: string;
  sessionId: string;
}

interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
}

type RealtimeEvent = { type: string; [key: string]: unknown };

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!res.ok) throw new Error(data?.error || `${path}: HTTP ${res.status}`);
  return data as T;
}

export class DeskVoiceClient {
  private user: string;
  private onState: (s: DeskVoiceState, detail?: string) => void;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private micStream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;

  private idleTimer: number | null = null;
  private connected = false;

  // Transcript mirror POSTs are serialized so rapid finals (barge-in,
  // fast turn-taking) can't race each other out of order at the server.
  private transcriptQueue: Promise<void> = Promise.resolve();

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
    return this.connected;
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

    let secret: SecretResponse;
    try {
      secret = await postJson<SecretResponse>("/secret", { user: this.user });
    } catch (e) {
      this.teardownMedia();
      const message = e instanceof Error ? e.message : "Failed to start call";
      this.onState("error", message);
      throw new Error(message);
    }

    const pc = new RTCPeerConnection();
    this.pc = pc;

    for (const track of this.micStream.getTracks()) {
      pc.addTrack(track, this.micStream);
    }

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
      if (
        state === "failed" ||
        state === "disconnected" ||
        state === "closed"
      ) {
        this.onState("error", "connection lost");
        this.stop();
      }
    };

    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.onopen = () => {
      this.connected = true;
      this.resetIdleTimer();
      this.onState("listening");
    };
    dc.onmessage = (event) => this.handleEvent(event.data);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const answerRes = await fetch(
        `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(secret.model)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secret.clientSecret}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp,
        },
      );
      if (!answerRes.ok) {
        throw new Error(`Realtime call failed: HTTP ${answerRes.status}`);
      }
      const answerSdp = await answerRes.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to connect call";
      this.onState("error", message);
      this.stop();
      throw new Error(message);
    }

    document.addEventListener("visibilitychange", this.onVisibilityChange);

    // Wait for the data channel to actually open before resolving.
    await new Promise<void>((resolve, reject) => {
      if (dc.readyState === "open") return resolve();
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Call closed before it opened"));
      };
      const cleanup = () => {
        dc.removeEventListener("open", onOpen);
        dc.removeEventListener("close", onClose);
      };
      dc.addEventListener("open", onOpen);
      dc.addEventListener("close", onClose);
    });
  }

  stop(): void {
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.teardownMedia();
    this.connected = false;
    this.onState("idle");
  }

  private teardownMedia() {
    if (this.dc) {
      this.dc.onmessage = null;
      this.dc.onopen = null;
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
  }

  sendText(text: string): boolean {
    if (!this.dc || this.dc.readyState !== "open") return false;
    this.resetIdleTimer();
    this.dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      }),
    );
    this.dc.send(JSON.stringify({ type: "response.create" }));
    this.mirrorTranscript({
      id: "voice-typed-" + randomUUID(),
      role: "user",
      text,
    });
    return true;
  }

  private resetIdleTimer() {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.stop(), IDLE_TIMEOUT_MS);
  }

  private mirrorTranscript(entry: TranscriptEntry) {
    if (!entry.text.trim()) return;
    this.transcriptQueue = this.transcriptQueue.then(async () => {
      try {
        await postJson("/transcript", { user: this.user, entries: [entry] });
      } catch (e) {
        console.warn("desk voice transcript mirror failed:", e);
      }
    });
  }

  private async handleFunctionCall(event: RealtimeEvent) {
    const callId = String(event.call_id ?? "");
    const name = String(event.name ?? "");
    this.onState("action", name);

    let args: unknown = {};
    try {
      args = JSON.parse(String(event.arguments ?? "{}"));
    } catch {
      args = {};
    }

    let output: unknown;
    try {
      const res = await postJson<{ result: unknown }>("/tool", {
        user: this.user,
        callId,
        name,
        args,
      });
      output = res.result;
    } catch (e) {
      output = { error: e instanceof Error ? e.message : "Tool call failed" };
    }

    if (!this.dc || this.dc.readyState !== "open") return;
    this.dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(output),
        },
      }),
    );
    this.dc.send(JSON.stringify({ type: "response.create" }));
  }

  private handleEvent(raw: string) {
    this.resetIdleTimer();
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.onState("listening");
        break;
      case "response.created":
        this.onState("thinking");
        break;
      case "response.output_audio_transcript.delta":
        this.onState("speaking");
        break;
      case "response.done":
        this.onState("listening");
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(event.transcript ?? "");
        this.mirrorTranscript({
          id: "voice-" + String(event.item_id ?? randomUUID()),
          role: "user",
          text,
        });
        break;
      }
      case "response.output_audio_transcript.done": {
        const text = String(event.transcript ?? "");
        this.mirrorTranscript({
          id: "voice-" + String(event.item_id ?? randomUUID()),
          role: "assistant",
          text,
        });
        break;
      }
      case "response.function_call_arguments.done":
        void this.handleFunctionCall(event);
        break;
      case "error": {
        const err = event.error as { message?: string } | undefined;
        this.onState("error", err?.message);
        break;
      }
      default:
        break; // unknown event types are ignored
    }
  }
}
