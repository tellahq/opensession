import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TranscriptAppendAgentReceiptInvariantError,
  TranscriptAppendConflictError,
  TranscriptAppendReceiptCorruptError,
  TranscriptAppendReceiptMismatchError,
  TranscriptStore,
  TRANSCRIPT_DESTINATION_MAX_BYTES,
  TRANSCRIPT_DESTINATION_MAX_ENTRIES,
  setAppendHook,
  type AgentDestinationTranscriptAppendRequest,
  type DestinationTranscriptAppendRequest,
} from "./transcript-store";
import { subscribeTranscript } from "./transcript-bus";
import { SessionKernelStore } from "./session-kernel/store";
import {
  __setSessionKernelStoreForTest,
  sessionGatewayCommand,
} from "./session-kernel";
import { executeDestinationIdempotentSessionProjection } from "./session-projection-executor";

function request(
  over: Partial<DestinationTranscriptAppendRequest> &
    Pick<AgentDestinationTranscriptAppendRequest, "transcriptAnchor">,
): AgentDestinationTranscriptAppendRequest;
function request(
  over?: Partial<DestinationTranscriptAppendRequest>,
): DestinationTranscriptAppendRequest;
function request(
  over: Partial<AgentDestinationTranscriptAppendRequest> = {},
): DestinationTranscriptAppendRequest {
  return {
    sessionId: "os-destination",
    runId: "run-1",
    turnId: "turn-1",
    generation: 1,
    appendId: "append-1",
    entries: [
      {
        id: "entry-1",
        type: "assistant",
        content: "hello",
        timestamp: "2026-08-22T00:00:00.000Z",
      },
    ],
    ...over,
  };
}

function emptyAnchor(char = "a") {
  return {
    throughChangeSeq: 0,
    entryIds: [] as string[],
    digest: `sha256:${char.repeat(64)}` as `sha256:${string}`,
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "transcript-destination-"));
  const path = join(dir, "transcripts.db");
  return { dir, path, store: new TranscriptStore(path) };
}

