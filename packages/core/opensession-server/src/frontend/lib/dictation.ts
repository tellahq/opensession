/** Append one transcript to a draft without disturbing its leading whitespace.
 * A dictated follow-up always receives one joining space. */
export function appendDictation(draft: string, transcript: string): string {
  return draft.trim()
    ? `${draft.replace(/\s+$/, "")} ${transcript}`
    : transcript;
}
