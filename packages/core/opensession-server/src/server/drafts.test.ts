import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import {
  __draftFileForTest,
  getDrafts,
  purgeDraftsForSessions,
  upsertDraft,
} from "./drafts";

// The store resolves its dir per call, so pointing the state root at a scratch
// dir keeps these off the real ~/.opensession-drafts.
const root = mkdtempSync(`${tmpdir()}/drafts-test-`);
const previousRoot = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

afterAll(() => {
  if (previousRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

const EARLY = "2026-08-13T10:00:00.000Z";
const LATE = "2026-08-13T10:05:00.000Z";

describe("composer drafts store", () => {
  beforeEach(() => {
    rmSync(`${root}/.opensession-drafts`, { recursive: true, force: true });
  });

  test("round-trips one session's draft", () => {
    upsertDraft("Kent", "os-1", "half a thought", EARLY);
    expect(getDrafts("Kent")).toEqual({
      "os-1": { text: "half a thought", updatedAt: EARLY },
    });
  });

  test("a write touches only its own session", () => {
    upsertDraft("Kent", "os-1", "first", EARLY);
    upsertDraft("Kent", "os-2", "second", EARLY);
    expect(Object.keys(getDrafts("Kent")).sort()).toEqual(["os-1", "os-2"]);
  });

  test("users never see each other's drafts", () => {
    upsertDraft("Kent", "os-1", "mine", EARLY);
    expect(getDrafts("Michiel")).toEqual({});
  });

  test("lossy filename characters cannot merge two users", () => {
    expect(__draftFileForTest("a/b")).not.toBe(__draftFileForTest("a_b"));
  });

  test("empty text deletes the draft", () => {
    upsertDraft("Kent", "os-1", "typed", EARLY);
    const result = upsertDraft("Kent", "os-1", "", LATE);
    expect(result).toEqual({ draft: null, applied: true });
    expect(getDrafts("Kent")).toEqual({});
  });

  test("whitespace counts as empty", () => {
    upsertDraft("Kent", "os-1", "typed", EARLY);
    upsertDraft("Kent", "os-1", "   \n ", LATE);
    expect(getDrafts("Kent")).toEqual({});
  });

  // The reason the store carries a timestamp at all: a phone that wakes up
  // with an hour-old draft must not undo what was typed in the browser since.
  test("an older write is refused and reports the winner", () => {
    upsertDraft("Kent", "os-1", "rewritten in the browser", LATE);
    const result = upsertDraft("Kent", "os-1", "stale phone copy", EARLY);
    expect(result.applied).toBe(false);
    expect(result.draft?.text).toBe("rewritten in the browser");
    expect(getDrafts("Kent")["os-1"]?.text).toBe("rewritten in the browser");
  });

  test("a newer write wins", () => {
    upsertDraft("Kent", "os-1", "older", EARLY);
    expect(upsertDraft("Kent", "os-1", "newer", LATE).applied).toBe(true);
    expect(getDrafts("Kent")["os-1"]?.text).toBe("newer");
  });

  test("an older delete cannot erase newer writing", () => {
    upsertDraft("Kent", "os-1", "typed", LATE);
    const result = upsertDraft("Kent", "os-1", "", EARLY);
    expect(result.applied).toBe(false);
    expect(result.draft?.text).toBe("typed");
    expect(getDrafts("Kent")["os-1"]?.text).toBe("typed");
  });

  test("a late text write cannot resurrect a sent draft", () => {
    upsertDraft("Kent", "os-1", "typed", EARLY);
    upsertDraft("Kent", "os-1", "", LATE);
    const lateArrival = upsertDraft("Kent", "os-1", "typed", EARLY);
    expect(lateArrival).toEqual({ draft: null, applied: false });
    expect(getDrafts("Kent")).toEqual({});
  });

  test("the map is capped, dropping the oldest drafts first", () => {
    for (let i = 0; i < 205; i++) {
      const at = new Date(Date.parse(EARLY) + i * 1000).toISOString();
      upsertDraft("Kent", `os-${i}`, `draft ${i}`, at);
    }
    const drafts = getDrafts("Kent");
    expect(Object.keys(drafts).length).toBe(200);
    expect(drafts["os-0"]).toBeUndefined();
    expect(drafts["os-204"]?.text).toBe("draft 204");
  });

  test("deleting a session drops its draft for everyone", () => {
    upsertDraft("Kent", "os-1", "mine", EARLY);
    upsertDraft("Michiel", "os-1", "theirs", EARLY);
    upsertDraft("Kent", "os-2", "kept", EARLY);
    purgeDraftsForSessions(["os-1"]);
    expect(getDrafts("Kent")).toEqual({
      "os-2": { text: "kept", updatedAt: EARLY },
    });
    expect(getDrafts("Michiel")).toEqual({});
  });

  test("a missing store reads as no drafts", () => {
    expect(getDrafts("Nobody")).toEqual({});
  });
});