function receiptCount(path: string, sessionId = "os-destination") {
  const db = new Database(path, { readonly: true });
  try {
    return (
      db
        .query(
          "SELECT COUNT(*) AS n FROM transcript_append_receipts WHERE session_id = ?",
        )
        .get(sessionId) as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

describe("destination-idempotent transcript append receipts", () => {
  test("persists an exact first result and replays it across reopen without writes or notifications", async () => {
    const { dir, path, store } = fixture();
    let hooks = 0;
    let bus = 0;
    setAppendHook(() => {
      hooks++;
    });
    const unsubscribe = subscribeTranscript("os-destination", () => bus++);
    try {
      const first = store.commitTranscriptDestinationAppend(request());
      expect(first).toEqual({
        firstSeq: 1,
        lastSeq: 1,
        inserted: 1,
        updated: 0,
        changes: [{ entryId: "entry-1", seq: 1, changeSeq: 1 }],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect([hooks, bus]).toEqual([1, 1]);
      expect(receiptCount(path)).toBe(1);
      store.close();

      const reopened = new TranscriptStore(path);
      const replay = reopened.commitTranscriptDestinationAppend(request());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
      expect(reopened.getLastChangeSeq("os-destination")).toBe(1);
      expect(reopened.countEvents("os-destination")).toBe(1);
      expect([hooks, bus]).toEqual([1, 1]);
      reopened.close();
    } finally {
      unsubscribe();
      setAppendHook(null);
      try {
        store.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("same append id conflicts on every fence and payload category without mutation", () => {
    const { dir, path, store } = fixture();
    try {
      store.commitTranscriptDestinationAppend(request());
      const variants = [
        request({ sessionId: "os-other" }),
        request({ runId: "run-2" }),
        request({ turnId: "turn-2" }),
        request({ generation: 2 }),
        request({
          entries: [{ ...request().entries[0]!, content: "changed" }],
        }),
        request({ entries: [{ ...request().entries[0]!, id: "entry-2" }] }),
      ];
      for (const variant of variants) {
        if (variant.sessionId !== "os-destination") continue; // identity is scoped by session
        expect(() => store.commitTranscriptDestinationAppend(variant)).toThrow(
          TranscriptAppendConflictError,
        );
      }
      expect(store.getLastChangeSeq("os-destination")).toBe(1);
      expect(store.readTail("os-destination").entries[0]?.content).toBe(
        "hello",
      );
      expect(receiptCount(path)).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent and serialized duplicates retain original seq and exact change receipts", async () => {
    const { dir, store } = fixture();
    try {
      const input = request();
      const [first, concurrentReplay] = await Promise.all([
        Promise.resolve().then(() =>
          store.commitTranscriptDestinationAppend(input),
        ),
        Promise.resolve().then(() =>
          store.commitTranscriptDestinationAppend(input),
        ),
      ]);
      expect(concurrentReplay).toEqual(first);
      expect(store.commitTranscriptDestinationAppend(input)).toEqual(first);
      const rewrite = request({
        appendId: "append-2",
        entries: [{ ...input.entries[0]!, content: "rewritten" }],
      });
      const result = store.commitTranscriptDestinationAppend(rewrite);
      expect(result).toEqual({
        firstSeq: 1,
        lastSeq: 1,
        inserted: 0,
        updated: 1,
        changes: [{ entryId: "entry-1", seq: 1, changeSeq: 2 }],
      });
      expect(store.commitTranscriptDestinationAppend(rewrite)).toEqual(result);
      expect(store.getLastSeq(input.sessionId)).toBe(1);
      expect(store.getLastChangeSeq(input.sessionId)).toBe(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("authoritative replacement and import retain receipts, while deletion removes them atomically", () => {
    const { dir, path, store } = fixture();
    try {
      const input = request();
      const original = store.commitTranscriptDestinationAppend(input);
      store.replaceTranscriptEvents(input.sessionId, [
        { ...input.entries[0]!, content: "replacement" },
      ]);
      store.importLegacyTranscript(
        input.sessionId,
        [{ ...input.entries[0]!, content: "import" }],
        "merged",
        10,
      );
      expect(receiptCount(path)).toBe(1);
      expect(store.commitTranscriptDestinationAppend(input)).toEqual(original);
      expect(store.readTail(input.sessionId).entries[0]?.content).toBe(
        "import",
      );
      store.deleteSessionTranscript(input.sessionId);
      expect(receiptCount(path)).toBe(0);
      expect(store.countEvents(input.sessionId)).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects empty, unknown, non-JSON, malformed, and bounded inputs before schema mutation", () => {
    const { dir, path, store } = fixture();
    try {
      const invalid: unknown[] = [
        request({ entries: [] }),
        { ...request(), unknown: true },
        request({ generation: Number.NaN }),
        { ...request(), appendId: undefined },
        request({
          entries: [{ ...request().entries[0]!, surprise: true } as never],
        }),
        request({
          entries: [{ ...request().entries[0]!, timestamp: "invalid" }],
        }),
        request({
          entries: [{ ...request().entries[0]!, content: undefined } as never],
        }),
        request({
          entries: Array.from(
            { length: TRANSCRIPT_DESTINATION_MAX_ENTRIES + 1 },
            (_, i) => ({ ...request().entries[0]!, id: `e-${i}` }),
          ),
        }),
        request({
          entries: [
            {
              ...request().entries[0]!,
              content: "x".repeat(TRANSCRIPT_DESTINATION_MAX_BYTES + 1),
            },
          ],
        }),
        request({
          transcriptAnchor: {
            throughChangeSeq: 1,
            entryIds: Array.from(
              { length: 300 },
              (_, index) => `entry-${index}-${"x".repeat(230)}`,
            ),
            digest: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
          },
        }),
      ];
      const polluted = Object.create({ inherited: true });
      Object.assign(polluted, request());
      invalid.push(polluted);
      let nested: unknown = "leaf";
      for (let depth = 0; depth < 70; depth++) nested = [nested];
      invalid.push(
        request({ entries: [{ ...request().entries[0]!, toolInput: nested }] }),
      );
      for (const value of invalid)
        expect(() =>
          store.commitTranscriptDestinationAppend(
            value as DestinationTranscriptAppendRequest,
          ),
        ).toThrow();
      expect(receiptCount(path)).toBe(0);
      expect(store.countEvents("os-destination")).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recovers the crash window after destination commit with actor command incomplete", () => {
    const { dir, path, store } = fixture();
    const kernelPath = join(dir, "kernel.sqlite");
    let kernel = new SessionKernelStore(kernelPath);
    const command = {
      sessionId: "os-destination",
      requestId: "transcript-destination:append-1",
      operation: "transcript_destination_append" as const,
      identity: {
        digest: "bound-by-destination",
        fence: { runId: "run-1", turnId: "turn-1", generation: 1 },
      },
    };
    try {
      expect(kernel.requestGatewayCommand(command)).toEqual({
        status: "execute",
      });
      const committed = store.commitTranscriptDestinationAppend(request());
      kernel.close(); // crash before completeGatewayCommand
      kernel = new SessionKernelStore(kernelPath);
      expect(kernel.requestGatewayCommand(command)).toEqual({
        status: "execute",
      });
      const replay = store.commitTranscriptDestinationAppend(request());
      expect(replay).toEqual(committed);
      expect(store.getLastChangeSeq(command.sessionId)).toBe(1);
      expect(
        kernel.completeGatewayCommand({ ...command, result: replay }),
      ).toEqual(committed);
    } finally {
      kernel.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("destination continuation does not hold the session actor mailbox", async () => {
    const { dir, store } = fixture();
    const kernel = new SessionKernelStore(
      join(dir, "responsive-kernel.sqlite"),
    );
    const previous = __setSessionKernelStoreForTest(kernel);
    try {
      const result = await executeDestinationIdempotentSessionProjection(
        "os-responsive",
        "transcript-destination:responsive",
        "transcript_destination_append",
        { digest: "one" },
        async () => {
          const admission = await sessionGatewayCommand({
            op: "request",
            sessionId: "os-responsive",
            requestId: "transcript_append:responsive-sibling",
            operation: "transcript_append",
          });
          expect(admission).toEqual({ status: "execute" });
          await sessionGatewayCommand({
            op: "complete",
            sessionId: "os-responsive",
            requestId: "transcript_append:responsive-sibling",
            operation: "transcript_append",
            result: "sibling-complete",
          });
          return "destination-complete";
        },
      );
      expect(result).toBe("destination-complete");
    } finally {
      __setSessionKernelStoreForTest(previous);
      kernel.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns and revalidates an exact fenced Agent receipt without query-side writes", async () => {
    const { dir, path, store } = fixture();
    const transcriptAnchor = emptyAnchor();
    let hooks = 0;
    let bus = 0;
    setAppendHook(() => {
      hooks++;
    });
    const unsubscribe = subscribeTranscript("os-destination", () => bus++);
    const input = request({
      transcriptAnchor,
      entries: [
        request().entries[0]!,
        {
          id: "entry-2",
          type: "tool_use",
          content: "call",
          timestamp: "2026-08-22T00:00:01.000Z",
          toolName: "example",
          toolUseId: "tool-use-1",
        },
      ],
    });
    try {
      const receipt = store.commitTranscriptDestinationAppendReceipt(input);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(hooks).toBe(1);
      expect(bus).toBe(1);
      expect(receipt).toMatchObject({
        version: 1,
        sessionId: input.sessionId,
        runId: input.runId,
        turnId: input.turnId,
        generation: input.generation,
        appendId: input.appendId,
        transcriptAnchor,
        entryIds: ["entry-1", "entry-2"],
        firstSeq: 1,
        lastSeq: 2,
        throughChangeSeq: 2,
        inserted: 2,
        updated: 0,
      });
      expect(receipt.requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      const query = {
        sessionId: input.sessionId,
        runId: input.runId,
        turnId: input.turnId,
        generation: input.generation,
        appendId: input.appendId,
        requestDigest: receipt.requestDigest,
        transcriptAnchor,
      };
      const before = {
        events: store.countEvents(input.sessionId),
        seq: store.getLastSeq(input.sessionId),
        changeSeq: store.getLastChangeSeq(input.sessionId),
        receipts: receiptCount(path),
      };
      expect(store.queryTranscriptDestinationReceipt(query)).toEqual(receipt);
      const reference = {
        appendId: receipt.appendId,
        entryIds: receipt.entryIds,
        firstSeq: receipt.firstSeq,
        lastSeq: receipt.lastSeq,
        throughChangeSeq: receipt.throughChangeSeq,
        requestDigest: receipt.requestDigest,
      };
      expect(
        store.validateAgentTranscriptReceiptRef({
          sessionId: input.sessionId,
          runId: input.runId,
          turnId: input.turnId,
          generation: input.generation,
          receipt: reference,
          transcriptAnchor,
        }),
      ).toEqual(reference);
      expect(() =>
        store.validateAgentTranscriptReceiptRef({
          sessionId: input.sessionId,
          runId: input.runId,
          turnId: input.turnId,
          generation: input.generation,
          receipt: {
            ...reference,
            entryIds: [...reference.entryIds].reverse(),
          },
          transcriptAnchor,
        }),
      ).toThrow(TranscriptAppendReceiptMismatchError);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect({
        events: store.countEvents(input.sessionId),
        seq: store.getLastSeq(input.sessionId),
        changeSeq: store.getLastChangeSeq(input.sessionId),
        receipts: receiptCount(path),
      }).toEqual(before);
      expect(hooks).toBe(1);
      expect(bus).toBe(1);
      store.close();
      const reopened = new TranscriptStore(path);
      expect(reopened.commitTranscriptDestinationAppendReceipt(input)).toEqual(
        receipt,
      );
      expect(reopened.queryTranscriptDestinationReceipt(query)).toEqual(
        receipt,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(hooks).toBe(1);
      expect(bus).toBe(1);
      reopened.deleteSessionTranscript(input.sessionId);
      expect(reopened.queryTranscriptDestinationReceipt(query)).toBeNull();
      reopened.close();
    } finally {
      setAppendHook(null);
      unsubscribe();
      try {
        store.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("distinguishes missing receipts from exact identity mismatch", () => {
    const { dir, store } = fixture();
    const transcriptAnchor = emptyAnchor("b");
    try {
      const receipt = store.commitTranscriptDestinationAppendReceipt(
        request({ transcriptAnchor }),
      );
      const exact = {
        sessionId: receipt.sessionId,
        runId: receipt.runId,
        turnId: receipt.turnId,
        generation: receipt.generation,
        appendId: receipt.appendId,
        requestDigest: receipt.requestDigest,
        transcriptAnchor,
      };
      expect(
        store.queryTranscriptDestinationReceipt({
          ...exact,
          appendId: "missing-append",
        }),
      ).toBeNull();
      for (const mismatch of [
        { ...exact, runId: "other-run" },
        { ...exact, turnId: "other-turn" },
        { ...exact, generation: 2 },
        {
          ...exact,
          requestDigest: `sha256:${"c".repeat(64)}` as `sha256:${string}`,
        },
        {
          ...exact,
          transcriptAnchor: {
            ...transcriptAnchor,
            digest: `sha256:${"d".repeat(64)}` as `sha256:${string}`,
          },
        },
      ])
        expect(() => store.queryTranscriptDestinationReceipt(mismatch)).toThrow(
          TranscriptAppendReceiptMismatchError,
        );
      const reference = {
        appendId: receipt.appendId,
        entryIds: receipt.entryIds,
        firstSeq: receipt.firstSeq,
        lastSeq: receipt.lastSeq,
        throughChangeSeq: receipt.throughChangeSeq,
        requestDigest: receipt.requestDigest,
      };
      expect(() =>
        store.validateAgentTranscriptReceiptRef({
          sessionId: receipt.sessionId,
          runId: receipt.runId,
          turnId: receipt.turnId,
          generation: receipt.generation,
          transcriptAnchor,
          receipt: {
            ...reference,
            entryIds: ["different-entry"],
          },
        }),
      ).toThrow(TranscriptAppendReceiptMismatchError);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects unsafe and malformed receipt lookup inputs", () => {
    const { dir, store } = fixture();
    try {
      const receipt = store.commitTranscriptDestinationAppendReceipt(
        request({ transcriptAnchor: emptyAnchor("e") }),
      );
      const query = {
        sessionId: receipt.sessionId,
        runId: receipt.runId,
        turnId: receipt.turnId,
        generation: receipt.generation,
        appendId: receipt.appendId,
        requestDigest: receipt.requestDigest,
      };
      const accessor = { ...query };
      Object.defineProperty(accessor, "generation", {
        enumerable: true,
        get: () => 1,
      });
      expect(() => store.queryTranscriptDestinationReceipt(accessor)).toThrow(
        TypeError,
      );
      expect(() =>
        store.queryTranscriptDestinationReceipt(new Proxy(query, {})),
      ).toThrow(TypeError);
      expect(() =>
        store.queryTranscriptDestinationReceipt({
          ...query,
          unknown: true,
        } as never),
      ).toThrow(TypeError);
      expect(() =>
        store.validateAgentTranscriptReceiptRef({
          sessionId: receipt.sessionId,
          runId: receipt.runId,
          turnId: receipt.turnId,
          generation: receipt.generation,
          transcriptAnchor: receipt.transcriptAnchor!,
          receipt: {
            appendId: receipt.appendId,
            entryIds: receipt.entryIds,
            firstSeq: 1,
            lastSeq: 99,
            throughChangeSeq: receipt.throughChangeSeq,
            requestDigest: receipt.requestDigest,
          },
        }),
      ).toThrow(TypeError);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves generic duplicate-ID batch replay", () => {
    const { dir, path, store } = fixture();
    const input = request({
      entries: [
        request().entries[0]!,
        { ...request().entries[0]!, content: "same-batch update" },
      ],
    });
    try {
      const first = store.commitTranscriptDestinationAppend(input);
      expect(first).toEqual({
        changes: [
          { changeSeq: 1, entryId: "entry-1", seq: 1 },
          { changeSeq: 2, entryId: "entry-1", seq: 1 },
        ],
        firstSeq: 1,
        inserted: 1,
        lastSeq: 1,
        updated: 1,
      });
      store.close();
      const reopened = new TranscriptStore(path);
      expect(reopened.commitTranscriptDestinationAppend(input)).toEqual(first);
      reopened.close();
    } finally {
      try {
        store.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects non-fresh Agent receipt batches atomically", () => {
    const { dir, path, store } = fixture();
    try {
      store.commitTranscriptDestinationAppend(request());
      const currentAnchor = {
        throughChangeSeq: 1,
        entryIds: ["entry-1"],
        digest: `sha256:${"9".repeat(64)}` as `sha256:${string}`,
      };
      const before = {
        events: store.countEvents("os-destination"),
        changeSeq: store.getLastChangeSeq("os-destination"),
        receipts: receiptCount(path),
      };
      const duplicate = request({
        appendId: "agent-duplicate",
        transcriptAnchor: currentAnchor,
        entries: [
          { ...request().entries[0]!, id: "new-duplicate" },
          { ...request().entries[0]!, id: "new-duplicate" },
        ],
      });
      const update = request({
        appendId: "agent-update",
        transcriptAnchor: currentAnchor,
        entries: [{ ...request().entries[0]!, content: "updated" }],
      });
      const reverseMixed = request({
        appendId: "agent-reverse-mixed",
        transcriptAnchor: currentAnchor,
        entries: [
          { ...request().entries[0]!, id: "new-first" },
          { ...request().entries[0]!, content: "existing-second" },
        ],
      });
      expect(() =>
        store.commitTranscriptDestinationAppendReceipt(request() as never),
      ).toThrow(TypeError);
      expect(() =>
        store.commitTranscriptDestinationAppend(
          request({
            appendId: "generic-anchor-upgrade",
            transcriptAnchor: currentAnchor,
            entries: [{ ...request().entries[0]!, id: "new-generic" }],
          }),
        ),
      ).toThrow(TypeError);
      expect(() =>
        store.commitTranscriptDestinationAppendReceipt(
          request({
            appendId: "agent-stale-anchor",
            transcriptAnchor: emptyAnchor("8"),
            entries: [{ ...request().entries[0]!, id: "new-stale" }],
          }),
        ),
      ).toThrow(TranscriptAppendReceiptMismatchError);
      for (const invalid of [duplicate, update, reverseMixed])
        expect(() =>
          store.commitTranscriptDestinationAppendReceipt(invalid),
        ).toThrow(TranscriptAppendAgentReceiptInvariantError);
      expect({
        events: store.countEvents("os-destination"),
        changeSeq: store.getLastChangeSeq("os-destination"),
        receipts: receiptCount(path),
      }).toEqual(before);
      expect(store.readTail("os-destination").entries[0]?.content).toBe(
        "hello",
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an Agent reference after its destination entry changes", () => {
    const { dir, store } = fixture();
    const transcriptAnchor = emptyAnchor("7");
    const input = request({ transcriptAnchor });
    try {
      const receipt = store.commitTranscriptDestinationAppendReceipt(input);
      const query = {
        sessionId: receipt.sessionId,
        runId: receipt.runId,
        turnId: receipt.turnId,
        generation: receipt.generation,
        appendId: receipt.appendId,
        requestDigest: receipt.requestDigest,
        transcriptAnchor,
      };
      const reference = {
        appendId: receipt.appendId,
        entryIds: receipt.entryIds,
        firstSeq: receipt.firstSeq,
        lastSeq: receipt.lastSeq,
        throughChangeSeq: receipt.throughChangeSeq,
        requestDigest: receipt.requestDigest,
      };
      const db = new Database(join(dir, "transcripts.db"));
      const event = db
        .query(
          "SELECT data FROM transcript_events WHERE session_id=? AND uuid=?",
        )
        .get(receipt.sessionId, receipt.entryIds[0]) as { data: string };
      const tampered = JSON.parse(event.data) as Record<string, unknown>;
      tampered.content = "tampered without a change receipt";
      db.run(
        "UPDATE transcript_events SET data=? WHERE session_id=? AND uuid=?",
        [JSON.stringify(tampered), receipt.sessionId, receipt.entryIds[0]],
      );
      expect(() =>
        store.validateAgentTranscriptReceiptRef({
          sessionId: receipt.sessionId,
          runId: receipt.runId,
          turnId: receipt.turnId,
          generation: receipt.generation,
          transcriptAnchor,
          receipt: reference,
        }),
      ).toThrow(TranscriptAppendReceiptMismatchError);
      db.run(
        "UPDATE transcript_events SET data=? WHERE session_id=? AND uuid=?",
        [event.data, receipt.sessionId, receipt.entryIds[0]],
      );
      db.close();
      expect(
        store.validateAgentTranscriptReceiptRef({
          sessionId: receipt.sessionId,
          runId: receipt.runId,
          turnId: receipt.turnId,
          generation: receipt.generation,
          transcriptAnchor,
          receipt: reference,
        }),
      ).toEqual(reference);
      store.commitTranscriptDestinationAppend(
        request({
          appendId: "later-update",
          entries: [{ ...input.entries[0]!, content: "changed later" }],
        }),
      );
      expect(store.queryTranscriptDestinationReceipt(query)).toEqual(receipt);
      expect(() =>
        store.validateAgentTranscriptReceiptRef({
          sessionId: receipt.sessionId,
          runId: receipt.runId,
          turnId: receipt.turnId,
          generation: receipt.generation,
          transcriptAnchor,
          receipt: reference,
        }),
      ).toThrow(TranscriptAppendReceiptMismatchError);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails closed on contradictory durable receipt rows without repairing them", () => {
    const { dir, path, store } = fixture();
    const input = request({ transcriptAnchor: emptyAnchor("f") });
    try {
      const receipt = store.commitTranscriptDestinationAppendReceipt(input);
      const query = {
        sessionId: receipt.sessionId,
        runId: receipt.runId,
        turnId: receipt.turnId,
        generation: receipt.generation,
        appendId: receipt.appendId,
        requestDigest: receipt.requestDigest,
      };
      const db = new Database(path);
      const row = db
        .query(
          "SELECT result_json FROM transcript_append_receipts WHERE session_id=? AND append_id=?",
        )
        .get(receipt.sessionId, receipt.appendId) as { result_json: string };
      const changed = JSON.parse(row.result_json) as {
        changes: Array<{ changeSeq: number }>;
      };
      changed.changes[0]!.changeSeq = 0;
      db.run(
        "UPDATE transcript_append_receipts SET result_json=? WHERE session_id=? AND append_id=?",
        [JSON.stringify(changed), receipt.sessionId, receipt.appendId],
      );
      db.close();
      expect(() => store.queryTranscriptDestinationReceipt(query)).toThrow(
        TranscriptAppendReceiptCorruptError,
      );
      expect(() =>
        store.commitTranscriptDestinationAppendReceipt(input),
      ).toThrow(TranscriptAppendReceiptCorruptError);
      const verify = new Database(path, { readonly: true });
      const retained = verify
        .query(
          "SELECT result_json FROM transcript_append_receipts WHERE session_id=? AND append_id=?",
        )
        .get(receipt.sessionId, receipt.appendId) as { result_json: string };
      verify.close();
      expect(JSON.parse(retained.result_json)).toMatchObject({
        changes: [{ changeSeq: 0 }],
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("schema creation is additive", () => {
    const { dir, path, store } = fixture();
    try {
      const db = new Database(path, { readonly: true });
      const row = db
        .query(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='transcript_append_receipts'",
        )
        .get() as { sql: string };
      expect(row.sql).toContain("PRIMARY KEY (session_id, append_id)");
      db.close();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
