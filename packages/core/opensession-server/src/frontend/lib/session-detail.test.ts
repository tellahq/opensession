/**
 * The summary/detail contract, from the client's side.
 *
 * `GET /api/sessions` is a summary: it drops the engine ids, the transcript
 * path and the model-switch history, which only the open conversation reads.
 * The open session fetches them from `GET /api/sessions/:id` and merges them
 * back — and the merge has to be a NARROW overlay, because the same projection
 * also omits falsy values, so a blanket spread would resurrect stale state.
 */

import { describe, expect, test } from "bun:test";
import { mergeSessionDetail, SESSION_DETAIL_ONLY } from "./session-detail";
import { sessionNeverRan } from "./landing-session";
import type { UnifiedSession } from "./types";

function listRow(over: Partial<UnifiedSession> = {}): UnifiedSession {
  const base = {
    id: "os-019fea32-b27e-7000-9131-0f5484659833",
    source: "opensession",
    branch: "feature/thing",
    worktreeDir: "/home/ubuntu/worktrees/thing",
    startedBy: "Ada",
    title: "Make the thing faster",
    lastActivity: "2026-08-09T10:05:00.000Z",
    createdAt: "2026-08-09T09:00:00.000Z",
    isRunning: false,
    ran: true,
  } satisfies UnifiedSession;
  return Object.assign(base, over);
}

describe("mergeSessionDetail", () => {
  test("fills in what the list row does not carry", () => {
    const merged = mergeSessionDetail(
      listRow(),
      listRow({
        claudeSessionId: "ses_1",
        codexThreadId: "thread_1",
        transcriptPath: "/transcripts/ses_1.jsonl",
        modelHistory: [{ model: "claude-opus-5", at: "2026-08-09" }],
      }),
    );
    expect(merged.claudeSessionId).toBe("ses_1");
    expect(merged.codexThreadId).toBe("thread_1");
    expect(merged.transcriptPath).toBe("/transcripts/ses_1.jsonl");
    expect(merged.modelHistory).toEqual([
      { model: "claude-opus-5", at: "2026-08-09" },
    ]);
  });

  test("the polled row wins for everything else, however stale the detail is", () => {
    // The detail response is a snapshot from whenever it was fetched. This
    // is the whole reason the overlay is a named set: the list projection
    // omits falsy values, so `isRunning: false` arrives as a MISSING key,
    // and a blanket spread would leave the session running forever.
    const merged = mergeSessionDetail(
      listRow({
        isRunning: undefined,
        title: "Renamed",
        lastActivity: "later",
      }),
      listRow({
        isRunning: true,
        title: "Make the thing faster",
        lastActivity: "2026-08-09T10:05:00.000Z",
        queuedCount: 3,
      }),
    );
    expect(merged.isRunning).toBeUndefined();
    expect(merged.queuedCount).toBeUndefined();
    expect(merged.title).toBe("Renamed");
    expect(merged.lastActivity).toBe("later");
  });

  test("a summary row from the archived index defers to the whole session", () => {
    // It carries less than the detail response across the board, not just
    // in the detail-only fields.
    const detail = listRow({ title: "Whole", prUrl: "https://x/pull/1" });
    expect(
      mergeSessionDetail(listRow({ slim: true, title: "Row" }), detail),
    ).toBe(detail);
  });

  test("renders the list row until the detail lands", () => {
    const row = listRow();
    expect(mergeSessionDetail(row, null)).toBe(row);
  });

  test("does not overlay `ran`, which the list is the source of", () => {
    // Both responses carry it (enrichSession derives it either side), so
    // overlaying it would be harmless — but listing it here would mean the
    // list's freshest answer could be overwritten by a snapshot.
    expect(new Set<keyof UnifiedSession>(SESSION_DETAIL_ONLY).has("ran")).toBe(
      false,
    );
  });
});

describe("sessionNeverRan", () => {
  test("reads `ran`, which is what a list row carries", () => {
    expect(sessionNeverRan(listRow({ ran: true }))).toBe(false);
    expect(
      sessionNeverRan(
        listRow({ ran: undefined, lastActivity: "2026-08-09T09:00:00.000Z" }),
      ),
    ).toBe(true);
  });

  test("an optimistic row for a just-created tab has not run", () => {
    // It is minted client-side with no `ran`, which is the right answer.
    const now = "2026-08-09T09:00:00.000Z";
    expect(
      sessionNeverRan(
        listRow({ ran: undefined, createdAt: now, lastActivity: now }),
      ),
    ).toBe(true);
  });

  test("a session that ran but is idle is still not a shell", () => {
    const now = "2026-08-09T09:00:00.000Z";
    expect(
      sessionNeverRan(
        listRow({ ran: true, createdAt: now, lastActivity: now }),
      ),
    ).toBe(false);
  });
});
