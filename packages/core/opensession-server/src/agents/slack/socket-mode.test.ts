import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackEventInbox } from "./event-inbox";
import { SlackSocketMode, slackSocketModeEnabled } from "./socket-mode";

class FakeSocket extends EventTarget {
  readyState = 0;
  sent: string[] = [];
  closeCount = 0;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closeCount++;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  message(payload: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(payload) }),
    );
  }
  hello() {
    this.readyState = 1;
    this.message({ type: "hello" });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
const ticket = () =>
  Response.json({
    ok: true,
    url: "wss://wss-primary.slack.com/link?ticket=synthetic",
  });

function harness(
  options: {
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    dispatchEvent?: (payload: unknown) => Promise<void>;
    dispatchInteractive?: (payload: unknown) => Promise<void>;
    random?: () => number;
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const warnings: string[] = [];
  let timerId = 0;
  const client = new SlackSocketMode("xapp-synthetic", {
    dispatchEvent: options.dispatchEvent ?? (async () => {}),
    dispatchInteractive: options.dispatchInteractive ?? (async () => {}),
    fetch: async (url, init) => {
      requests.push({ url, init });
      return options.fetch ? options.fetch(url, init) : ticket();
    },
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    random: options.random ?? (() => 0.5),
    setTimeout: ((callback: () => void, delay: number) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => {
      timers.delete(id);
    }) as unknown as typeof clearTimeout,
    warn: (message) => warnings.push(message),
  });
  return {
    client,
    sockets,
    requests,
    timers,
    warnings,
    async start() {
      client.start();
      await flush();
      sockets[0]!.hello();
      return sockets[0]!;
    },
    async tick() {
      const [id, timer] = timers.entries().next().value!;
      timers.delete(id);
      timer.callback();
      await flush();
      return timer.delay;
    },
  };
}
const event = {
  type: "events_api",
  envelope_id: "event-1",
  payload: {
    type: "event_callback",
    event: { channel: "D1", ts: "1.0", text: "synthetic" },
  },
};
const interactive = {
  type: "interactive",
  envelope_id: "action-1",
  payload: { type: "block_actions", actions: [] },
};

describe("Socket Mode dispatch", () => {
  test("awaits event dispatch before ack; rejected dispatch is never acknowledged", async () => {
    const work = deferred<void>();
    const h = harness({ dispatchEvent: () => work.promise });
    const socket = await h.start();
    socket.message(event);
    await flush();
    expect(socket.sent).toEqual([]);
    work.resolve();
    await flush();
    expect(socket.sent).toEqual(['{"envelope_id":"event-1"}']);
    h.client.stop();

    const failed = harness({
      dispatchEvent: async () => {
        throw new Error("sensitive event data");
      },
    });
    const other = await failed.start();
    other.message(event);
    await flush();
    expect(other.sent).toEqual([]);
    expect(failed.warnings.join()).not.toContain("sensitive");
    failed.client.stop();
  });

  test("acks interactive payloads before dispatch, including slow or failing handlers", async () => {
    const work = deferred<void>();
    let dispatched = 0;
    const h = harness({
      dispatchInteractive: () => {
        expect(h.sockets[0]!.sent).toEqual(['{"envelope_id":"action-1"}']);
        dispatched++;
        return work.promise;
      },
    });
    const socket = await h.start();
    socket.message(interactive);
    expect(dispatched).toBe(1);
    work.reject(new Error("synthetic failure"));
    await flush();
    expect(socket.sent).toHaveLength(1);
    h.client.stop();
  });

  test("ignores malformed, unknown and pre-hello envelopes", async () => {
    let calls = 0;
    const h = harness({
      dispatchEvent: async () => {
        calls++;
      },
    });
    h.client.start();
    await flush();
    const socket = h.sockets[0]!;
    socket.message(event);
    socket.hello();
    for (const payload of [
      null,
      [],
      1,
      {},
      { ...event, envelope_id: 7 },
      { ...event, payload: null },
      { ...event, type: "unsupported" },
    ])
      socket.message(payload);
    socket.dispatchEvent(new MessageEvent("message", { data: "{" }));
    await flush();
    expect(calls).toBe(0);
    expect(socket.sent).toEqual([]);
    h.client.stop();
  });

  test("shutdown fences a late event ack and stale messages", async () => {
    const work = deferred<void>();
    let calls = 0;
    const h = harness({
      dispatchEvent: () => {
        calls++;
        return work.promise;
      },
    });
    const socket = await h.start();
    socket.message(event);
    h.client.stop();
    socket.message(event);
    work.resolve();
    await flush();
    expect(calls).toBe(1);
    expect(socket.sent).toEqual([]);
    expect(h.timers.size).toBe(0);
  });
});

describe("connection lifecycle", () => {
  test("requires explicit opt-in and does nothing until start; start is idempotent", async () => {
    expect(slackSocketModeEnabled({ SLACK_APP_TOKEN: "xapp-synthetic" })).toBe(
      false,
    );
    expect(slackSocketModeEnabled({ SLACK_SOCKET_MODE: "1" })).toBe(false);
    expect(slackSocketModeEnabled({ SLACK_SOCKET_MODE: "true" })).toBe(true);
    const h = harness();
    expect(h.requests).toEqual([]);
    expect(h.timers.size).toBe(0);
    h.client.start();
    h.client.start();
    await flush();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      url: "https://slack.com/api/apps.connections.open",
      init: {
        method: "POST",
        headers: { Authorization: "Bearer xapp-synthetic" },
        redirect: "error",
      },
    });
    expect(h.client.health()).toEqual({
      state: "connecting",
      connected: false,
    });
    h.sockets[0]!.hello();
    expect(h.client.health()).toEqual({ state: "connected", connected: true });
    h.client.stop();
  });

  test.each(["warning", "refresh_requested"])(
    "%s rotates once, keeps old socket until hello, ignores stale callbacks",
    async (reason) => {
      const h = harness();
      const old = await h.start();
      old.message({ type: "disconnect", reason });
      old.message({ type: "disconnect", reason });
      await flush();
      expect(h.sockets).toHaveLength(2);
      expect(old.closeCount).toBe(0);
      old.message(event);
      await flush();
      expect(old.sent).toHaveLength(1);
      h.sockets[1]!.hello();
      expect(old.closeCount).toBe(1);
      old.message({ type: "disconnect", reason });
      old.dispatchEvent(new Event("error"));
      expect(h.requests).toHaveLength(2);
      expect(h.timers.size).toBe(0);
      h.client.stop();
    },
  );

  test("failed replacement preserves active connection and retries; close/error coalesce", async () => {
    const h = harness();
    const old = await h.start();
    old.message({ type: "disconnect", reason: "warning" });
    await flush();
    h.sockets[1]!.dispatchEvent(new Event("error"));
    expect(old.closeCount).toBe(0);
    expect(h.client.health().connected).toBe(true);
    old.close();
    expect(h.timers.size).toBe(1);
    expect(await h.tick()).toBe(500);
    h.sockets[2]!.hello();
    expect(h.client.health().state).toBe("connected");
    h.client.stop();
  });

  test("backoff uses full jitter with exponential cap and resets after hello", async () => {
    let available = false;
    const h = harness({
      fetch: async () => {
        if (!available) throw new Error("offline");
        return ticket();
      },
      random: () => 0.25,
    });
    h.client.start();
    await flush();
    for (const delay of [250, 500, 1000, 2000, 4000, 7500, 7500])
      expect(await h.tick()).toBe(delay);
    available = true;
    await h.tick();
    h.sockets[0]!.hello();
    h.sockets[0]!.close();
    expect(await h.tick()).toBe(250);
    h.client.stop();
  });

  test("link_disabled closes active and candidate and is terminal until a new client", async () => {
    const h = harness();
    const old = await h.start();
    old.message({ type: "disconnect", reason: "warning" });
    await flush();
    old.message({ type: "disconnect", reason: "link_disabled" });
    expect(h.sockets.every((socket) => socket.closeCount === 1)).toBe(true);
    expect(h.client.health()).toEqual({
      state: "link_disabled",
      connected: false,
    });
    h.client.start();
    expect(h.requests).toHaveLength(2);
    expect(h.timers.size).toBe(0);
  });

  test("link_disabled from ticket API is also terminal", async () => {
    const h = harness({
      fetch: async () => Response.json({ ok: false, error: "link_disabled" }),
    });
    h.client.start();
    await flush();
    expect(h.client.health().state).toBe("link_disabled");
    expect(h.timers.size).toBe(0);
    expect(h.sockets).toHaveLength(0);
  });

  test("bounds ticket and hello waits and cancels stale requests across restart", async () => {
    const pending = deferred<Response>();
    const h = harness({ fetch: () => pending.promise });
    h.client.start();
    expect(await h.tick()).toBe(30_000);
    expect(h.requests[0]!.init.signal!.aborted).toBe(true);
    h.client.stop();
    h.client.start();
    pending.resolve(ticket());
    await flush();
    expect(h.sockets).toHaveLength(1);
    expect(await h.tick()).toBe(30_000);
    expect(h.sockets[0]!.closeCount).toBe(1);
    h.client.stop();
    expect(h.timers.size).toBe(0);
  });

  test.each([
    "http://wss-primary.slack.com/",
    "wss://example.test/",
    "wss://slack.com.example.test/",
    "wss://user@wss-primary.slack.com/",
    "wss://wss-primary.slack.com:444/",
  ])("rejects untrusted ticket %s without logging it", async (url) => {
    const h = harness({ fetch: async () => Response.json({ ok: true, url }) });
    h.client.start();
    await flush();
    expect(h.sockets).toHaveLength(0);
    expect(h.timers.size).toBe(1);
    expect(h.warnings.join()).not.toContain(url);
    h.client.stop();
  });
});

