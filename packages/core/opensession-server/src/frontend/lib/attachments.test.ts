import { publishClientDataIdentity } from "./client-data-scope";
import { expect, test, beforeEach, afterEach } from "bun:test";

// The store reads the signed-in user and mirrors to sessionStorage on the way
// through. Neither is what these tests are about, so give them the smallest
// thing that behaves.
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) =>
      void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

// These browser-facing stores need a small DOM/storage surface in Bun.
if (!("window" in globalThis)) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
}
const win = globalThis.window;
const events = new EventTarget();
if (!win.addEventListener) {
  Object.defineProperty(win, "addEventListener", {
    value: events.addEventListener.bind(events),
  });
}
if (!win.removeEventListener) {
  Object.defineProperty(win, "removeEventListener", {
    value: events.removeEventListener.bind(events),
  });
}
if (!win.dispatchEvent) {
  Object.defineProperty(win, "dispatchEvent", {
    value: events.dispatchEvent.bind(events),
  });
}
if (!win.setInterval) {
  Object.defineProperty(win, "setInterval", { value: () => 0 });
}
if (!("document" in globalThis)) {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { visibilityState: "hidden" },
  });
}
if (!("localStorage" in globalThis)) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
}
if (!("sessionStorage" in globalThis)) {
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: memoryStorage(),
  });
}
const sessionStorage = globalThis.sessionStorage;

const {
  attachToDraft,
  dropStagingAttachments,
  removeDraftImage,
  addDraftPastedText,
  removeDraftPastedText,
  attachingLabel,
  countStaging,
} = await import("./attachments");
const { bindDraftKey, loadDraft, saveDraft, clearDraft, onDraftsChanged } =
  await import("./drafts");

let KEY: string;
const realFetch = globalThis.fetch;

/** Stand in for POST /api/upload, held open until `release` is called, so a
 *  test can do things while a paste is still on its way to disk. */
function stagingServer() {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchStub = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    if (url.includes("/api/upload")) {
      await held;
      const name = decodeURIComponent(
        new Headers(init?.headers).get("x-file-name") ?? "file",
      );
      return new Response(
        JSON.stringify({ ok: true, name, path: `/uploads/staged/${name}` }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", {
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = Object.assign(fetchStub, {
    preconnect: realFetch.preconnect,
  });
  return { release };
}

const png = (name: string) =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, {
    type: "image/png",
  });

beforeEach(() => {
  globalThis.fetch = Object.assign(async () => Response.json({}), {
    preconnect: realFetch.preconnect,
  });
  localStorage.setItem("opensession-user", "Same name");
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: 11,
  });
  KEY = bindDraftKey("test-attachments");
  clearDraft(KEY);
});
afterEach(() => {
  publishClientDataIdentity(null);
  globalThis.fetch = realFetch;
  clearDraft(KEY);
});

// The bug this module exists for: the upload outlives the composer, so a
// screenshot pasted while the app is still loading used to die with the card
// that closed before it landed, with the file already staged on the server.
test("a staged image reaches the draft even when nothing is listening", async () => {
  const server = stagingServer();
  const attaching = attachToDraft(KEY, [png("screenshot.png")]);

  expect(loadDraft(KEY).images).toEqual([]);
  server.release();
  await attaching;

  expect(loadDraft(KEY).images).toEqual([
    `/media?path=${encodeURIComponent("/uploads/staged/screenshot.png")}`,
  ]);
});

test("staging merges with what the draft holds now, not what it held at paste", async () => {
  const server = stagingServer();
  const first = attachToDraft(KEY, [png("one.png")]);
  const second = attachToDraft(KEY, [png("two.png")]);
  saveDraft(KEY, { text: "typed while both were uploading" });
  server.release();
  await Promise.all([first, second]);

  // Neither paste wins: both are there, and the text they were typed beside
  // survived them landing.
  expect(loadDraft(KEY).images).toHaveLength(2);
  expect(loadDraft(KEY).text).toBe("typed while both were uploading");
});

// The other half of the trade: a completion must not write itself back into a
// draft whose prompt has already been sent.
test("an upload that lands after the draft was used is dropped", async () => {
  const server = stagingServer();
  const attaching = attachToDraft(KEY, [png("late.png")]);

  dropStagingAttachments(KEY);
  clearDraft(KEY);
  server.release();

  expect((await attaching).applied).toBe(false);
  expect(loadDraft(KEY).images).toEqual([]);
});

test("canceling an upload prevents the image from reappearing", async () => {
  const server = stagingServer();
  const controller = new AbortController();
  const attaching = attachToDraft(KEY, [png("removed.png")], controller.signal);

  controller.abort();
  server.release();

  expect((await attaching).applied).toBe(false);
  expect(loadDraft(KEY).images).toEqual([]);
});

