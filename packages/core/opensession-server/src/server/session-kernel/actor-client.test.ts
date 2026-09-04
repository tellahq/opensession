import { afterEach, describe, expect, test } from "bun:test";
import {
  SessionKernelActorClient,
  SessionKernelActorError,
  SessionKernelQuarantinedError,
} from "./actor-client";
import { SESSION_KERNEL_ACTOR_VERSION } from "./actor-protocol";

let client: SessionKernelActorClient | undefined;
afterEach(() => {
  client?.terminate();
  client = undefined;
});

async function actor(): Promise<SessionKernelActorClient> {
  const worker = new Worker(
    new URL("../../session-kernel-worker.ts", import.meta.url).href,
    { type: "module" },
  );
  client = new SessionKernelActorClient(worker);
  await client.hello();
  return client;
}

type Listener = (event: MessageEvent) => void;
class FakeWorker {
  listeners = new Map<string, Listener>();
  posts: Array<Record<string, unknown>> = [];
  constructor(
    readonly respond: (
      message: Record<string, unknown>,
      emit: (data: Record<string, unknown>) => void,
    ) => void,
  ) {}
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, listener);
  }
  removeEventListener() {}
  postMessage(message: Record<string, unknown>) {
    this.posts.push(message);
    this.respond(message, (data) =>
      this.listeners.get("message")?.({ data } as MessageEvent),
    );
  }
  terminate() {}
}

function callResult(rpcId: unknown, result: unknown) {
  const body = JSON.stringify({ ok: true, result });
  return { t: "call_result", rpcId, status: 1, length: body.length, body };
}

describe("asynchronous session kernel actor boundary", () => {
  test("maintains run projections without a global boot scan", async () => {
    const host = await actor();
    await host.decideRunEventAsync({
      sessionId: "persisted",
      event: "prompt",
      runKey: "run-4",
    });
    expect(host.runStateProjection("persisted")).toMatchObject({
      state: "starting",
      generation: 1,
      currentRunId: "run-4",
    });
  });

  test("atomically preserves concurrent queue enqueues", async () => {
    const host = await actor();
    const sessionId = "concurrent-enqueues";
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        host.decideDeliveryAsync({
          op: "enqueue",
          sessionId,
          item: { id: `item-${index}`, content: `prompt-${index}` },
        }),
      ),
    );
    const snapshot = await host.decideDeliveryAsync({
      op: "snapshot",
      sessionId,
    });
    expect(snapshot.queued).toHaveLength(20);
  });

  test("a response slower than the former 500ms limit never blocks the event loop", async () => {
    let timerFired = false;
    const worker = new FakeWorker((message, emit) => {
      setTimeout(() => emit(callResult(message.rpcId, undefined)), 650);
    });
    const host = new SessionKernelActorClient(worker as unknown as Worker);
    client = host;
    setTimeout(() => {
      timerFired = true;
    }, 20);
    const pending = host.callAsync(
      { t: "store", method: "creationState", args: ["slow"] },
      "creationState",
    );
    await Bun.sleep(50);
    expect(timerFired).toBe(true);
    await pending;
  });

  test("a retryable read reconnect does not poison unrelated work", async () => {
    let failed = false;
    const worker = new FakeWorker((message, emit) => {
      if (!failed) {
        failed = true;
        queueMicrotask(() =>
          emit({
            t: "error",
            rpcId: message.rpcId,
            error: "connection closed",
            retryable: true,
          }),
        );
        return;
      }
      queueMicrotask(() => emit(callResult(message.rpcId, undefined)));
    });
    const host = new SessionKernelActorClient(worker as unknown as Worker);
    client = host;
    await expect(
      host.callAsync(
        { t: "store", method: "creationState", args: ["first"] },
        "creationState",
      ),
    ).resolves.toBeUndefined();
    await expect(
      host.callAsync(
        { t: "store", method: "creationState", args: ["unrelated"] },
        "creationState",
      ),
    ).resolves.toBeUndefined();
  });

  test("ambiguous mutations are not replayed blindly", async () => {
    const worker = new FakeWorker((message, emit) => {
      queueMicrotask(() =>
        emit({
          t: "error",
          rpcId: message.rpcId,
          error: "connection closed after admission",
          retryable: true,
        }),
      );
    });
    const host = new SessionKernelActorClient(worker as unknown as Worker);
    client = host;
    await expect(
      host.decideGatewayAsync({
        op: "request",
        sessionId: "ambiguous",
        requestId: "stable-request",
        operation: "websocket_command",
      }),
    ).rejects.toBeInstanceOf(SessionKernelActorError);
    expect(worker.posts).toHaveLength(1);
  });

  test("replay-safe retries retain one command identity", async () => {
    let attempts = 0;
    const worker = new FakeWorker((message, emit) => {
      attempts += 1;
      if (attempts === 1) {
        queueMicrotask(() =>
          emit({
            t: "error",
            rpcId: message.rpcId,
            error: "backpressure",
            retryable: true,
          }),
        );
      } else queueMicrotask(() => emit(callResult(message.rpcId, undefined)));
    });
    const host = new SessionKernelActorClient(worker as unknown as Worker);
    client = host;
    const command = {
      kind: "turn" as const,
      commandId: "stable-command",
      request: { op: "snapshot" as const, sessionId: "safe-read" },
    };
    await host.callAsync({ t: "reduce", command }, "turn snapshot");
    expect(
      worker.posts.map(
        (post) =>
          (post.command as { commandId?: string } | undefined)?.commandId,
      ),
    ).toEqual(["stable-command", "stable-command"]);
  });

  test("classifies a session quarantine without killing the client", async () => {
    let quarantine = true;
    const worker = new FakeWorker((message, emit) => {
      if (quarantine) {
        quarantine = false;
        const body = JSON.stringify({
          ok: false,
          code: "session_quarantined",
          sessionId: "one-session",
          error: "settlement is quarantined",
        });
        queueMicrotask(() =>
          emit({
            t: "call_result",
            rpcId: message.rpcId,
            status: -1,
            length: body.length,
            body,
          }),
        );
      } else queueMicrotask(() => emit(callResult(message.rpcId, undefined)));
    });
    const host = new SessionKernelActorClient(worker as unknown as Worker);
    client = host;
    await expect(
      host.decideGatewayAsync({
        op: "request",
        sessionId: "one-session",
        requestId: "request",
        operation: "websocket_command",
      }),
    ).rejects.toBeInstanceOf(SessionKernelQuarantinedError);
    await expect(
      host.callAsync(
        { t: "store", method: "creationState", args: ["healthy-session"] },
        "creationState",
      ),
    ).resolves.toBeUndefined();
  });
});

