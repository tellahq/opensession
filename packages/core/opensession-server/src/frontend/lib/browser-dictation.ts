import { os1Shell } from "./os1-shell";

/**
 * Live browser speech recognition for web dictation.
 *
 * Chrome and Safari can return partial text while the microphone is still
 * open. VoiceInput records the same utterance as a fallback, so a missing or
 * failed browser recognizer still uses the server's full-clip transcription.
 */

import { randomUUID } from "./random-uuid";

type SpeechResult = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
};

type SpeechResultList = {
  readonly length: number;
  readonly [index: number]: SpeechResult;
};

type SpeechResultEvent = Event & { readonly results: SpeechResultList };

type SpeechErrorEvent = Event & { readonly error?: string };

type SpeechRecognizer = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognizerConstructor = new () => SpeechRecognizer;

type DesktopDictationAPI = {
  start(
    id: string,
    sampleRate: number,
    language: string,
  ): Promise<{ ok?: boolean }>;
  push(id: string, samples: Float32Array): void;
  finish(id: string): Promise<{ text?: string }>;
  cancel(id: string): void;
  onText(
    callback: (payload: { id?: string; text?: string }) => void,
  ): () => void;
};

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognizerConstructor;
    webkitSpeechRecognition?: SpeechRecognizerConstructor;
    webkitAudioContext?: typeof AudioContext;
  }
}

const FINAL_RESULT_WAIT_MS = 700;

function joinSpeech(left: string, right: string): string {
  const a = left.trim();
  const b = right.trim();
  if (!a) return b;
  if (!b) return a;
  return `${a} ${b}`;
}

export function speechResultsText(results: SpeechResultList): string {
  let text = "";
  for (let index = 0; index < results.length; index++) {
    text = joinSpeech(text, results[index]?.[0]?.transcript || "");
  }
  return text;
}

export type BrowserDictation = {
  /** Ask the recognizer for its final correction, with a short hard bound. */
  finish(): Promise<string>;
  /** Stop without keeping any recognized text. */
  cancel(): void;
};

function startDesktopDictation(
  api: DesktopDictationAPI,
  stream: MediaStream,
  onTranscript: (text: string) => void,
): BrowserDictation | null {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;

  let context: AudioContext;
  let source: MediaStreamAudioSourceNode;
  let processor: ScriptProcessorNode;
  let silentOutput: GainNode;
  try {
    context = new Ctx();
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(2_048, 1, 1);
    silentOutput = context.createGain();
    silentOutput.gain.value = 0;
    source.connect(processor);
    processor.connect(silentOutput);
    silentOutput.connect(context.destination);
  } catch {
    return null;
  }

  const id = randomUUID();
  let stopped = false;
  const unsubscribe = api.onText((payload) => {
    if (payload.id === id && payload.text) onTranscript(payload.text);
  });
  const started = api
    .start(
      id,
      context.sampleRate,
      navigator.languages?.[0] || navigator.language || "en-US",
    )
    .catch(() => ({ ok: false }));

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    // Web Audio reuses its channel buffer after this callback. Copy before the
    // context bridge transfers the samples to Electron's main process.
    api.push(id, new Float32Array(event.inputBuffer.getChannelData(0)));
  };

  function stopCapture() {
    if (stopped) return;
    stopped = true;
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
    silentOutput.disconnect();
    void context.close().catch(() => {});
    unsubscribe();
  }

  return {
    async finish() {
      // Let the final audio callback include the release of the last word.
      await new Promise((resolve) => window.setTimeout(resolve, 45));
      stopCapture();
      const status = await started;
      if (!status?.ok) {
        api.cancel(id);
        return "";
      }
      return (
        (await api.finish(id).catch(() => ({ text: "" }))).text?.trim() || ""
      );
    },
    cancel() {
      stopCapture();
      api.cancel(id);
    },
  };
}

/**
 * Start the fastest live recognizer this client provides. Electron streams PCM
 * to its native Apple Speech helper. Browsers use Web Speech. MediaRecorder
 * keeps running in parallel because either live service can still fail.
 */
export function startBrowserDictation(
  onTranscript: (text: string) => void,
  stream?: MediaStream,
): BrowserDictation | null {
  if (typeof window === "undefined") return null;
  const desktop = os1Shell()?.dictation;
  if (desktop && stream) {
    const native = startDesktopDictation(desktop, stream, onTranscript);
    if (native) return native;
  }
  const Recognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return null;

  let recognition: SpeechRecognizer;
  try {
    recognition = new Recognition();
  } catch {
    return null;
  }

  let prefix = "";
  let sessionText = "";
  let active = true;
  let finishing = false;
  let failed = false;
  let finishPromise: Promise<string> | null = null;
  let resolveFinish: ((text: string) => void) | null = null;
  let finishTimer: number | null = null;
  let restartTimer: number | null = null;

  const currentText = () => joinSpeech(prefix, sessionText);

  function settle() {
    if (finishTimer !== null) window.clearTimeout(finishTimer);
    finishTimer = null;
    resolveFinish?.(failed && !currentText() ? "" : currentText());
    resolveFinish = null;
  }

  function begin() {
    if (!active || finishing || failed) return;
    try {
      recognition.start();
    } catch {
      failed = true;
    }
  }

  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.lang = navigator.languages?.[0] || navigator.language || "en-US";
  recognition.onresult = (event) => {
    sessionText = speechResultsText(event.results);
    const text = currentText();
    if (text) onTranscript(text);
  };
  recognition.onerror = (event) => {
    // Aborting is the normal cancel path. Any other failure leaves the audio
    // recorder in charge of transcription.
    if (event.error !== "aborted") failed = true;
  };
  recognition.onend = () => {
    if (finishing || !active || failed) {
      settle();
      return;
    }

    // Chrome can close a continuous recognition session after a long pause.
    // Keep its text and reopen the service while recording remains active.
    prefix = currentText();
    sessionText = "";
    restartTimer = window.setTimeout(() => {
      restartTimer = null;
      begin();
    }, 0);
  };

  try {
    recognition.start();
  } catch {
    return null;
  }

  return {
    finish() {
      if (finishPromise) return finishPromise;
      active = false;
      finishing = true;
      if (restartTimer !== null) window.clearTimeout(restartTimer);
      restartTimer = null;
      if (failed) {
        finishPromise = Promise.resolve("");
        return finishPromise;
      }
      finishPromise = new Promise<string>((resolve) => {
        resolveFinish = resolve;
        finishTimer = window.setTimeout(settle, FINAL_RESULT_WAIT_MS);
      });
      try {
        recognition.stop();
      } catch {
        settle();
      }
      return finishPromise;
    },
    cancel() {
      active = false;
      finishing = true;
      if (restartTimer !== null) window.clearTimeout(restartTimer);
      if (finishTimer !== null) window.clearTimeout(finishTimer);
      restartTimer = null;
      finishTimer = null;
      resolveFinish?.("");
      resolveFinish = null;
      try {
        recognition.abort();
      } catch {
        // A recognizer that already ended needs no further cleanup.
      }
    },
  };
}