test("removing an image goes through the store", async () => {
  const server = stagingServer();
  server.release();
  await attachToDraft(KEY, [png("a.png"), png("b.png")]);

  removeDraftImage(KEY, 0);

  expect(loadDraft(KEY).images).toEqual([
    `/media?path=${encodeURIComponent("/uploads/staged/b.png")}`,
  ]);
});

// The palette's paste handler is built during a render. Two pastes served by
// the same handler must still land as two chips, so each append reads the
// store rather than the list the handler was built with.
test("pastes accumulate in the store, however stale the caller", () => {
  addDraftPastedText(KEY, "first");
  addDraftPastedText(KEY, "second");
  addDraftPastedText(KEY, "third");

  const stored = loadDraft(KEY).pastedTexts;
  expect(stored.map((item) => item.text)).toEqual(["first", "second", "third"]);
  expect(new Set(stored.map((item) => item.id)).size).toBe(3);

  removeDraftPastedText(KEY, stored[1]!.id);
  expect(loadDraft(KEY).pastedTexts.map((item) => item.text)).toEqual([
    "first",
    "third",
  ]);
});

// A second composer mirroring the same key learns about every paste, not just
// the first: the store announces a pasted-text change the way it does an image
// or a file, not only the edge from empty to non-empty.
test("every pasted-text change is announced", () => {
  const keys: (string | undefined)[] = [];
  const stop = onDraftsChanged((key) => keys.push(key));
  try {
    saveDraft(KEY, { text: "hello" });
    keys.length = 0;
    addDraftPastedText(KEY, "first");
    addDraftPastedText(KEY, "second");
    removeDraftPastedText(KEY, loadDraft(KEY).pastedTexts[0]!.id);
  } finally {
    stop();
  }
  expect(keys).toEqual([
    "test-attachments",
    "test-attachments",
    "test-attachments",
  ]);
});

// A staged attachment is a ~90-character ref, but an image the server refused
// falls back to inline base64 (lib/images.ts) and a few of those pass the
// mirror's size cap. Losing them to a reload is the trade; losing the writing
// they were attached to is not.
test("an inline image too big for the mirror does not take the text with it", async () => {
  saveDraft(KEY, {
    text: "keep me",
    images: [`data:image/png;base64,${"A".repeat(3_100_000)}`],
  });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const mirrored = JSON.parse(
    sessionStorage.getItem(
      "backstage-draft:v2:github-account%3A11:test-attachments",
    )!,
  );
  expect(mirrored.text).toBe("keep me");
  expect(mirrored.images).toEqual([]);
});

test("the pending row names what it is waiting for", () => {
  expect(attachingLabel({ images: 0, files: 0 })).toBeNull();
  expect(attachingLabel({ images: 1, files: 0 })).toBe("Attaching 1 image…");
  expect(attachingLabel({ images: 2, files: 0 })).toBe("Attaching 2 images…");
  // Anything that is not a picture is counted as a file, images included, so
  // a mixed pick does not claim to be attaching two pictures.
  expect(attachingLabel({ images: 1, files: 1 })).toBe("Attaching 2 files…");
});

test("what is staging is counted by kind", () => {
  expect(
    countStaging([
      png("a.png"),
      new File(["x"], "notes.txt", { type: "text/plain" }),
    ]),
  ).toEqual({ images: 1, files: 1 });
});

// The server refuses a message with more than the cap, and a refused message
// used to sit in the outbox retrying with nothing to press. Stop at the cap
// while attaching and say what was left out.
test("a seventh image is left out of the draft and named", async () => {
  const server = stagingServer();
  server.release();
  saveDraft(KEY, {
    images: Array.from({ length: 5 }, (_, i) => `/media?path=${i}`),
  });

  const result = await attachToDraft(KEY, [png("six.png"), png("seven.png")]);

  expect(loadDraft(KEY).images).toHaveLength(6);
  expect(loadDraft(KEY).images[5]).toBe(
    `/media?path=${encodeURIComponent("/uploads/staged/six.png")}`,
  );
  expect(result.rejected).toEqual(["1 image (a message holds up to 6)"]);
});

