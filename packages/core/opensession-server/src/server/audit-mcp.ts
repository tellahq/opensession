/**
 * `opensession-audit`: read one day of this instance's own audit log, rolled
 * up. One tool, one optional date, no writes.
 *
 * It returns what GET /api/audit/digest serves: buildAuditDigest(date), the
 * compact roll-up of a day's ~10-20MB jsonl that the nightly Dreaming
 * reflection reads.
 *
 * Why a tool and not a fetch, same story as opensession-health. Dreaming is an
 * unattended automation, and an automation cannot reach its own host over
 * HTTP: web-fetch.ts refuses loopback and private addresses by design, and no
 * engine gives an unattended ask run a shell to curl with. Nor can it read the
 * files: Pi's ask tool list is read/grep/find/ls (pi-runner.ts) and those are
 * sandboxed to the session workspace, so ~/.opensession-audit is out of reach.
 * Moving automations to Pi (aeb73d59f) took the last path away, and the
 * reflection ran blind.
 *
 * Held to the automation in-process bar, same as opensession-health and
 * opensession-turn: the only argument is a date, validated against
 * YYYY-MM-DD before it becomes a filename component, so untrusted text cannot
 * steer it at a path, a glob or a range. It reads aggregate counters and
 * already-redacted event fields, writes nothing, and there is nothing here to
 * escalate with. Never grow this server past that: no raw event reads, no
 * arbitrary file paths.
 */

import { z } from "zod";
import { buildAuditDigest, listAuditDates } from "./audit";
import { createSdkMcpServer, tool } from "./inprocess-mcp";

/** A date is a filename component here, so nothing but a plain ISO day. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Detail arrays are capped harder than the endpoint caps them: a busy day's
 *  digest runs 50-70KB, which trips the engines' large-tool-output truncation
 *  and lands as a cut inline view. Better to hand back a whole document that
 *  says what it left out. */
const MAX_PAPERCUTS = 40;
const MAX_SESSIONS = 40;
/** Last-resort ceiling if the capped digest is still outsized (many error
 *  groups, long prompts). Detail sections drop until it fits. */
const MAX_CHARS = 120_000;

function yesterdayUtc(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

export interface AuditDigestDeps {
  build: (date: string) => Record<string, unknown> | null;
  dates: () => string[];
}

/**
 * The tool's whole answer, as data. Split out from the handler so the date
 * validation, the missing-log case and the size caps are testable without a
 * live audit directory (deps are injected in audit-mcp.test.ts).
 */
export function auditDigestPayload(
  date: string | undefined,
  deps: AuditDigestDeps = { build: buildAuditDigest, dates: listAuditDates }
): Record<string, unknown> {
  const day = date?.trim() || yesterdayUtc();
  if (!DATE_RE.test(day)) {
    return {
      ok: false,
      error: `invalid date ${JSON.stringify(day)}. Pass a single day as YYYY-MM-DD, or omit it for yesterday (UTC).`,
    };
  }

  const digest = deps.build(day);
  if (!digest) {
    return {
      ok: false,
      date: day,
      error: `no audit log for ${day}`,
      availableDates: deps.dates().slice(0, 7),
    };
  }

  const truncated: Record<string, { kept: number; dropped: number }> = {};
  const cap = (key: string, max: number) => {
    const list = digest[key];
    if (!Array.isArray(list) || list.length <= max) return;
    truncated[key] = { kept: max, dropped: list.length - max };
    digest[key] = list.slice(0, max);
  };
  // Papercuts and sessions are the two that grow with the day's volume; every
  // other section is already capped by buildAuditDigest.
  cap("papercuts", MAX_PAPERCUTS);
  cap("sessions", MAX_SESSIONS);

  const payload: Record<string, unknown> = { ok: true, ...digest };
  const size = () => JSON.stringify(payload).length;
  // Drop whole detail sections, least useful first, until the document fits.
  for (const key of ["sessions", "papercuts", "toolErrorGroups"]) {
    if (size() <= MAX_CHARS) break;
    const list = payload[key];
    if (!Array.isArray(list) || list.length === 0) continue;
    truncated[key] = { kept: 0, dropped: list.length + (truncated[key]?.dropped || 0) };
    payload[key] = [];
  }
  if (Object.keys(truncated).length > 0) {
    payload.truncated = truncated;
    payload.truncatedNote =
      "Some detail lists were shortened to keep this response readable. Totals above cover the whole day.";
  }
  return payload;
}

export function createAuditMcpServer() {
  const tools = [
    tool(
      "read_audit_digest",
      "Read one day of this instance's audit log, rolled up: totals (events, sessions, turns, errors, tool errors, cost), turn verdicts including silent drops, per-run-kind breakdown, model usage, the top recurring error and tool-error groups, top tools, one-shot counts, logged papercuts, and the most troubled sessions. Defaults to yesterday (UTC). Use this instead of trying to read ~/.opensession-audit or fetch the server over HTTP. Neither is reachable from an unattended run.",
      {
        date: z
          .string()
          .optional()
          .describe("Day to read, as YYYY-MM-DD. Defaults to yesterday (UTC). One day only."),
      },
      async ({ date }) => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(auditDigestPayload(date), null, 2),
          },
        ],
      })
    ),
  ];
  return createSdkMcpServer({ name: "opensession-audit", version: "1.0.0", tools });
}
