/**
 * Transcript-forwarder seam for detached run hosts.
 *
 * The transcript store (transcripts.db) has exactly one writer: the live
 * server. Engines that persist transcript entries in-process (pi today) work
 * unchanged in the server process, but inside a run host (local detached
 * unit, sandbox container, Runner machine) a direct store write would either
 * dead-end in a filesystem nobody reads (sandbox/Runner) or make the host a
 * second writer on the live database (local). The run-host entry
 * (src/runner-host/host.ts) registers a forwarder here before driving the
 * run; engine drivers consult it per append and hand the batch to the host,
 * which relays it to the server over the run-host protocol's `transcript`
 * frame. The server applies it via applyForwardedTranscript
 * (pi-transcript.ts): one writer, full fidelity.
 *
 * Registration is process-local state parked on globalThis (hot-reload safe,
 * import side-effect free). No forwarder registered (the normal server
 * process) means engines write the store directly, exactly as before.
 */

export type TranscriptForwarder = (
  engineSessionId: string,
  lines: Record<string, unknown>[],
) => void;

const g = globalThis as { __osTranscriptForwarder?: TranscriptForwarder };

export function setTranscriptForwarder(
  fn: TranscriptForwarder | undefined,
): void {
  g.__osTranscriptForwarder = fn;
}

export function transcriptForwarder(): TranscriptForwarder | undefined {
  return g.__osTranscriptForwarder;
}
