/**
 * run-ws transport tests: seq/ack replay (ws-buffer.ts + run-ws.ts) and the
 * upgrade auth rules. Drives a real Bun.serve wired exactly like opensession.ts
 * (fetch → handleSandboxWsUpgrade, websocket → sandboxWs* hooks) with scripted
 * WS clients playing the host side — no model runs, no sandboxes.
 *
 * zz- prefix: keeps this at the end of the full suite like the other
 * integration-ish test files.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// ws-buffer has no src/server deps — safe to import at load time.
import { ndjsonReader } from "../runner-host/protocol";
import { WsFrameBuffer, replayStartFor } from "../runner-host/ws-buffer";

// run-ws → run-rpc → paths resolves OPENSESSION_SESSIONS_DIR (and HOME) at module
// load. bun test evaluates every test file's module graph BEFORE running any
// tests, so a static import here would pin the live paths under tests (like
// sessions.test) that override HOME in their own beforeAll. Deferred imports
// keep this file's graph out of the shared module cache until zz- runtime.
let runWs: typeof import("./run-ws");
let registerRunToken: typeof import("./run-rpc").registerRunToken;
let unregisterRunToken: typeof import("./run-rpc").unregisterRunToken;
let registerInteractiveMcpBuilder: typeof import("./run-rpc").registerInteractiveMcpBuilder;

// ── scratch server (same wiring as opensession.ts / the verify suites) ─────────

let srv: ReturnType<typeof Bun.serve>;
let BASE = "";

beforeAll(async () => {
  runWs = await import("./run-ws");
  ({ registerRunToken, unregisterRunToken, registerInteractiveMcpBuilder } =
    await import("./run-rpc"));
  srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      return (
        runWs.handleSandboxWsUpgrade(req, server, new URL(req.url).pathname) ??
        undefined
      );
    },
    websocket: {
      open(ws) {
        runWs.sandboxWsOpen(ws);
      },
      message(ws, m) {
        runWs.sandboxWsMessage(ws, m as any);
      },
      close(ws) {
        runWs.sandboxWsClose(ws);
      },
    },
  });
  BASE = `127.0.0.1:${srv.port}`;
});

afterAll(() => {
  srv?.stop(true);
});

async function until<T>(
  fn: () => T | undefined | false,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error("until(): timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Scripted host: dials the run-ws route and records inbound messages. */
