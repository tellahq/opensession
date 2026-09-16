import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import {
  captureClientDataScope,
  publishClientDataIdentity,
} from "./client-data-scope";
import { promptOutbox } from "./prompt-outbox";
import { deliverSessionPrompt } from "./api/sessions";
import { WsCommandOutbox, wsCommandOutboxForScope } from "./ws-command-outbox";

class MemoryStorage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
}
const originalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
const originalFetch = globalThis.fetch;
let store: MemoryStorage;
let requests: RequestInit[];
const identify = (id: number) =>
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: id,
  });
beforeEach(() => {
  publishClientDataIdentity(null);
  store = new MemoryStorage();
  requests = [];
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: store,
  });
  globalThis.fetch = Object.assign(
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return Response.json({ status: "started", message: "ok" });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  publishClientDataIdentity(null);
  globalThis.fetch = originalFetch;
  if (originalStorage)
    Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("lazy REST sender preserves old origin data and never restores it before auth or as B", async () => {
  store.setItem("opensession-prompt-outbox:v1:server", "legacy A text/files");
  await promptOutbox.flush();
  expect(promptOutbox.list()).toEqual([]);
  identify(12);
  await promptOutbox.flush();
  expect(requests).toHaveLength(0);
  expect(store.getItem("opensession-prompt-outbox:v1:server")).toBe(
    "legacy A text/files",
  );
});

test("REST enqueue lifetime survives preparation await without recapturing B or publishing A results", async () => {
  identify(11);
  const a = captureClientDataScope();
  let observations = 0;
  const stop = promptOutbox.observeDelivery(() => {
    observations++;
  }, a);
  const item = promptOutbox.enqueue(
    {
      sessionId: "shared-destination",
      content: "A writing",
      files: [{ name: "A", path: "/A" }],
    },
    a,
  );
  identify(12);
  await Promise.resolve();
  await promptOutbox.flush();
  expect(requests).toHaveLength(0);
  expect(observations).toBe(0);
  expect(promptOutbox.list()).toEqual([]);
  expect([...store.values.values()].join("\n")).toContain(item.clientId);
  expect(() =>
    promptOutbox.enqueue(
      { sessionId: "shared-destination", content: "late A" },
      a,
    ),
  ).toThrow();
  // The same verified person can deliberately restore their durable queue in a
  // new lifetime. Old callbacks still cannot observe that lifetime's results.
  identify(11);
  await promptOutbox.flush();
  expect(requests).toHaveLength(1);
  expect(
    new Headers(requests[0].headers).get(
      "X-OpenSession-Expected-GitHub-Account-Id",
    ),
  ).toBe("11");
  expect(String(requests[0].body)).toContain("A writing");
  expect(observations).toBe(0);
  stop();
});

test("delivery wrapper checks captured scope on both sides of image preparation", async () => {
  identify(11);
  const a = captureClientDataScope();
  const pending = deliverSessionPrompt(
    "shared",
    { content: "A", clientId: "A" },
    a,
  );
  identify(12);
  expect(
    await pending.then(
      () => false,
      () => true,
    ),
  ).toBe(true);
  expect(requests).toHaveLength(0);
});

test("legacy authenticated identity cannot auto-send; explicit local-only scope still works", async () => {
  publishClientDataIdentity({ required: true, authenticated: true });
  expect(() =>
    promptOutbox.enqueue({ sessionId: "shared", content: "ambiguous" }),
  ).toThrow();
  await promptOutbox.flush();
  expect(requests).toHaveLength(0);
  publishClientDataIdentity({ required: false, authenticated: false });
  promptOutbox.enqueue({ sessionId: "shared", content: "local-only" });
  await Promise.resolve();
  await Promise.resolve();
  expect(requests).toHaveLength(1);
  expect(new Headers(requests[0].headers).has("X-OpenSession-Privacy")).toBe(
    false,
  );
});

test("old numeric login 41 commands are not adopted by verified numeric owner 41", () => {
  store.setItem("opensession-user", "41");
  const old = new WsCommandOutbox(
    store,
    Date.now,
    "opensession-ws-command-outbox:v1:github:41",
  );
  old.put({
    type: "create_session",
    user: "41",
    branch: "main",
    prompt: "legacy other person's writing",
    requestId: "old",
  });
  identify(41);
  const current = wsCommandOutboxForScope("github-account:41");
  expect(current.pending()).toEqual([]);
  expect(old.pending()).toHaveLength(1);
  expect(
    wsCommandOutboxForScope("github:41").put({
      type: "cancel",
      requestId: "denied",
    }),
  ).toBe(false);
  expect(current.put({ type: "cancel", requestId: "owned" })).toBe(true);
  identify(42);
  expect(current.pending()).toEqual([]);
  expect(current.ack("owned", "shared")).toBe(false);
  expect(wsCommandOutboxForScope("github-account:42").pending()).toEqual([]);
  identify(41);
  expect(
    wsCommandOutboxForScope("github-account:41")
      .pending()
      .map((item) => item.requestId),
  ).toEqual(["owned"]);
});

test("logout cancels scheduled retry and online cannot flush A under B", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: events,
  });
  const clear = spyOn(globalThis, "clearTimeout");
  let stop = () => {};
  try {
    identify(11);
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(init ?? {});
        return Response.json({ error: "offline" }, { status: 503 });
      },
      { preconnect: originalFetch.preconnect },
    );
    const retried = new Promise<void>((resolve) => {
      stop = promptOutbox.subscribe(() => {
        if (promptOutbox.list()[0]?.attempts === 1) resolve();
      });
    });
    promptOutbox.enqueue({ sessionId: "shared", content: "A retry" });
    await retried;
    await promptOutbox.flush();
    const before = clear.mock.calls.length;
    publishClientDataIdentity(null);
    expect(clear.mock.calls.length).toBeGreaterThan(before);
    events.dispatchEvent(new Event("online"));
    await promptOutbox.flush();
    identify(12);
    await promptOutbox.flush();
    events.dispatchEvent(new Event("online"));
    expect(requests).toHaveLength(1);
    expect([...store.values.values()].join("\n")).toContain("A retry");
  } finally {
    stop();
    publishClientDataIdentity(null);
    clear.mockRestore();
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("deferred shared-workspace draft mutation carries A scope rather than recapturing B", async () => {
  const { updateWorkspaceApi } = await import("./api/workspaces");
  identify(11);
  const a = captureClientDataScope();
  let release!: () => void;
  const priorWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = priorWrite.then(() =>
    updateWorkspaceApi(
      "shared-workspace",
      { draft: { text: "A autosave", updatedAt: "2026-01-01" } },
      a,
    ),
  );
  identify(12);
  release();
  expect(
    await write.then(
      () => false,
      () => true,
    ),
  ).toBe(true);
  expect(requests).toHaveLength(0);
});

test("unchanged verified revalidation retains the outbox lifetime", async () => {
  identify(11);
  const scope = captureClientDataScope();
  const item = promptOutbox.enqueue(
    { sessionId: "shared", content: "same lifetime" },
    scope,
  );
  identify(11);
  expect(captureClientDataScope()).toBe(scope);
  expect(promptOutbox.list()[0]?.clientId).toBe(item.clientId);
  await Promise.resolve();
  await promptOutbox.flush();
  expect(
    new Headers(requests[0]?.headers).get(
      "X-OpenSession-Expected-GitHub-Account-Id",
    ),
  ).toBe("11");
});

test("verified auth resumes its own durable queue without mounting a session pane", async () => {
  store.setItem(
    "opensession-prompt-outbox:v1:server:principal-v2:github-account%3A11",
    JSON.stringify({
      version: 1,
      items: [
        {
          clientId: "resume-A",
          sessionId: "shared",
          content: "A recovery",
          state: "pending",
          attempts: 0,
          createdAt: 1,
          nextAttemptAt: 0,
        },
      ],
    }),
  );
  let sent!: () => void;
  const requested = new Promise<void>((resolve) => {
    sent = resolve;
  });
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      sent();
      return Response.json({ status: "started", message: "ok" });
    },
    { preconnect: originalFetch.preconnect },
  );
  identify(11);
  await requested;
  expect(requests).toHaveLength(1);
  expect(
    new Headers(requests[0].headers).get(
      "X-OpenSession-Expected-GitHub-Account-Id",
    ),
  ).toBe("11");
});
