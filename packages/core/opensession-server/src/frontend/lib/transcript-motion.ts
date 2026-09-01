export const TRANSCRIPT_ENTER_CLASS =
  "[animation:transcript-enter_var(--dur)_var(--ease)]";

export function transcriptEnterClass(enter: boolean): string | undefined {
  return enter ? TRANSCRIPT_ENTER_CLASS : undefined;
}
