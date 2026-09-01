/**
 * Before model switches became first-class timeline events, the runner also
 * emitted a synthetic assistant text chunk. New servers no longer send it,
 * but filtering the exact legacy shape keeps an already-running or older
 * backend stream from pinning the duplicate below the transcript.
 */
export function isTimelineOnlyRunnerNotice(text: string): boolean {
  return /^\s*\[runner\][\s\S]*;\s*falling back to [\s\S]*\.\s*$/i.test(text);
}
