import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionKernelStoreHost } from "./store-host";
import { sessionKernelSessionDbPath } from "./store";
import {
  assertTranscriptActorRequest,
  decodeAgentTranscriptActorRequest,
} from "./transcript-protocol";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(maxOpen = 1) {
  const root = mkdtempSync(join(tmpdir(), "agent-transcript-actor-"));
  roots.push(root);
  const central = join(root, "kernel.sqlite");
  const isolated = join(root, "sessions");
  const host = new SessionKernelStoreHost(central, isolated, maxOpen);
  const sessionId = "session-agent-destination";
  const kernel = host.storeForSession(sessionId, true);
  expect(
    kernel.applyRunEvent({ sessionId, event: "prompt", runKey: "run-1" })
      .accepted,
  ).toBe(true);
  expect(
    kernel.registerAgentHostPlan({
      op: "register_plan",
      registrationId: "registration-1",
      sessionId,
      runId: "run-1",
      turnId: "turn-1",
      generation: 1,
      planHash: `sha256:${"a".repeat(64)}`,
    }).accepted,
  ).toBe(true);
  const anchor = Object.freeze({
    throughChangeSeq: 0,
    entryIds: Object.freeze([] as string[]),
    digest: `sha256:${"b".repeat(64)}` as const,
  });
  const request = {
    op: "agent_append_destination" as const,
    sessionId,
    requestId: "agent-transcript-destination:append-1",
    appendId: "append-1",
    runId: "run-1",
    turnId: "turn-1",
    generation: 1,
    transcriptAnchor: anchor,
    entries: [
      {
        id: "assistant-1",
        type: "assistant" as const,
        timestamp: "2026-01-01T00:00:00.000Z",
        content: "bounded result",
      },
    ],
  };
  return { root, central, isolated, host, kernel, sessionId, anchor, request };
}

