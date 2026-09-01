import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSessionScratch,
  removeSessionScratch,
  type ScratchSweepSession,
  scratchDirsToSweep,
  sessionScratchRoot,
  sweepSessionScratch,
} from "./session-scratch";

const STATE = mkdtempSync(join(tmpdir(), "session-scratch-test-"));
const PREV_STATE = process.env.OPENSESSION_STATE_DIR;

// Re-pin per test: another file's afterAll can restore OPENSESSION_STATE_DIR
// mid-suite and redirect later writes (same guard as workspaces.test.ts).
beforeEach(() => {
  process.env.OPENSESSION_STATE_DIR = STATE;
});
afterAll(() => {
  if (PREV_STATE === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = PREV_STATE;
});

const NOW = Date.parse("2026-08-18T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function session(
  id: string,
  opts: Partial<ScratchSweepSession> = {},
): ScratchSweepSession {
  return {
    id,
    lastActivity: "2026-08-18T11:00:00Z",
    isRunning: false,
    ...opts,
  };
}

describe("ensureSessionScratch / removeSessionScratch", () => {
  it("creates the dir under the store root and removes it", async () => {
    const dir = ensureSessionScratch("os-test-ensure");
    expect(dir).toBe(join(sessionScratchRoot(), "os-test-ensure"));
    expect(existsSync(dir!)).toBe(true);
    await removeSessionScratch("os-test-ensure");
    expect(existsSync(dir!)).toBe(false);
  });

  it("refuses ids that sanitize to nothing or to a path step", () => {
    expect(ensureSessionScratch("")).toBeUndefined();
    expect(ensureSessionScratch("..")).toBeUndefined();
  });
});

describe("scratchDirsToSweep", () => {
  const dirs = (names: string[]) =>
    names.map((name) => ({ name, mtimeMs: NOW - 30 * DAY }));

  it("keeps a running session's dir whatever its age", () => {
    const doomed = scratchDirsToSweep(
      dirs(["os-a"]),
      [
        session("os-a", {
          isRunning: true,
          lastActivity: "2026-01-01T00:00:00Z",
        }),
      ],
      NOW,
    );
    expect(doomed).toEqual([]);
  });

  it("keeps recent sessions and sweeps ones idle past the horizon", () => {
    const doomed = scratchDirsToSweep(
      dirs(["os-recent", "os-idle"]),
      [
        session("os-recent"),
        session("os-idle", { lastActivity: "2026-08-01T00:00:00Z" }),
      ],
      NOW,
    );
    expect(doomed).toEqual(["os-idle"]);
  });

  it("ages automation-owned dirs out on the short horizon", () => {
    const doomed = scratchDirsToSweep(
      dirs(["os-auto-old", "os-auto-fresh"]),
      [
        session("os-auto-old", {
          automation: "triage",
          lastActivity: "2026-08-16T00:00:00Z",
        }),
        session("os-auto-fresh", {
          automation: "triage",
          lastActivity: "2026-08-18T00:00:00Z",
        }),
      ],
      NOW,
    );
    expect(doomed).toEqual(["os-auto-old"]);
  });

  it("a human co-owner keeps a dir on the long horizon", () => {
    const doomed = scratchDirsToSweep(
      dirs(["os-shared"]),
      [
        session("os-shared", {
          automation: "triage",
          lastActivity: "2026-08-16T00:00:00Z",
        }),
        session("os-shared", { lastActivity: "2026-08-16T00:00:00Z" }),
      ],
      NOW,
    );
    expect(doomed).toEqual([]);
  });

  it("fails closed on malformed activity", () => {
    const doomed = scratchDirsToSweep(
      dirs(["os-x"]),
      [session("os-x", { lastActivity: "not-a-date" })],
      NOW,
    );
    expect(doomed).toEqual([]);
  });

  it("sweeps ownerless dirs only once their own mtime is past the horizon", () => {
    const doomed = scratchDirsToSweep(
      [
        { name: "os-gone-old", mtimeMs: NOW - 8 * DAY },
        { name: "os-gone-fresh", mtimeMs: NOW - HOUR },
      ],
      [],
      NOW,
    );
    expect(doomed).toEqual(["os-gone-old"]);
  });
});

describe("sweepSessionScratch", () => {
  it("removes doomed dirs from disk and keeps live ones", async () => {
    const keep = ensureSessionScratch("os-live")!;
    const gone = ensureSessionScratch("os-dead")!;
    const old = (Date.now() - 10 * DAY) / 1000;
    utimesSync(gone, old, old);
    const removed = await sweepSessionScratch([
      session("os-live", { isRunning: true }),
    ]);
    expect(removed).toEqual(["os-dead"]);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(gone)).toBe(false);
  });
});
