interface OS1ShellBridge {
  desktop?: boolean;
  materialBackdrop?: boolean;
  focusWindow?: () => void;
  organizations?: unknown;
  updates?: unknown;
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

interface Window {
  os1?: OS1ShellBridge;
}