describe("actor-authoritative Agent transcript destination", () => {
  test("atomically appends insert-only rows and returns/query-validates a canonical receipt", () => {
    const f = fixture();
    const first = f.host.transcript(f.request);
    expect(first).toMatchObject({
      replay: false,
      result: {
        appendId: "append-1",
        entryIds: ["assistant-1"],
        firstSeq: 1,
        lastSeq: 1,
        throughChangeSeq: 1,
      },
    });
    const ref = first.result;
    expect(
      f.host.transcript({
        op: "agent_query_destination_receipt",
        sessionId: f.sessionId,
        runId: "run-1",
        turnId: "turn-1",
        generation: 1,
        transcriptAnchor: f.anchor,
        appendId: "append-1",
        requestDigest: ref.requestDigest,
      }),
    ).toEqual(ref);
    expect(
      f.host.transcript({
        op: "agent_validate_destination_receipt",
        sessionId: f.sessionId,
        runId: "run-1",
        turnId: "turn-1",
        generation: 1,
        transcriptAnchor: f.anchor,
        receipt: ref,
      }),
    ).toEqual(ref);
    expect(f.host.transcript({ op: "count", sessionId: f.sessionId })).toBe(1);
    f.host.close();
  });

  test("replays exactly after passivation/reassignment without duplicate rows or wakes", () => {
    const f = fixture();
    const first = f.host.transcript(f.request);
    const wake = f.host.transcript({
      op: "pending_wake",
      sessionId: f.sessionId,
    });
    expect(wake?.cursor).toBe(first.wakeCursor);
    f.host.transcript({
      op: "ack_wake",
      sessionId: f.sessionId,
      cursor: first.wakeCursor,
    });
    f.host.call("setRunState", [
      { sessionId: "evict-me", state: "idle", event: "seed" },
    ]);
    f.host.transcript({ op: "tail", sessionId: "evict-me", limit: 1 });
    f.host.close();

    const reassigned = new SessionKernelStoreHost(f.central, f.isolated, 1);
    const replay = reassigned.transcript(f.request);
    expect(replay).toMatchObject({ replay: true, result: first.result });
    expect(reassigned.transcript({ op: "count", sessionId: f.sessionId })).toBe(
      1,
    );
    expect(
      reassigned.transcript({ op: "pending_wake", sessionId: f.sessionId }),
    ).toBeNull();
    reassigned.close();
  });

  test("fails closed for stale anchors, missing anchor rows, wrong generations, and tombstones", () => {
    const f = fixture();
    const first = f.host.transcript(f.request);
    expect(() =>
      f.host.transcript({
        ...f.request,
        requestId: "stale-anchor",
        appendId: "stale-anchor",
        entries: [{ ...f.request.entries[0], id: "stale-entry" }],
      }),
    ).toThrow(/receipt does not match/);
    expect(() =>
      f.host.transcript({
        ...f.request,
        requestId: "missing-anchor-row",
        appendId: "missing-anchor-row",
        transcriptAnchor: {
          throughChangeSeq: 1,
          entryIds: ["does-not-exist"],
          digest: `sha256:${"c".repeat(64)}`,
        },
        entries: [{ ...f.request.entries[0], id: "missing-entry" }],
      }),
    ).toThrow(/receipt does not match/);
    expect(() =>
      f.host.transcript({
        ...f.request,
        requestId: "wrong-generation",
        appendId: "wrong-generation",
        generation: 2,
        entries: [{ ...f.request.entries[0], id: "wrong-generation-entry" }],
      }),
    ).toThrow(/run fence rejected/);
    f.kernel.tombstoneSession(f.sessionId);
    expect(() => f.host.transcript(f.request)).toThrow(/was deleted/);
    expect(() =>
      f.host.transcript({
        op: "agent_query_destination_receipt",
        sessionId: f.sessionId,
        runId: "run-1",
        turnId: "turn-1",
        generation: 1,
        transcriptAnchor: f.anchor,
        appendId: "append-1",
        requestDigest: first.result.requestDigest,
      }),
    ).toThrow(/was deleted/);
    expect(first.result.appendId).toBe("append-1");
    f.host.close();
  });

  test("rejects historical receipt rows after reset or delete and preserves commit-before-wake recovery", () => {
    const reset = fixture();
    const committed = reset.host.transcript(reset.request);
    expect(
      reset.host.transcript({ op: "pending_wake", sessionId: reset.sessionId }),
    ).not.toBeNull();
    reset.host.close();
    const recovered = new SessionKernelStoreHost(reset.central, reset.isolated);
    expect(
      recovered.transcript({ op: "pending_wake", sessionId: reset.sessionId }),
    ).not.toBeNull();
    recovered.transcript({
      op: "replace",
      sessionId: reset.sessionId,
      requestId: "reset-transcript",
      entries: [],
    });
    expect(() =>
      recovered.transcript({
        op: "agent_validate_destination_receipt",
        sessionId: reset.sessionId,
        runId: "run-1",
        turnId: "turn-1",
        generation: 1,
        transcriptAnchor: reset.anchor,
        receipt: committed.result,
      }),
    ).toThrow(/receipt does not match/);
    recovered.close();

    const deleted = fixture();
    const beforeDelete = deleted.host.transcript(deleted.request);
    deleted.host.transcript({
      op: "delete",
      sessionId: deleted.sessionId,
      requestId: "delete-transcript",
    });
    expect(() =>
      deleted.host.transcript({
        op: "agent_validate_destination_receipt",
        sessionId: deleted.sessionId,
        runId: "run-1",
        turnId: "turn-1",
        generation: 1,
        transcriptAnchor: deleted.anchor,
        receipt: beforeDelete.result,
      }),
    ).toThrow();
    deleted.host.close();
  });

  test("uses exact-key Agent request decoders and freezes bounded entry snapshots", () => {
    const f = fixture();
    const decoded = decodeAgentTranscriptActorRequest(f.request);
    expect(decoded?.op).toBe("agent_append_destination");
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(
      Object.isFrozen(
        decoded && "entries" in decoded ? decoded.entries : undefined,
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(
        decoded && "entries" in decoded ? decoded.entries[0] : undefined,
      ),
    ).toBe(true);
    expect(() =>
      assertTranscriptActorRequest({ ...f.request, injected: true } as never),
    ).toThrow(/invalid keys/);
    expect(() =>
      assertTranscriptActorRequest({
        ...f.request,
        transcriptAnchor: { ...f.anchor, injected: true },
      } as never),
    ).toThrow(/invalid keys/);
    expect(() =>
      assertTranscriptActorRequest({
        op: "agent_validate_destination_receipt",
        sessionId: f.sessionId,
        runId: "run-1",
        turnId: "turn-1",
        generation: 1,
        transcriptAnchor: f.anchor,
        receipt: { appendId: "not-complete" },
      } as never),
    ).toThrow(/receipt is invalid/);
    f.host.close();
  });

  test("keeps Agent transcript commits out of the central transcript database", () => {
    const f = fixture();
    f.host.transcript(f.request);
    f.host.close();
    const central = new Database(f.central, { readonly: true });
    expect(
      central
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='transcript_events'",
        )
        .get(),
    ).toBeNull();
    central.close();
    const actor = new Database(
      sessionKernelSessionDbPath(f.sessionId, f.isolated),
      { readonly: true },
    );
    expect(
      actor.query("SELECT COUNT(*) AS count FROM transcript_events").get(),
    ).toEqual({ count: 1 });
    actor.close();
  });
});