function dialHost(hostId: string, token: string) {
  const inbox: any[] = [];
  const sock = new WebSocket(`ws://${BASE}/run-ws/${hostId}`, {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as string[]);
  let open = false;
  let closed = false;
  sock.onopen = () => {
    open = true;
  };
  sock.onmessage = (ev) => inbox.push(JSON.parse(String(ev.data)));
  sock.onclose = () => {
    closed = true;
  };
  return {
    sock,
    inbox,
    isOpen: () => open,
    isClosed: () => closed,
    nextAck: (after = 0) =>
      until(() => inbox.filter((m) => m.t === "ack")[after], 5_000),
  };
}

describe("WsFrameBuffer oversized frames", () => {
  test("retains a frame larger than the whole byte budget", () => {
    const buf = new WsFrameBuffer(10, 90);
    // A sandboxed Read image arrives inline and blows the byte cap on its own.
    buf.stamp({
      t: "event",
      event: {
        type: "tool_result",
        images: [`data:image/png;base64,${"x".repeat(200)}`],
      },
    });
    const afterImage = buf.replayFrom(0);
    expect(afterImage.lines).toHaveLength(1);
    expect(afterImage.gap).toBeNull();
    // Normal frames still ride alongside it rather than being crowded out.
    buf.stamp({ t: "event", event: { type: "text_chunk", text: "after" } });
    const replay = buf.replayFrom(0);
    expect(replay.lines).toHaveLength(2);
    expect(replay.lines[1]).toContain("after");
  });

  test("still trims ordinary overflow to the byte budget", () => {
    const buf = new WsFrameBuffer(10, 200);
    for (let i = 0; i < 20; i++)
      buf.stamp({ t: "event", event: { type: "text_chunk", text: `f${i}` } });
    const replay = buf.replayFrom(0);
    expect(replay.lines.length).toBeLessThan(20);
    expect(replay.gap).not.toBeNull();
  });

  test("counts UTF-8 bytes, not UTF-16 code units", () => {
    // Four-byte characters: a budget counted in code units would hold roughly
    // twice the bytes it advertises.
    const wide = new WsFrameBuffer(1000, 400);
    for (let i = 0; i < 40; i++)
      wide.stamp({ t: "event", event: { text: "🙂".repeat(10) } });
    const bytes = wide
      .replayFrom(0)
      .lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
    expect(bytes).toBeLessThanOrEqual(400);
  });
});

describe("ndjsonReader", () => {
  test("preserves UTF-8 split across chunks and handles multiple lines", () => {
    const messages: any[] = [];
    const read = ndjsonReader((message) => messages.push(message), "test");
    const input = Buffer.from(
      `${JSON.stringify({ text: "café" })}\n${JSON.stringify({ ok: true })}\n`,
    );
    // Cut the chunk INSIDE the two-byte é. Decoding per-chunk turns each half
    // into U+FFFD and silently corrupts the line.
    const split = input.indexOf(Buffer.from("é")) + 1;
    read(input.subarray(0, split));
    read(input.subarray(split));
    expect(messages).toEqual([{ text: "café" }, { ok: true }]);
  });

  test("assembles a large line spread over many chunks", () => {
    const messages: any[] = [];
    const read = ndjsonReader((message) => messages.push(message), "test");
    const line = Buffer.from(
      JSON.stringify({ image: "x".repeat(2 * 1024 * 1024) }) + "\n",
    );
    for (let offset = 0; offset < line.length; offset += 64 * 1024) {
      read(line.subarray(offset, offset + 64 * 1024));
    }
    expect(messages).toHaveLength(1);
    expect(messages[0].image.length).toBe(2 * 1024 * 1024);
  });
});

// ── ws-buffer unit behavior ───────────────────────────────────────────────────

describe("WsFrameBuffer", () => {
  test("stamps monotonically and replays after a watermark", () => {
    const buf = new WsFrameBuffer();
    for (let i = 1; i <= 5; i++) buf.stamp({ t: "event", i });
    expect(buf.lastSeq).toBe(5);
    const r = buf.replayFrom(2);
    expect(r.gap).toBeNull();
    expect(r.lines.map((l) => JSON.parse(l).seq)).toEqual([3, 4, 5]);
  });

  test("ack releases frames below the watermark", () => {
    const buf = new WsFrameBuffer();
    for (let i = 1; i <= 4; i++) buf.stamp({ t: "event", i });
    buf.ack(3);
    expect(buf.replayFrom(3).lines.map((l) => JSON.parse(l).seq)).toEqual([4]);
  });

  test("overflow drops oldest and reports the gap", () => {
    const buf = new WsFrameBuffer(3, Number.MAX_SAFE_INTEGER);
    for (let i = 1; i <= 5; i++) buf.stamp({ t: "event", i });
    const r = buf.replayFrom(0);
    expect(r.gap).toEqual({ from: 1, to: 2 });
    expect(r.lines.map((l) => JSON.parse(l).seq)).toEqual([3, 4, 5]);
    // A replay that starts past the hole reports no gap.
    expect(buf.replayFrom(2).gap).toBeNull();
  });

  test("byte bound trims like the frame bound", () => {
    const buf = new WsFrameBuffer(10_000, 90);
    for (let i = 1; i <= 5; i++) buf.stamp({ t: "event", pad: "x".repeat(20) });
    const r = buf.replayFrom(0);
    expect(r.lines.length).toBeLessThan(5);
    expect(r.gap?.from).toBe(1);
  });
});

describe("replayStartFor", () => {
  test("matching epoch resumes from the server's consumed watermark", () => {
    expect(replayStartFor({ seq: 3, epoch: "e1" }, "e1", 7)).toBe(3);
    // Clamped — the server can't have consumed frames we never produced.
    expect(replayStartFor({ seq: 9, epoch: "e1" }, "e1", 7)).toBe(7);
  });
  test("new/unknown epoch streams from the connection point (no replay)", () => {
    expect(replayStartFor({ seq: 3, epoch: "e2" }, "e1", 7)).toBe(7);
    expect(replayStartFor({ seq: 3 }, "e1", 7)).toBe(7);
    expect(replayStartFor({ seq: 3, epoch: "e1" }, null, 0)).toBe(0);
  });
});

describe("timer poison starvation classification", () => {
  test("defers when host load reaches runnable capacity", () => {
    expect(runWs.shouldDeferTimerPoisonForStarvation(16, 16, 80_000)).toBe(
      true,
    );
  });

  test("does not defer below capacity or beyond the starvation hold", () => {
    expect(runWs.shouldDeferTimerPoisonForStarvation(15.9, 16, 80_000)).toBe(
      false,
    );
    expect(runWs.shouldDeferTimerPoisonForStarvation(40, 16, 300_000)).toBe(
      false,
    );
  });
});

// ── end-to-end: dial, consume, drop, redial, replay, dedupe ──────────────────

describe("run-ws seq/ack replay", () => {
  test("reconnect replays the disconnect window exactly once", async () => {
    const hostId = "rh-zz-replay";
    const token = crypto.randomUUID();
    runWs.registerRunWsHost(hostId, token);
    const buf = new WsFrameBuffer();

    // First connection: hello-ack arrives with seq 0 and a stable epoch.
    const c1 = dialHost(hostId, token);
    const ack1 = await c1.nextAck();
    expect(ack1.seq).toBe(0);
    const epoch: string = ack1.epoch;
    expect(epoch).toBeTruthy();

    // Stream hello + three sequenced frames, then attach a consumer.
    c1.sock.send(
      JSON.stringify({ t: "hello", hostId, state: "running", pendingAsks: [] }),
    );
    for (let i = 1; i <= 3; i++) {
      c1.sock.send(
        buf.stamp({ t: "event", event: { type: "text_chunk", text: `e${i}` } }),
      );
    }
    const got1: any[] = [];
    let closed1 = false;
    const connector = runWs.runWsConnector(hostId);
    await until(() => runWs.hasLiveRunWsConnection(hostId));
    const conn1 = await connector.connect({
      onMsg: (m) => got1.push(m),
      onClose: () => {
        closed1 = true;
      },
    });
    await until(() => got1.length >= 4);
    expect(got1.map((m) => m.t)).toEqual(["hello", "event", "event", "event"]);
    // The consumed watermark advanced to 3 — a ping piggybacks an ack with it.
    c1.sock.send('{"t":"ping"}');
    const flushAck = await until(() =>
      c1.inbox.find((m) => m.t === "ack" && m.seq === 3),
    );
    expect(flushAck.epoch).toBe(epoch);
    expect(conn1.send({ t: "pong" })).toBe(true);

    // Server-side drop (network blip): host keeps stamping while offline.
    expect(runWs.dropRunWsConnection(hostId)).toBe(true);
    await until(() => c1.isClosed() && closed1);
    for (let i = 4; i <= 6; i++) {
      buf.stamp({ t: "event", event: { type: "text_chunk", text: `e${i}` } });
    }

    // Redial: the hello-ack still carries the SAME epoch and the consumed
    // watermark (3) — replay from there, deliberately overlapping (2..6) to
    // prove the server drops already-consumed seqs.
    const c2 = dialHost(hostId, token);
    const ack2 = await c2.nextAck();
    expect(ack2.epoch).toBe(epoch);
    expect(ack2.seq).toBe(3);
    const from = replayStartFor(ack2, epoch, buf.lastSeq);
    expect(from).toBe(3);
    for (const line of buf.replayFrom(from - 1).lines) c2.sock.send(line); // overlap: 3..6
    const got2: any[] = [];
    const conn2 = await connector.connect({
      onMsg: (m) => got2.push(m),
      onClose: () => {},
    });
    await until(() => got2.length >= 3);
    expect(got2.map((m) => m.seq)).toEqual([4, 5, 6]); // 3 deduped, 4..6 once
    c2.sock.send('{"t":"ping"}');
    await until(() => c2.inbox.find((m) => m.t === "ack" && m.seq === 6));
    conn2.close();
    runWs.unregisterRunWsHost(hostId);
  });

  test("frames parked before a consumer attaches are not acked (and survive a drop)", async () => {
    const hostId = "rh-zz-preattach";
    const token = crypto.randomUUID();
    runWs.registerRunWsHost(hostId, token);
    const buf = new WsFrameBuffer();

    const c1 = dialHost(hostId, token);
    const ack1 = await c1.nextAck();
    expect(ack1.seq).toBe(0);
    c1.sock.send(
      buf.stamp({ t: "event", event: { type: "text_chunk", text: "a" } }),
    );
    c1.sock.send(
      buf.stamp({ t: "event", event: { type: "text_chunk", text: "b" } }),
    );
    // Give the server a beat to park them, then drop with no consumer attached.
    await new Promise((r) => setTimeout(r, 100));
    c1.sock.close();
    await until(() => c1.isClosed());

    // The parked frames died with the socket — but they were never acked, so
    // the redial's hello-ack still says 0 and the replay recovers them.
    const c2 = dialHost(hostId, token);
    const ack2 = await c2.nextAck();
    expect(ack2.seq).toBe(0);
    for (const line of buf.replayFrom(replayStartFor(ack2, ack2.epoch, 0))
      .lines) {
      c2.sock.send(line);
    }
    const got: any[] = [];
    const conn = await runWs.runWsConnector(hostId).connect({
      onMsg: (m) => got.push(m),
      onClose: () => {},
    });
    await until(() => got.length >= 2);
    expect(got.map((m) => m.seq)).toEqual([1, 2]);
    conn.close();
    runWs.unregisterRunWsHost(hostId);
  });

  test("unregister mints a fresh epoch (no replay into a new registration)", async () => {
    const hostId = "rh-zz-epoch";
    const token = crypto.randomUUID();
    runWs.registerRunWsHost(hostId, token);
    const c1 = dialHost(hostId, token);
    const ack1 = await c1.nextAck();
    runWs.unregisterRunWsHost(hostId);
    await until(() => c1.isClosed());

    runWs.registerRunWsHost(hostId, token);
    const c2 = dialHost(hostId, token);
    const ack2 = await c2.nextAck();
    expect(ack2.epoch).not.toBe(ack1.epoch);
    // Host side: mismatched epoch → stream from the connection point only.
    expect(replayStartFor(ack2, ack1.epoch, 5)).toBe(5);
    c2.sock.close();
    runWs.unregisterRunWsHost(hostId);
  });
});

// ── upgrade auth ───────────────────────────────────────────────────────────────

describe("run-ws upgrade auth", () => {
  test("run-ws rejects a wrong/missing token pre-upgrade", async () => {
    runWs.registerRunWsHost("rh-zz-auth", "right-token");
    const wrong = await fetch(`http://${BASE}/run-ws/rh-zz-auth`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrong.status).toBe(403);
    const missing = await fetch(`http://${BASE}/run-ws/rh-zz-auth`);
    expect(missing.status).toBe(403);
    const unknownHost = await fetch(`http://${BASE}/run-ws/rh-zz-nope`, {
      headers: { authorization: "Bearer right-token" },
    });
    expect(unknownHost.status).toBe(403);
    runWs.unregisterRunWsHost("rh-zz-auth");
  });

  test("a registered run-rpc token does NOT open the run-ws route", async () => {
    const rpcToken = crypto.randomUUID();
    registerRunToken(rpcToken, { sessionId: "bks-zz-rpc" });
    runWs.registerRunWsHost("rh-zz-auth2", "ws-token-2");
    const res = await fetch(`http://${BASE}/run-ws/rh-zz-auth2`, {
      headers: { authorization: `Bearer ${rpcToken}` },
    });
    expect(res.status).toBe(403);
    unregisterRunToken(rpcToken);
    runWs.unregisterRunWsHost("rh-zz-auth2");
  });
});

describe("rpc-ws upgrade auth (WS-transport opt-in only)", () => {
  test("a normal run's rpcToken is rejected — only ws-transport tokens open rpc-ws", async () => {
    // Every proxied run (systemd hosts, codex, pi) registers one of
    // these; it must NOT be a network credential.
    const rpcToken = crypto.randomUUID();
    registerRunToken(rpcToken, { sessionId: "bks-zz-rpcws" });
    const asBearer = await fetch(`http://${BASE}/rpc-ws`, {
      headers: { authorization: `Bearer ${rpcToken}` },
    });
    expect(asBearer.status).toBe(403);
    // Even naming a live ws-transport host doesn't make an rpc token work.
    runWs.registerRunWsHost("rh-zz-rpcws", "ws-token-3");
    const withHost = await fetch(`http://${BASE}/rpc-ws?host=rh-zz-rpcws`, {
      headers: { authorization: `Bearer ${rpcToken}` },
    });
    expect(withHost.status).toBe(403);
    // And a valid wsToken presented for the WRONG host is refused.
    const wrongHost = await fetch(`http://${BASE}/rpc-ws?host=rh-zz-nope`, {
      headers: { authorization: "Bearer ws-token-3" },
    });
    expect(wrongHost.status).toBe(403);
    const noHost = await fetch(`http://${BASE}/rpc-ws`, {
      headers: { authorization: "Bearer ws-token-3" },
    });
    expect(noHost.status).toBe(403);
    unregisterRunToken(rpcToken);
    runWs.unregisterRunWsHost("rh-zz-rpcws");
  });

  test("a ws-transport run's hostId+wsToken opens rpc-ws; frames auth per rpc token", async () => {
    const hostId = "rh-zz-rpcok";
    const wsToken = crypto.randomUUID();
    const rpcToken = crypto.randomUUID();
    runWs.registerRunWsHost(hostId, wsToken);
    registerRunToken(rpcToken, { sessionId: "bks-zz-rpcok" });
    registerInteractiveMcpBuilder(() => ({})); // no servers — 404 proves dispatch ran

    const inbox: any[] = [];
    const sock = new WebSocket(`ws://${BASE}/rpc-ws?host=${hostId}`, {
      headers: { authorization: `Bearer ${wsToken}` },
    } as unknown as string[]);
    let open = false;
    sock.onopen = () => {
      open = true;
    };
    sock.onmessage = (ev) => inbox.push(JSON.parse(String(ev.data)));
    await until(() => open);

    // Valid frame token → dispatch runs. tools/list for a server this run
    // doesn't carry answers 200 with an empty tool list (shared pi
    // servers list the union of in-process servers in their config; the
    // proxy must stay healthy) — tools/CALL on it still 404s.
    sock.send(
      JSON.stringify({
        id: "f1",
        path: "/mcp/list",
        token: rpcToken,
        server: "nope",
      }),
    );
    const ok = await until(() => inbox.find((m) => m.id === "f1"));
    expect(ok.status).toBe(200);
    expect(ok.body?.tools ?? []).toEqual([]);
    sock.send(
      JSON.stringify({
        id: "f1c",
        path: "/mcp/call",
        token: rpcToken,
        server: "nope",
        tool: "x",
        args: {},
      }),
    );
    const okCall = await until(() => inbox.find((m) => m.id === "f1c"));
    expect(okCall.status).toBe(404);
    // Unknown frame token → 403 from dispatchRunRpc even on an authed socket.
    sock.send(
      JSON.stringify({
        id: "f2",
        path: "/mcp/list",
        token: "bogus",
        server: "nope",
      }),
    );
    const bad = await until(() => inbox.find((m) => m.id === "f2"));
    expect(bad.status).toBe(403);

    sock.close();
    unregisterRunToken(rpcToken);
    runWs.unregisterRunWsHost(hostId);
  });
});
