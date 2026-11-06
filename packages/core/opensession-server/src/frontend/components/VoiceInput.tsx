import React, {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { motion } from "motion/react";
import { transcribeClip } from "../lib/api";
import { IconMic, IconStopSquare, IconX } from "./icons";
import { Tooltip } from "../ui/tooltip";
import { Spinner } from "../ui/spinner";
import { PRODUCT_NAME } from "../lib/brand";
import { cn } from "../ui/cn";
import { duration, ease } from "../ui/motion";
import { paletteIconBtn } from "../lib/palette-classes";
import { useShortcutKeys } from "../hooks/useShortcutBindings";
import { matchesShortcut } from "../lib/shortcuts";
import { effectiveSendKey, isSendCombo } from "../lib/send-key";
import { getSendKeyPref, onSendKeyChanged } from "../lib/send-key-pref";
import {
  startBrowserDictation,
  type BrowserDictation,
} from "../lib/browser-dictation";
import { errorMessage } from "../lib/error-message";
import { DictationAudio } from "../lib/dictation-audio";
import { os1Shell } from "../lib/os1-shell";
import { VoiceAudioOptions } from "./composer/VoiceAudioSettings";

type Phase = "idle" | "requesting" | "recording" | "transcribing";

/** What a host can ask of a live dictation: its own send control stops the
 *  clip and sends the transcript, as the send key does. */
export interface VoiceInputControl {
  /** Stops and sends. False when nothing is recording. */
  send: () => boolean;
}

/** Dictation is capped. This is a session input, not a memo recorder. */
const MAX_SECONDS = 120;
/** Bars in the inline meter. Few enough to keep the pill compact. */
const BAR_COUNT = 12;
/** Bars in the row-wide meter. Enough for any phone width; the row clips
 *  the oldest on the left. */
const WIDE_BAR_COUNT = 64;

/* The live pill stands in for the mic, beside the host's send control. The
   field stays visible and editable above it: the transcript is appended to
   the draft when the clip ends. */
const PILL =
  "inline-flex h-10 shrink-0 items-center gap-1 rounded-full border border-line pl-3.5 pr-1 phone:h-11";
/** A phone has no room beside the model pill, so there the pill takes the
 *  whole toolbar row instead (the host hides its other controls). */
const PILL_WIDE =
  "flex h-11 min-w-0 flex-1 items-center gap-1 rounded-full border border-line px-0.5";
const PILL_STOP =
  "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-fg transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-50 phone:size-11";

/* Waveform bars. Colour lives on the variant, never alongside a second colour
   utility on the same element. Two of those don't compose, the sheet's order
   decides the winner. Bars without a sample yet are a 3px dot; live ones get
   their height inline from the level meter. */
const WAVE_BAR_IDLE = "h-[3px] w-[3px] shrink-0 rounded-full bg-faint";
const WAVE_BAR_LIVE =
  "h-[3px] w-[3px] shrink-0 rounded-full bg-dim transition-[height] duration-[90ms] ease-linear";

/** The pill arrives through a short blur rather than sliding. */
const PILL_MOTION = {
  initial: { opacity: 0, filter: "blur(4px)" },
  animate: { opacity: 1, filter: "blur(0px)" },
  transition: { type: "tween", duration: duration.base, ease },
} as const;

/**
 * Dictation control shared by the session Composer and the New-session
 * palette. Idle it's a mic button; tapping it swaps the mic for a compact
 * live pill (meter · stop) and leaves the field above it visible. Stop puts
 * the browser's final text in the draft through `onText`; the send key, or
 * the host's send control through `controlRef`, hands it to `onTextSend`
 * instead. Escape discards the clip. Browsers without live speech
 * recognition keep the /api/transcribe fallback.
 */
export function VoiceInput({
  onText,
  onTextSend,
  disabled,
  className = paletteIconBtn,
  editTargetRef,
  onActiveChange,
  shortcutActive = false,
  controlRef,
  wide = false,
}: {
  onText: (text: string) => void;
  /** Take the text and send it straight away. Without one, the send key only
   *  stops the clip. */
  onTextSend?: (text: string) => void;
  disabled?: boolean;
  /** Classes for the idle mic button, so it matches its neighbours. */
  className?: string;
  /** The draft field to restore after keeping, cancelling, or an error. */
  editTargetRef?: React.RefObject<HTMLElement | null>;
  /** Lets a host swap its send control while dictation is live. */
  onActiveChange?: (active: boolean) => void;
  /** Lets this visible Composer claim the app-wide dictate shortcut. */
  shortcutActive?: boolean;
  /** Lets the host's own send control stop and send. */
  controlRef?: React.Ref<VoiceInputControl>;
  /** Fill the host's row while live, with a cancel button: a phone has no
   *  room for the compact pill beside its other controls, and no Escape. */
  wide?: boolean;
}) {
  const dictateKeys = useShortcutKeys("composer-dictate");
  const [storedSendKey, setStoredSendKey] = useState(getSendKeyPref);
  useEffect(
    () => onSendKeyChanged(() => setStoredSendKey(getSendKeyPref())),
    [],
  );
  const sendKey = effectiveSendKey(storedSendKey);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const recRef = useRef<MediaRecorder | null>(null);
  const speechRef = useRef<BrowserDictation | null>(null);
  const speechResultRef = useRef<Promise<string> | null>(null);
  /** Invalidates an unresolved permission request when recording is cancelled
   *  or the control unmounts. A late stream is stopped instead of recording. */
  const requestRef = useRef(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const callbacksRef = useRef({ onText, onTextSend });
  const activeChangeRef = useRef(onActiveChange);
  useLayoutEffect(() => {
    callbacksRef.current = { onText, onTextSend };
    activeChangeRef.current = onActiveChange;
  }, [onText, onTextSend, onActiveChange]);
  const chunksRef = useRef<BlobPart[]>([]);
  const captureRef = useRef<DictationAudio | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const acceptRef = useRef(false);
  /** Which control ended the clip: send sends the result, stop keeps it. */
  const sendRef = useRef(false);
  const timersRef = useRef<number[]>([]);
  const idleButtonRef = useRef<HTMLButtonElement | null>(null);

  function cleanup() {
    timersRef.current.forEach((t) => clearInterval(t));
    timersRef.current = [];
    const recorder = recRef.current;
    recRef.current = null;
    if (recorder) {
      recorder.onstop = recorder.ondataavailable = recorder.onerror = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    captureRef.current?.stop();
    captureRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }

  function restoreEditorFocus() {
    requestAnimationFrame(() =>
      returnFocusRef.current?.focus({ preventScroll: true }),
    );
  }

  function failRecording(message: string, request: number) {
    if (request !== requestRef.current) return;
    requestRef.current++;
    speechRef.current?.cancel();
    speechRef.current = null;
    speechResultRef.current = null;
    cleanup();
    setError(message);
    setPhase("idle");
    restoreEditorFocus();
  }

  function finishCancellation() {
    setPhase("idle");
    restoreEditorFocus();
  }

  function stop(accept: boolean, send = false) {
    if (phase === "requesting") {
      requestRef.current++;
      cleanup();
      finishCancellation();
      return true;
    }
    const rec = recRef.current;
    if (!rec || rec.state === "inactive") return false;
    acceptRef.current = accept;
    sendRef.current = accept && send;
    const speech = speechRef.current;
    speechRef.current = null;
    if (accept) {
      setPhase("transcribing");
      speechResultRef.current = speech?.finish() ?? null;
    } else {
      speech?.cancel();
      speechResultRef.current = null;
    }
    rec.stop();
    return true;
  }
  useImperativeHandle(controlRef, () => ({ send: () => stop(true, true) }));

  async function finish(
    blob: Blob,
    request: number,
    browserResult: Promise<string> | null,
  ) {
    let restoreFocus = false;
    await (async () => {
      // A live browser result avoids uploading and reprocessing the complete
      // clip. The existing server transcription remains the fallback, so an
      // unsupported browser or a speech-service outage behaves as before.
      const liveText = (await browserResult?.catch(() => ""))?.trim() || "";
      const text = liveText || (await transcribeClip(blob));
      if (request !== requestRef.current) return;
      const callbacks = callbacksRef.current;
      if (!text) {
        setError("Heard nothing. Try again.");
        restoreFocus = true;
      } else if (sendRef.current && callbacks.onTextSend) {
        callbacks.onTextSend(text);
      } else {
        callbacks.onText(text);
        restoreFocus = true;
      }
    })()
      .catch((error) => {
        if (request !== requestRef.current) return;
        setError(errorMessage(error, "Transcription failed"));
        restoreFocus = true;
      })
      .finally(() => {
        if (request === requestRef.current) {
          sendRef.current = false;
          setPhase("idle");
          if (restoreFocus) restoreEditorFocus();
        }
      });
  }

  const start = async () => {
    setError(null);
    // getUserMedia only exists in secure contexts. Over plain http (the
    // :3850 hostname) the mic simply isn't there.
    if (
      (!os1Shell()?.voiceAudio && !navigator.mediaDevices?.getUserMedia) ||
      typeof MediaRecorder === "undefined"
    ) {
      setError(`Mic needs HTTPS. Open ${PRODUCT_NAME} at its ts.net URL.`);
      return;
    }
    // Take over the field in the same gesture that asked for the mic. Waiting
    // for a permission round trip first made the button appear unresponsive.
    const request = ++requestRef.current;
    speechRef.current?.cancel();
    speechRef.current = null;
    speechResultRef.current = null;
    setPhase("requesting");
    // The field stays visible and editable while recording; the transcript
    // is appended to it when the clip ends, and the caret returns there.
    returnFocusRef.current =
      editTargetRef?.current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);

    const capture = new DictationAudio((message) =>
      failRecording(message, request),
    );
    captureRef.current = capture;
    try {
      const stream = await capture.start();
      if (request !== requestRef.current) {
        capture.stop();
        return;
      }
      // Chrome/Firefox record webm/opus; iOS Safari only does mp4/AAC. The
      // server transcodes whatever container we send.
      const mime =
        ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) =>
          MediaRecorder.isTypeSupported?.(m),
        ) || "";
      const rec = new MediaRecorder(
        stream,
        mime ? { mimeType: mime } : undefined,
      );
      recRef.current = rec;
      chunksRef.current = [];
      acceptRef.current = false;
      sendRef.current = false;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      rec.onerror = () =>
        failRecording("Recording failed. Try again.", request);
      rec.onstop = () => {
        if (request !== requestRef.current) return;
        const accepted = acceptRef.current;
        const browserResult = speechResultRef.current;
        speechResultRef.current = null;
        const blob = new Blob(chunksRef.current, {
          type: rec.mimeType || mime || "audio/webm",
        });
        cleanup();
        if (accepted) void finish(blob, request, browserResult);
        else finishCancellation();
      };

      // Live level meter for the waveform is progressive enhancement. Recording
      // works fine without it.
      await (async () => {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const options: AudioContextOptions & { sinkId: { type: "none" } } = {
          sinkId: { type: "none" },
        };
        const ctx: AudioContext = new Ctx(options);
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
            setLevels((prev) => [
              ...prev.slice(-(WIDE_BAR_COUNT - 1)),
              Math.min(1, rms * 4),
            ]);
          }, 90),
        );
      })().catch(() => {
        // No waveform, no problem.
      });

      // Cancellation or unmount can happen while the optional meter starts.
      if (request !== requestRef.current) return;
      const startedAt = Date.now();
      setLevels([]);
      timersRef.current.push(
        window.setInterval(() => {
          if (Date.now() - startedAt >= MAX_SECONDS * 1000) stop(true);
        }, 1000),
      );
      rec.start(250);
      // Browser speech recognition streams partial text while the clip is still
      // being recorded. The audio blob remains the accuracy-preserving fallback
      // when the browser service is absent or fails.
      speechRef.current = startBrowserDictation(() => {}, stream);
      setPhase("recording");
    } catch (error) {
      capture.stop();
      failRecording(
        error instanceof Error && error.name === "NotAllowedError"
          ? "Microphone permission denied"
          : errorMessage(error, "Could not start dictation. Try again."),
        request,
      );
    }
  };

  useEffect(
    () => () => {
      requestRef.current++;
      speechRef.current?.cancel();
      speechRef.current = null;
      cleanup();
    },
    [],
  );

  const cancelHiddenCapture = useEffectEvent(() => {
    if (!captureRef.current) return;
    requestRef.current++;
    speechRef.current?.cancel();
    speechRef.current = null;
    speechResultRef.current = null;
    cleanup();
    setPhase("idle");
  });
  useEffect(() => {
    const onHidden = () => {
      if (document.hidden) cancelHiddenCapture();
    };
    window.addEventListener("pagehide", cancelHiddenCapture);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", cancelHiddenCapture);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);

  const active = phase !== "idle";
  // The shortcut listener reads the live start closure through an effect
  // event, so the subscription keys stay the enablement state.
  const startFromShortcut = useEffectEvent(function onKeyDown(
    event: KeyboardEvent,
  ) {
    if (
      event.defaultPrevented ||
      event.repeat ||
      disabled ||
      phase !== "idle" ||
      !matchesShortcut(event, "composer-dictate")
    )
      return;
    const button = idleButtonRef.current;
    const editorFocused = document.activeElement === editTargetRef?.current;
    if (!button || (!shortcutActive && !editorFocused)) return;
    if (button.closest("[inert], [hidden], [aria-hidden='true']")) return;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    if (!hit || (hit !== button && !button.contains(hit))) return;
    event.preventDefault();
    void start();
  });
  useEffect(() => {
    window.addEventListener("keydown", startFromShortcut);
    return () => window.removeEventListener("keydown", startFromShortcut);
  }, [disabled, editTargetRef, phase, shortcutActive]);
  // Capture phase, ahead of the field's own handlers: while a clip records,
  // the send key sends the clip (with the draft) and Escape discards it.
  const keysWhileRecording = useEffectEvent(function onKeyDown(
    event: KeyboardEvent,
  ) {
    if (event.defaultPrevented || event.repeat) return;
    const cancel = event.key === "Escape";
    if (!cancel && !(onTextSend && isSendCombo(event, sendKey))) return;
    event.preventDefault();
    event.stopPropagation();
    stop(!cancel, !cancel);
  });
  useEffect(() => {
    if (phase !== "recording" && phase !== "requesting") return;
    window.addEventListener("keydown", keysWhileRecording, true);
    return () =>
      window.removeEventListener("keydown", keysWhileRecording, true);
  }, [phase]);
  useEffect(() => {
    activeChangeRef.current?.(active);
    return () => {
      if (active) activeChangeRef.current?.(false);
    };
  }, [active]);
  // Errors show as a small bubble above the control; clear themselves.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  const recording = phase === "recording";
  const bars = wide ? WIDE_BAR_COUNT : BAR_COUNT;
  return (
    <>
      {phase === "idle" ? (
        <Tooltip label="Dictate" shortcut={dictateKeys ?? undefined}>
          <button
            ref={idleButtonRef}
            type="button"
            className={className}
            onClick={start}
            disabled={disabled}
            aria-label="Dictate"
          >
            <IconMic size={22} />
          </button>
        </Tooltip>
      ) : (
        <motion.div className={wide ? PILL_WIDE : PILL} {...PILL_MOTION}>
          <span className="sr-only" role="status" aria-live="polite">
            {phase === "requesting"
              ? "Starting dictation"
              : phase === "transcribing"
                ? "Transcribing"
                : "Recording"}
          </span>
          {wide && (
            <button
              type="button"
              className={cn(PILL_STOP, "text-dim")}
              onClick={() => stop(false)}
              disabled={phase === "transcribing"}
              aria-label="Discard dictation"
            >
              <IconX size={22} />
            </button>
          )}
          {/* Oldest samples on the left, the newest by the stop button. */}
          <span
            className={cn(
              "flex h-5 items-center gap-[3px]",
              wide
                ? "min-w-0 flex-1 justify-end overflow-hidden px-2"
                : "mr-1.5",
            )}
            aria-hidden="true"
          >
            {Array.from({ length: bars }, (_, i) => {
              const l = recording
                ? levels[levels.length - bars + i]
                : undefined;
              return (
                <span
                  key={i}
                  className={l === undefined ? WAVE_BAR_IDLE : WAVE_BAR_LIVE}
                  style={
                    l === undefined ? undefined : { height: `${15 + l * 85}%` }
                  }
                />
              );
            })}
          </span>
          {phase === "transcribing" ? (
            <span className="inline-flex size-8 items-center justify-center text-dim phone:size-11">
              <Spinner size="md" />
            </span>
          ) : (
            <Tooltip label="Stop. Esc discards it.">
              <button
                type="button"
                className={PILL_STOP}
                onClick={() => stop(true)}
                disabled={!recording}
                aria-label="Stop dictating"
              >
                <IconStopSquare size={20} />
              </button>
            </Tooltip>
          )}
          <VoiceAudioOptions mode="dictation" />
        </motion.div>
      )}
      {error && phase === "idle" && (
        <div
          role="alert"
          className="absolute bottom-[calc(100%+8px)] right-0 z-[7] whitespace-nowrap rounded-control border border-[color-mix(in_srgb,var(--red)_40%,transparent)] bg-red-soft px-[11px] py-[7px] text-supporting font-medium text-red"
        >
          {error}
        </div>
      )}
    </>
  );
}