describe("durable inbox seam", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const inboxDeps = {
    handleDirectMessage: async () => {},
    handleMention: async () => {},
    isProcessed: () => false,
    markProcessed: () => {},
  };

  test("acked events survive inbox reconstruction; redelivery is deduplicated", async () => {
    dir = mkdtempSync(join(tmpdir(), "slack-socket-test-"));
    const path = join(dir, "inbox.json");
    const inbox = new SlackEventInbox(path, inboxDeps);
    const h = harness({
      dispatchEvent: async () => {
        inbox.enqueue("direct_message", event.payload.event);
      },
    });
    const socket = await h.start();
    socket.message(event);
    await flush();
    expect(socket.sent).toHaveLength(1);
    const recovered = new SlackEventInbox(path, inboxDeps);
    expect(recovered.pendingCount()).toBe(1);
    expect(recovered.enqueue("direct_message", event.payload.event)).toBe(
      "pending",
    );
    socket.message(event);
    await flush();
    expect(inbox.pendingCount()).toBe(1);
    expect(socket.sent).toHaveLength(2);
    h.client.stop();
  });

  test("failed persistence leaves the envelope unacked", async () => {
    dir = mkdtempSync(join(tmpdir(), "slack-socket-test-"));
    const file = join(dir, "not-a-directory");
    writeFileSync(file, "synthetic");
    const inbox = new SlackEventInbox(join(file, "inbox.json"), inboxDeps);
    const h = harness({
      dispatchEvent: async () => {
        inbox.enqueue("direct_message", event.payload.event);
      },
    });
    const socket = await h.start();
    socket.message(event);
    await flush();
    expect(socket.sent).toEqual([]);
    expect(inbox.pendingCount()).toBe(0);
    h.client.stop();
  });
});