describe("actor-owned session metadata", () => {
  // `expect(promise).rejects` does not pump Worker messages in bun test, so a
  // rejection carried by the actor worker is awaited by hand.
  async function rejection(work: Promise<unknown>): Promise<string> {
    try {
      await work;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected the actor to reject");
  }
  const doc = (sessionId: string, rev: number) =>
    JSON.stringify({
      id: sessionId,
      title: `title ${rev}`,
      lastActivity: "2026-09-01T00:00:00.000Z",
      rev,
    });
  const put = (
    host: SessionKernelActorClient,
    sessionId: string,
    rev: number,
    expectedRev: number | null,
    requestId = crypto.randomUUID(),
  ) =>
    host.decideMetadataAsync({
      op: "put",
      sessionId,
      requestId,
      expectedRev,
      rev,
      doc: doc(sessionId, rev),
      archived: false,
      lastActivityMs: Date.parse("2026-09-01T00:00:00.000Z"),
    });

  test("commits with compare-and-set, projects to the catalog, and tracks exports", async () => {
    const host = await actor();
    const sessionId = `metadata-${crypto.randomUUID()}`;
    expect(await host.decideMetadataAsync({ op: "get", sessionId })).toBeNull();

    expect(await put(host, sessionId, 1, null)).toEqual({
      status: "committed",
      rev: 1,
    });
    const stored = await host.decideMetadataAsync({ op: "get", sessionId });
    expect(stored).toMatchObject({ sessionId, rev: 1, doc: doc(sessionId, 1) });

    // The catalog is a projection of the commit and knows the file is stale.
    const page = await host.decideMetadataAsync({
      op: "catalog_page",
      afterSessionId: "",
      limit: 1000,
    });
    expect(page.find((row) => row.sessionId === sessionId)).toMatchObject({
      rev: 1,
      exportedRev: 0,
      archived: false,
    });
    const pending = await host.decideMetadataAsync({
      op: "pending_exports",
      limit: 1000,
    });
    expect(pending).toContainEqual({ sessionId, rev: 1, exportedRev: 0 });

    await host.decideMetadataAsync({ op: "exported", sessionId, rev: 1 });
    const settled = await host.decideMetadataAsync({
      op: "pending_exports",
      limit: 1000,
    });
    expect(settled.some((row) => row.sessionId === sessionId)).toBe(false);

    // A stale writer is told the truth instead of clobbering it.
    expect(await put(host, sessionId, 1, null)).toMatchObject({
      status: "conflict",
      current: { rev: 1 },
    });
    expect(await put(host, sessionId, 3, 2)).toMatchObject({
      status: "conflict",
      current: { rev: 1 },
    });
    // A replayed request id returns its receipt.
    const requestId = crypto.randomUUID();
    expect(await put(host, sessionId, 2, 1, requestId)).toEqual({
      status: "committed",
      rev: 2,
    });
    expect(await put(host, sessionId, 2, 1, requestId)).toEqual({
      status: "duplicate",
      rev: 2,
    });
    // Advancing the catalog reopens the export gap.
    expect(
      await host.decideMetadataAsync({ op: "pending_exports", limit: 1000 }),
    ).toContainEqual({ sessionId, rev: 2, exportedRev: 1 });
  });

  test("a deleted session leaves neither document nor catalog row", async () => {
    const host = await actor();
    const sessionId = `metadata-deleted-${crypto.randomUUID()}`;
    await put(host, sessionId, 1, null);
    await host.decideCoreAsync({ op: "tombstone", sessionId });
    expect(await host.decideMetadataAsync({ op: "get", sessionId })).toBeNull();
    expect(await rejection(put(host, sessionId, 2, 1))).toMatch(/deleted/);
    const page = await host.decideMetadataAsync({
      op: "catalog_page",
      afterSessionId: "",
      limit: 1000,
    });
    expect(page.some((row) => row.sessionId === sessionId)).toBe(false);
  });

  test("rejects malformed metadata commands before touching storage", async () => {
    const host = await actor();
    const sessionId = `metadata-invalid-${crypto.randomUUID()}`;
    expect(
      await rejection(
        host.decideMetadataAsync({
          op: "put",
          sessionId,
          requestId: crypto.randomUUID(),
          expectedRev: 4,
          rev: 9,
          doc: "{}",
          archived: false,
          lastActivityMs: 0,
        }),
      ),
    ).toMatch(/advance by one/);
    expect(
      await rejection(
        host.decideMetadataAsync({
          op: "catalog_page",
          afterSessionId: "",
          limit: 0,
        }),
      ),
    ).toMatch(/page size/);
  });
});