test("all composer surfaces fence same-name A/B, late saves and logout/relogin", () => {
  const names = [
    "session:scope-test",
    "new-session",
    "workspace-home:scope-test",
    "plain-reply:scope-test",
    "support-preview:scope-test",
  ];
  sessionStorage.setItem(
    "backstage-draft:new-session",
    JSON.stringify({ text: "ambiguous legacy A" }),
  );
  const keys = names.map((name) => bindDraftKey(name));
  for (const key of keys)
    saveDraft(key, {
      text: "A private draft",
      images: ["/media?path=A"],
      files: [{ name: "A", type: "text/plain", path: "/A" }],
      pastedTexts: [{ id: "A", text: "A paste" }],
    });
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: 12,
  });
  for (let i = 0; i < names.length; i++) {
    expect(loadDraft(names[i]).text).toBe("");
    saveDraft(keys[i], {
      text: "late A cleanup",
      images: ["A late attachment"],
    });
    expect(loadDraft(names[i]).images).toEqual([]);
  }
  expect(sessionStorage.getItem("backstage-draft:new-session")).toContain(
    "ambiguous legacy A",
  );
  const b = bindDraftKey("new-session");
  saveDraft(b, { text: "B draft" });
  publishClientDataIdentity(null);
  expect(loadDraft("new-session").text).toBe("");
  saveDraft(b, { text: "late B" });
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: 11,
  });
  for (const name of names) {
    expect(loadDraft(name)).toMatchObject({
      text: "A private draft",
      images: ["/media?path=A"],
    });
    clearDraft(bindDraftKey(name));
  }
  saveDraft(keys[1], { text: "old A lifetime" });
  expect(loadDraft("new-session").text).toBe("");
});

test("an upload completion cannot enter B's same-name composer", async () => {
  const server = stagingServer();
  const a = bindDraftKey("new-session");
  const pending = attachToDraft(a, [png("A-private.png")]);
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: 12,
  });
  server.release();
  const result = await pending.then(
    (value) => value,
    () => ({ applied: false }),
  );
  expect(result.applied).toBe(false);
  expect(loadDraft("new-session").images).toEqual([]);
});

test("unknown and authenticated legacy scopes cannot adopt old drafts or sync uploads", async () => {
  publishClientDataIdentity(null);
  expect(loadDraft("new-session").text).toBe("");
  const unresolved = bindDraftKey("new-session");
  saveDraft(unresolved, { text: "unknown" });
  publishClientDataIdentity({ required: true, authenticated: true });
  const legacy = bindDraftKey("new-session");
  saveDraft(legacy, { text: "quarantined legacy writing" });
  expect((await attachToDraft(legacy, [png("legacy.png")])).applied).toBe(
    false,
  );
  publishClientDataIdentity(null);
  publishClientDataIdentity({ required: true, authenticated: true });
  expect(loadDraft("new-session").text).toBe("");
  const stored = Array.from({ length: sessionStorage.length }, (_, index) =>
    sessionStorage.getItem(sessionStorage.key(index)!),
  ).join("\n");
  expect(stored).toContain("quarantined legacy writing");
});

test("late draft hydration and deferred save never enter same-name B scope", async () => {
  publishClientDataIdentity(null);
  const pending: Array<{
    headers: Headers;
    resolve: (response: Response) => void;
  }> = [];
  const puts: RequestInit[] = [];
  globalThis.fetch = Object.assign(
    (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts.push(init);
        return Promise.resolve(Response.json({ applied: true }));
      }
      return new Promise<Response>((resolve) =>
        pending.push({ headers: new Headers(init?.headers), resolve }),
      );
    },
    { preconnect: realFetch.preconnect },
  );
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: 71,
  });
  const a = bindDraftKey("session:hydration-scope");
  saveDraft(a, { text: "A pending keystrokes" });
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: 72,
  });
  expect(
    pending.map((request) =>
      request.headers.get("X-OpenSession-Expected-GitHub-Account-Id"),
    ),
  ).toEqual(["71", "72"]);
  let stop = () => {};
  const hydrated = new Promise<void>((resolve) => {
    stop = onDraftsChanged((key) => {
      if (
        key === "session:hydration-scope" &&
        loadDraft(key).text === "B server"
      )
        resolve();
    });
  });
  pending[0].resolve(
    Response.json({
      drafts: {
        "hydration-scope": { text: "late A server", updatedAt: "2026-01-01" },
      },
    }),
  );
  pending[1].resolve(
    Response.json({
      drafts: {
        "hydration-scope": { text: "B server", updatedAt: "2026-01-01" },
      },
    }),
  );
  await hydrated;
  stop();
  expect(loadDraft("session:hydration-scope").text).toBe("B server");
  expect(puts).toEqual([]);
  expect(loadDraft(a).text).toBe("");
});

test("late refused save cannot restore A text under same-name B", async () => {
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: 81,
  });
  const a = bindDraftKey("session:late-save");
  saveDraft(a, { text: "A writing" });
  let release!: (response: Response) => void;
  let put: RequestInit | undefined;
  globalThis.fetch = Object.assign(
    (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PUT")
        return Promise.resolve(Response.json({ drafts: {} }));
      put = init;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    },
    { preconnect: realFetch.preconnect },
  );
  clearDraft(a);
  expect(
    new Headers(put?.headers).get("X-OpenSession-Expected-GitHub-Account-Id"),
  ).toBe("81");
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: 82,
  });
  release(
    Response.json({
      applied: false,
      draft: { text: "A server text", updatedAt: "2026-01-01" },
    }),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(loadDraft("session:late-save").text).toBe("");
});
