/**
 * Worker for whole-day audit reads: Analytics/Home day rollups
 * (analytics-rollup.ts), the Dreaming digest and the Settings audit viewer
 * (audit.ts). A day's audit file reaches 100 MB; reading and parsing it on
 * the gateway thread blocked every request behind it. Spawned lazily by
 * audit-read-client.ts.
 *
 * All file I/O for those reads lives here, on the worker thread: the gateway
 * never imports this module, so synchronous reads cannot block it.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  ROLLUP_VERSION,
  rollupAuditContents,
  type DayRollup,
} from "./analytics-rollup";
import type { AuditEventQuery, AuditReadResult } from "./audit";

declare const self: Worker;

// Bun drops a message posted before the worker installs its handler, and
// ./audit (through the state-path module) finishes loading asynchronously.
// Queue the parent's first frames until the real handler is installed.
const startupMessages: MessageEvent[] = [];
self.onmessage = (event: MessageEvent) => {
  startupMessages.push(event);
};
const { buildAuditDigestFromLines, filterAuditEvents, isAuditDate } =
  await import("./audit");

export type AuditReadRequest = { id: number } & (
  | { kind: "rollup"; date: string; auditDir: string; cacheDir: string }
  | { kind: "digest"; date: string; auditDir: string }
  | { kind: "events"; query: AuditEventQuery; auditDir: string }
);

/** The day's rollup, recomputed only when the audit file's size changed
 * since the cached one. */
function cachedAuditRollup(
  date: string,
  auditDir: string,
  cacheDir: string,
): DayRollup {
  const src = `${auditDir}/audit-${date}.jsonl`;
  const size = existsSync(src) ? statSync(src).size : 0;
  const cachePath = `${cacheDir}/day-${date}.json`;
  try {
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
      if (cached.v === ROLLUP_VERSION && cached.size === size)
        return cached.rollup;
    }
  } catch {}
  const rollup = rollupAuditContents(
    date,
    size ? readFileSync(src, "utf8") : "",
  );
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ v: ROLLUP_VERSION, size, rollup }),
    );
  } catch (e) {
    console.error("[analytics] rollup cache write failed:", e);
  }
  return rollup;
}

/** One day's audit file, or null when the date is malformed or the file is
 *  missing. */
function readAuditDay(dir: string, date: string): string | null {
  const path = `${dir}/audit-${date}.jsonl`;
  if (!isAuditDate(date) || !existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

function readAuditEventsIn(
  dir: string,
  opts: AuditEventQuery,
): AuditReadResult {
  const contents = readAuditDay(dir, opts.date);
  if (contents === null) return { events: [], total: 0, types: [] };
  return filterAuditEvents(contents, opts);
}

function buildAuditDigestIn(
  dir: string,
  date: string,
): Record<string, unknown> | null {
  const contents = readAuditDay(dir, date);
  return contents === null ? null : buildAuditDigestFromLines(date, contents);
}

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
