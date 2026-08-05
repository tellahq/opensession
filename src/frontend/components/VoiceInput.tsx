import React, { useEffect, useRef, useState } from "react";
import { transcribeClip } from "../lib/api";
import { IconCheck, IconMic, IconPlus, IconX } from "./icons";
import { Tooltip } from "../ui/tooltip";
import { PRODUCT_NAME } from "../lib/brand";
import { cn } from "../ui/cn";

type Phase = "idle" | "recording" | "transcribing";

/** Dictation is capped — this is a chat input, not a memo recorder. */
const MAX_SECONDS = 120;
const BAR_COUNT = 72;

/**
 * Wispr-Flow-style dictation control shared by the chat Composer and the
 * New-session palette. Idle it's just a mic button; tapping it swaps the whole
 * input surface for a compact recording bar (+ lead, live waveform, cancel ×,
 * accept ↑), then a "Transcribing…" bar while the clip runs through
 * /api/transcribe, and finally hands the text to `onText`.
 *
 * The bar renders as an absolutely-positioned overlay filling the nearest
 * positioned ancestor — the host container (.composer / .palette-card) must be
 * `position: relative`.
 */
export function VoiceInput({
  onText,
  disabled,
}: {
  onText: (text: string) => void;
  disabled?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const acceptRef = useRef(false);
  const timersRef = useRef<number[]>([]);

  function cleanup() {
    timersRef.current.forEach((t) => clearInterval(t));
    timersRef.current = [];
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    recRef.current = null;
  }
  useEffect(() => cleanup, []);

  // Errors show as a small bubble above the control; clear themselves.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  async function start() {
    setError(null);
    // getUserMedia only exists in secure contexts — over plain http (the
    // :3850 hostname) the mic simply isn't there.
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError(`Mic needs HTTPS. Open ${PRODUCT_NAME} at its ts.net URL.`);
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      setError("Microphone permission denied");
      return;
    }
    streamRef.current = stream;
    // Chrome/Firefox record webm/opus; iOS Safari only does mp4/AAC. The
    // server transcodes whatever container we send.
    const mime =
      ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) =>
        MediaRecorder.isTypeSupported?.(m),
      ) || "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recRef.current = rec;
    chunksRef.current = [];
    acceptRef.current = false;
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const accepted = acceptRef.current;
      const blob = new Blob(chunksRef.current, {
        type: rec.mimeType || mime || "audio/webm",
      });
      cleanup();
      if (accepted) void finish(blob);
      else setPhase("idle");
    };

    // Live level meter for the waveform — progressive enhancement, recording
    // works fine without it.
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new Ctx();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      timersRef.current.push(
        window.setInterval(() => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          setLevels((prev) => [...prev.slice(-(BAR_COUNT - 1)), Math.min(1, rms * 4)]);
        }, 90),
      );
    } catch {
      // no waveform, no problem
    }

    const startedAt = Date.now();
    setLevels([]);
    timersRef.current.push(
      window.setInterval(() => {
        if (Date.now() - startedAt >= MAX_SECONDS * 1000) stop(true);
      }, 1000),
    );
    rec.start(250);
    setPhase("recording");
  }

  function stop(accept: boolean) {
    const rec = recRef.current;
    if (!rec || rec.state === "inactive") return;
    acceptRef.current = accept;
    if (accept) setPhase("transcribing");
    rec.stop();
  }

  async function finish(blob: Blob) {
    try {
      const text = await transcribeClip(blob);
      if (text) onText(text);
      else setError("Heard nothing. Try again.");
    } catch (e: any) {
      setError(e?.message || "Transcription failed");
    } finally {
      setPhase("idle");
    }
  }

  return (
    <>
      <Tooltip label="Dictate">
        <button
          type="button"
          className="palette-icon-btn voice-mic-btn"
          onClick={start}
          disabled={disabled || phase !== "idle"}
          aria-label="Dictate"
        >
          <IconMic size={20} />
        </button>
      </Tooltip>
      {error && phase === "idle" && <div className="voice-error absolute right-0 bottom-[calc(100%+8px)] z-[7] whitespace-nowrap rounded-[calc(10px*var(--rf))] border border-[color-mix(in_srgb,var(--red)_40%,transparent)] bg-red-soft px-[11px] py-[7px] text-supporting font-medium text-red [corner-shape:var(--cs)]">{error}</div>}
      {phase !== "idle" && (
        <div className="voice-overlay absolute inset-x-0 bottom-0 z-[6] flex h-[54px] items-center gap-2.5 rounded-b-[calc(16px*var(--rf))] border-t border-line bg-raised pr-3.5 pl-3 [corner-shape:var(--cs)]">
          <span className="voice-lead inline-flex shrink-0 items-center text-faint" aria-hidden="true">
            <IconPlus size={22} />
          </span>
          {phase === "recording" ? (
            <>
              {/* Full-width track: baseline dots on the quiet/older left, live
                  bars accumulating on the right by the accept button. */}
              <div className="voice-wave flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-hidden" aria-hidden="true">
                {Array.from({ length: BAR_COUNT }, (_, i) => {
                  const l = levels[levels.length - BAR_COUNT + i];
                  const active = l !== undefined;
                  return (
                    <span
                      key={i}
                      className={cn("mx-auto h-0.5 w-0.5 min-w-0 max-w-0.5 flex-[1_1_0] rounded-[calc(2px*var(--rf))] bg-faint [corner-shape:var(--cs)]", active && "is-live bg-dim transition-[height] duration-[90ms] ease-linear")}
                      style={{ height: active ? `${16 + l * 84}%` : undefined }}
                    />
                  );
                })}
              </div>
              <Tooltip label="Cancel">
                <button
                  type="button"
                  className="voice-glyph voice-cancel inline-flex size-[34px] shrink-0 items-center justify-center rounded-[calc(8px*var(--rf))] bg-transparent text-dim transition-[color,background] duration-150 [corner-shape:var(--cs)] hover:bg-hover hover:text-fg"
                  onClick={() => stop(false)}
                  aria-label="Cancel dictation"
                >
                  <IconX size={22} />
                </button>
              </Tooltip>
              <Tooltip label="Stop and transcribe">
                <button
                  type="button"
                  className="voice-glyph voice-accept inline-flex size-[34px] shrink-0 items-center justify-center rounded-[calc(8px*var(--rf))] bg-transparent text-fg transition-[color,background] duration-150 [corner-shape:var(--cs)] hover:bg-hover hover:text-accent"
                  onClick={() => stop(true)}
                  aria-label="Stop and transcribe"
                >
                  <IconCheck size={22} />
                </button>
              </Tooltip>
            </>
          ) : (
            <>
              <span className="voice-spinner size-4 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-dim motion-reduce:animate-none" aria-hidden="true" />
              <span className="voice-status shrink-0 text-control-label font-medium text-dim">Transcribing…</span>
              <span className="voice-wave-spacer flex-1" />
            </>
          )}
        </div>
      )}
    </>
  );
}
