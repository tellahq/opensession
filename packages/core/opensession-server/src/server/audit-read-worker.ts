/**
 * Worker for whole-day audit reads: Analytics/Home day rollups
 * (analytics-rollup.ts), the Dreaming digest and the Settings audit viewer
 * (audit.ts). A day's audit file reaches 100 MB; reading and parsing it on
 * the gateway thread blocked every request behind it. Spawned lazily by
 * audit-read-client.ts.
 */
import { cachedAuditRollup } from "./analytics-rollup";
import type { AuditEventQuery } from "./audit";

declare const self: Worker;

// Bun drops a message posted before the worker installs its handler, and the
// state-path module below finishes loading asynchronously. Queue the
// parent's first frames until the real handler is installed, then replay.
const startupMessages: MessageEvent[] = [];
self.onmessage = (event: MessageEvent) => {
  startupMessages.push(event);
};
const { buildAuditDigestIn, readAuditEventsIn } = await import("./audit");

export type AuditReadRequest = { id: number } & (
  | { kind: "rollup"; date: string; auditDir: string; cacheDir: string }
  | { kind: "digest"; date: string; auditDir: string }
  | { kind: "events"; query: AuditEventQuery; auditDir: string }
);

function run(request: AuditReadRequest): unknown {
  if (request.kind === "rollup")
    return cachedAuditRollup(request.date, request.auditDir, request.cacheDir);
  if (request.kind === "digest")
    return buildAuditDigestIn(request.auditDir, request.date);
  return readAuditEventsIn(request.auditDir, request.query);
}

self.onmessage = (event: MessageEvent<AuditReadRequest>) => {
  const { id } = event.data;
  try {
    self.postMessage({ id, ok: true, value: run(event.data) });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

for (const event of startupMessages) self.onmessage!.call(self, event);
startupMessages.length = 0;
