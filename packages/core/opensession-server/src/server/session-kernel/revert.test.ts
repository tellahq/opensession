import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionKernelStore } from "./store";
import { TranscriptStore } from "../transcript-store";
import type { RevertIntent } from "./revert-protocol";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "revert-actor-"));
  const path = join(root, "actor.sqlite");
  const kernel = new SessionKernelStore(path);
  const transcript = new TranscriptStore(path);
  const sessionId = "os-revert-test";
  kernel.putSessionMetadata({
    op: "put",
    sessionId,
    expectedRev: null,
    rev: 1,
    requestId: "seed",
    doc: JSON.stringify({ id: sessionId, piSessionId: "engine-old" }),
    archived: false,
    lastActivityMs: 0,
  });
  transcript.applyActorRequest({
    op: "append",
    sessionId,
    requestId: "initial-conversation",
    entries: [
      {
        id: "turn-1",
        type: "user",
        content: "Prompt",
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        id: "answer-1",
        type: "assistant",
        content: "Result",
        timestamp: "2026-01-01T00:00:01Z",
      },
    ],
  });
  cleanup.push(() => {
    transcript.close();
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });
  const intent: Omit<RevertIntent, "phase" | "createdAt"> = {
    intentId: "intent-1",
    targetTurnId: "turn-1",
    revertedEntryRange: { fromSeq: 1, toSeq: 2 },
    checkpointRef: `refs/opensession/turns/${sessionId}/before/turn-1`,
    preRevertRef: `refs/opensession/turns/${sessionId}/before/revert-1`,
    expectedHead: "a".repeat(40),
    expectedIndexTree: "b".repeat(40),
    fromEngineSessionId: "engine-old",
    toEngineSessionId: "engine-new",
    operation: "revert",
  };
  return {
    path,
    kernel,
    transcript,
    sessionId,
    intent,
    apply: (op: "mark_files_restored" | "complete" | "undo_last") =>
      transcript.applyRevertActorRequest({
        op,
        sessionId,
        intentId: "intent-1",
      }),
  };
}
test("begin, complete and replay atomically switch pointer and append one marker", () => {
  const f = fixture();
  expect(
    f.transcript.applyRevertActorRequest({
      op: "begin",
      sessionId: f.sessionId,
      intent: f.intent,
    }).status,
  ).toBe("committed");
  expect(
    f.transcript.applyRevertActorRequest({
      op: "begin",
      sessionId: f.sessionId,
      intent: f.intent,
    }).status,
  ).toBe("duplicate");
  expect(() => f.apply("complete")).toThrow("files have not been restored");
  expect(f.apply("mark_files_restored").status).toBe("committed");
  expect(f.apply("complete").status).toBe("committed");
  expect(f.apply("complete").status).toBe("duplicate");
  expect(
    JSON.parse(f.kernel.sessionMetadata(f.sessionId)!.doc).piSessionId,
  ).toBe("engine-new");
  expect(f.transcript.readTail(f.sessionId).entries).toHaveLength(3);
  expect(
    f.transcript.applyRevertActorRequest({ op: "get", sessionId: f.sessionId })
      .intent,
  ).toBeNull();
});
test("active run and queued work refuse begin", () => {
  const f = fixture();
  f.kernel.setRunState({
    sessionId: f.sessionId,
    state: "running",
    event: "prompt",
  });
  expect(
    f.transcript.applyRevertActorRequest({
      op: "begin",
      sessionId: f.sessionId,
      intent: f.intent,
    }),
  ).toMatchObject({ status: "refused", reason: "run_active" });
  f.kernel.setRunState({
    sessionId: f.sessionId,
    state: "idle",
    event: "turn_end",
  });
  f.kernel.enqueueDelivery(f.sessionId, { id: "queued" });
  expect(
    f.transcript.applyRevertActorRequest({
      op: "begin",
      sessionId: f.sessionId,
      intent: f.intent,
    }),
  ).toMatchObject({ status: "refused", reason: "queued_work" });
});
test("durable intent blocks starts and holds queue dispatch without dropping prompts", () => {
  const f = fixture();
  f.transcript.applyRevertActorRequest({
    op: "begin",
    sessionId: f.sessionId,
    intent: f.intent,
  });
  expect(
    f.kernel.applyRunEvent({ sessionId: f.sessionId, event: "prompt" })
      .accepted,
  ).toBe(false);
  expect(() =>
    f.kernel.setRunState({
      sessionId: f.sessionId,
      state: "starting",
      event: "prompt",
    }),
  ).toThrow("needs attention");
  f.kernel.enqueueDelivery(f.sessionId, { id: "queued" });
  expect(
    f.kernel.claimNextDeliveryDispatch({
      sessionId: f.sessionId,
      promptEntryId: "next",
    }),
  ).toMatchObject({ kind: "hold", heldCount: 1 });
  expect(f.kernel.deliverySnapshot(f.sessionId).queued).toHaveLength(1);
  expect(
    f.transcript.applyRevertActorRequest({
      op: "rollback",
      sessionId: f.sessionId,
      intentId: "intent-1",
      reason: "test",
    }).status,
  ).toBe("committed");
  expect(f.transcript.readTail(f.sessionId).entries).toHaveLength(2);
});
test("completion failure rolls back BOTH marker and engine pointer", () => {
  const f = fixture();
  f.transcript.applyRevertActorRequest({
    op: "begin",
    sessionId: f.sessionId,
    intent: f.intent,
  });
  f.apply("mark_files_restored");
  const db = new Database(f.path);
  db.exec(
    "CREATE TRIGGER fail_revert_metadata BEFORE UPDATE ON session_kernel_metadata BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
  );
  expect(() => f.apply("complete")).toThrow("injected failure");
  expect(f.transcript.readTail(f.sessionId).entries).toHaveLength(2);
  expect(
    JSON.parse(f.kernel.sessionMetadata(f.sessionId)!.doc).piSessionId,
  ).toBe("engine-old");
  expect(
    f.transcript.applyRevertActorRequest({ op: "get", sessionId: f.sessionId })
      .intent?.phase,
  ).toBe("files_restored");
  db.close();
});
test("undo uses another durable intent and append-only marker", () => {
  const f = fixture();
  f.transcript.applyRevertActorRequest({
    op: "begin",
    sessionId: f.sessionId,
    intent: f.intent,
  });
  f.apply("mark_files_restored");
  f.apply("complete");
  const undo = {
    ...f.intent,
    intentId: "undo-1",
    operation: "undo" as const,
    fromEngineSessionId: "engine-new",
    toEngineSessionId: "engine-old",
  };
  expect(
    f.transcript.applyRevertActorRequest({
      op: "begin",
      sessionId: f.sessionId,
      intent: undo,
    }).status,
  ).toBe("committed");
  f.transcript.applyRevertActorRequest({
    op: "mark_files_restored",
    sessionId: f.sessionId,
    intentId: "undo-1",
  });
  expect(
    f.transcript.applyRevertActorRequest({
      op: "undo_last",
      sessionId: f.sessionId,
      intentId: "undo-1",
    }).status,
  ).toBe("committed");
  expect(
    JSON.parse(f.kernel.sessionMetadata(f.sessionId)!.doc).piSessionId,
  ).toBe("engine-old");
  expect(
    f.transcript
      .readTail(f.sessionId)
      .entries.filter((e) => e.turnRevert)
      .map((e) => e.turnRevert?.operation),
  ).toEqual(["revert", "undo"]);
});

