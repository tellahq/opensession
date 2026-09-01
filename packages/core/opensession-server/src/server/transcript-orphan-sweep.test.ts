/**
 * The sweep's whole value is what it REFUSES to delete, so that is most of
 * what is asserted here: an orphan holding one thing a person said survives,
 * a young orphan survives, and an enumeration that came back implausible
 * stops the pass rather than emptying the store.
 *
 * Driven against a real TranscriptStore on a temp DB — the deletion path is
 * the store's own transaction, and a mock would prove nothing about it.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { sweepOrphanTranscripts } from "./transcript-orphan-sweep";
import { TranscriptStore } from "./transcript-store";
import type { TranscriptEntry } from "./types";

const dir = mkdtempSync(`${tmpdir()}/orphan-sweep-test-`);
let store: TranscriptStore;
let dbIndex = 0;

const HOUR_MS = 60 * 60_000;
const LONG_AGO = new Date(Date.now() - 48 * HOUR_MS).toISOString();

/** Enough plausible sessions to clear the "enumeration looks broken" guard. */
function knownIds(...ids: string[]): () => Set<string> {
  const known = new Set(ids);
  for (let i = 0; i < 80; i++) known.add(`os-known-filler-${i}`);
  return () => known;
}

function standingRecord(id: string, at = LONG_AGO): TranscriptEntry {
  return {
    id,
    type: "system",
    content: '{"mcpScope":"all"}',
    timestamp: at,
    noticeKind: "standing-context",
    contextInjection: { source: "tools", hash: "abc", bytes: 18 },
  };
}

function injectionRecord(id: string, at = LONG_AGO): TranscriptEntry {
  return {
    id,
    type: "system",
    content: "## Engine handoff\nprior turns…",
    timestamp: at,
    noticeKind: "context-injection",
    contextInjection: { source: "handoff" },
  };
}

function said(id: string, at = LONG_AGO): TranscriptEntry {
  return {
    id,
    type: "user",
    content: "something a person said",
    timestamp: at,
  };
}

beforeEach(() => {
  store = new TranscriptStore(`${dir}/transcripts-${++dbIndex}.db`);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("orphan transcript sweep", () => {
  test("removes a session whose whole transcript is the harness's bookkeeping", async () => {
    store.appendTranscriptEvents("probe-0", [standingRecord("std-1")]);
    store.appendTranscriptEvents("starved-0-abc", [
      standingRecord("std-2"),
      injectionRecord("ctx-1"),
    ]);

    const summary = await sweepOrphanTranscripts({
      store,
      knownSessionIds: knownIds(),
    });

    expect(summary.removed).toBe(2);
    expect(summary.removedEvents).toBe(3);
    expect(summary.keptOrphans).toBe(0);
    expect(summary.refused).toBeUndefined();
    expect(store.stats()).toMatchObject({ sessions: 0, events: 0 });
  });

  test("keeps an orphan that holds conversation, however orphaned it is", async () => {
    // A Slack thread whose session file was pruned: nothing points at it,
    // but its rows are the last copy of what was said.
    store.appendTranscriptEvents("slack-C0-1783028730.360119", [
      said("u-1"),
      standingRecord("std-1"),
    ]);

    const summary = await sweepOrphanTranscripts({
      store,
      knownSessionIds: knownIds(),
    });

    expect(summary.orphans).toBe(1);
    expect(summary.removed).toBe(0);
    expect(summary.keptOrphans).toBe(1);
    expect(summary.keptEvents).toBe(2);
    expect(store.countEvents("slack-C0-1783028730.360119")).toBe(2);
  });

  test("never touches a session that has something behind it", async () => {
    // Same shape as the fixture rows — only the ownership differs.
    store.appendTranscriptEvents("os-real", [standingRecord("std-1")]);

    const summary = await sweepOrphanTranscripts({
      store,
      knownSessionIds: knownIds("os-real"),
    });

    expect(summary.orphans).toBe(0);
    expect(summary.removed).toBe(0);
    expect(store.countEvents("os-real")).toBe(1);
  });

  test("leaves a young orphan alone — a session being created has no file yet", async () => {
    store.appendTranscriptEvents("os-just-born", [
      standingRecord("std-1", new Date().toISOString()),
    ]);

    const summary = await sweepOrphanTranscripts({
      store,
      knownSessionIds: knownIds(),
    });

    expect(summary.orphans).toBe(1);
    expect(summary.removed).toBe(0);
    expect(summary.keptOrphans).toBe(1);
    expect(store.countEvents("os-just-born")).toBe(1);
  });

  test("a dry run counts exactly what a real pass would remove, and removes none of it", async () => {
    store.appendTranscriptEvents("probe-0", [standingRecord("std-1")]);
    store.appendTranscriptEvents("slack-keepme", [said("u-1")]);

    const dry = await sweepOrphanTranscripts({
      store,
      knownSessionIds: knownIds(),
      dryRun: true,
    });
    expect(dry.removed).toBe(1);
    expect(dry.keptOrphans).toBe(1);
    expect(store.countEvents("probe-0")).toBe(1);

    const real = await sweepOrphanTranscripts({
      store,
      knownSessionIds: knownIds(),
    });
    expect(real.removed).toBe(dry.removed);
    expect(real.removedEvents).toBe(dry.removedEvents);
    expect(store.countEvents("probe-0")).toBe(0);
  });

  test("a second pass finds nothing to do", async () => {
    store.appendTranscriptEvents("probe-0", [standingRecord("std-1")]);
    await sweepOrphanTranscripts({ store, knownSessionIds: knownIds() });

    const again = await sweepOrphanTranscripts({
      store,
      knownSessionIds: knownIds(),
    });
    expect(again.orphans).toBe(0);
    expect(again.removed).toBe(0);
    expect(again.refused).toBeUndefined();
  });

  test("refuses the whole pass when the session enumeration looks broken", async () => {
    // A scanner that threw, or a state dir not mounted yet: every stored
    // session would read as an orphan, so nothing may be deleted.
    store.appendTranscriptEvents("probe-0", [standingRecord("std-1")]);

    const summary = await sweepOrphanTranscripts({
      store,
      knownSessionIds: () => new Set(["os-only-one"]),
    });

    expect(summary.refused).toContain("enumeration looks broken");
    expect(summary.removed).toBe(0);
    expect(store.countEvents("probe-0")).toBe(1);
  });

  test("refuses when enumerating sessions throws at all", async () => {
    store.appendTranscriptEvents("probe-0", [standingRecord("std-1")]);

    const summary = await sweepOrphanTranscripts({
      store,
      knownSessionIds: () => {
        throw new Error("sessions dir unreadable");
      },
    });

    expect(summary.refused).toContain("sessions dir unreadable");
    expect(summary.removed).toBe(0);
    expect(store.countEvents("probe-0")).toBe(1);
  });

  test("a long bookkeeping-only transcript is left alone rather than read", async () => {
    // Past the read bound the sweep stops proving and starts keeping: no
    // real bookkeeping-only session is this long, so one that is has some
    // other explanation.
    const many = Array.from({ length: 60 }, (_, i) =>
      standingRecord(`std-${i}`),
    );
    store.appendTranscriptEvents("os-suspiciously-long", many);

    const summary = await sweepOrphanTranscripts({
      store,
      knownSessionIds: knownIds(),
    });

    expect(summary.removed).toBe(0);
    expect(summary.keptOrphans).toBe(1);
    expect(store.countEvents("os-suspiciously-long")).toBe(60);
  });
});
