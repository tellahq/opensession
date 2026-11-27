import type { NativeLocalFolders } from "./local-folders/electron-provider";

export interface VoiceAudioDevice {
  id: string;
  label: string;
}

export interface NativeVoiceAudioBridge {
  devices(): Promise<{
    inputs: VoiceAudioDevice[];
    outputs: VoiceAudioDevice[];
    advancedDucking: boolean;
  }>;
  start(
    id: string,
    options: {
      inputDeviceId: string;
      outputDeviceId: string;
      ducking: boolean;
    },
  ): Promise<void>;
  push(id: string, samples: Float32Array): void;
  setPaused(id: string, paused: boolean): void;
  clearPlayback(id: string): void;
  stop(id: string): void;
  onAudio(
    callback: (payload: { id: string; samples: Float32Array }) => void,
  ): () => void;
  onError(
    callback: (payload: { id: string; error: string }) => void,
  ): () => void;
}

export interface OS1ShellBridge {
  desktop?: boolean;
  /** Folders on this Mac sessions may reach (lib/local-folders). */
  localFolders?: NativeLocalFolders;
  materialBackdrop?: boolean;
  focusWindow?: () => void;
  /** Centre the traffic lights on a titlebar row of this height (os1-mac
   *  preload). Older shells lack it and keep the lights for a 48px row. */
  setTitlebarHeight?: (height: number) => void;
  /** Dock badge count (os1-mac preload). */
  setBadge?: (count: number) => void;
  organizations?: unknown;
  updates?: unknown;
  voiceAudio?: NativeVoiceAudioBridge;
  /** A PNG data URL of this window's pixels inside `rect` (CSS pixels from
   *  the window's top left). The desktop app only; it can see framed
   *  cross-origin pages, which a web page cannot. */
  capturePage?: (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => Promise<string | null>;
  dictation?: {
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
}

declare global {
  interface Window {
    os1?: OS1ShellBridge;
  }
}

export function os1Shell(): OS1ShellBridge | undefined {
  return globalThis.window?.os1;
}
