import { assistantPhase } from "@tellahq/opensession-protocol/message-disclosure";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";

/** Pi retains Responses message phases in its versioned text signature.
 * Other providers and older Pi messages have opaque signatures or none. */
export function piMessagePhase(
  signature: unknown,
): TranscriptEntry["assistantPhase"] {
  if (typeof signature !== "string" || !signature.startsWith("{"))
    return undefined;
  let value: unknown;
  try {
    value = JSON.parse(signature);
  } catch {
    return undefined;
  }
  if (
    value &&
    typeof value === "object" &&
    "v" in value &&
    value.v === 1 &&
    "id" in value &&
    typeof value.id === "string" &&
    "phase" in value
  )
    return assistantPhase(value.phase);
  return undefined;
}