test("only the revert reducer can clear an intent or change its pointer", () => {
  const f = fixture();
  f.transcript.applyRevertActorRequest({
    op: "begin",
    sessionId: f.sessionId,
    intent: f.intent,
  });
  const stored = f.kernel.sessionMetadata(f.sessionId)!;
  const doc = JSON.parse(stored.doc);
  delete doc.turnRevertIntent;
  expect(() =>
    f.kernel.putSessionMetadata({
      op: "put",
      sessionId: f.sessionId,
      requestId: "ordinary-put",
      expectedRev: stored.rev,
      rev: stored.rev + 1,
      doc: JSON.stringify(doc),
      archived: false,
      lastActivityMs: 0,
    }),
  ).toThrow("Only the revert actor");
  expect(f.kernel.hasRevertIntent(f.sessionId)).toBe(true);
  expect(() =>
    f.transcript.applyRevertActorRequest({
      op: "begin",
      sessionId: f.sessionId,
      intent: { ...f.intent, targetTurnId: "other" },
    }),
  ).toThrow("different inputs");
  f.apply("mark_files_restored");
  expect(f.apply("mark_files_restored").status).toBe("duplicate");
});

test("actor read projections annotate reverted history, while preserving all rows", () => {
  const f = fixture();
  f.transcript.applyRevertActorRequest({
    op: "begin",
    sessionId: f.sessionId,
    intent: f.intent,
  });
  f.apply("mark_files_restored");
  f.apply("complete");
  const page = f.transcript.applyActorRequest({
    op: "tail",
    sessionId: f.sessionId,
  }) as import("../transcript-store").TranscriptPage;
  expect(page.entries).toHaveLength(3);
  expect(page.entries.slice(0, 2).every((entry) => entry.reverted)).toBe(true);
  expect(page.entries[2].turnRevert?.activeRanges).toEqual([
    { fromSeq: 1, toSeq: 2 },
  ]);
});
