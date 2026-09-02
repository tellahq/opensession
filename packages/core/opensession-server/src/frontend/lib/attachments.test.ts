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
  attachingLabel,
  countStaging,
} = await import("./attachments");
const { loadDraft, saveDraft, clearDraft } = await import("./drafts");

const KEY = "test-attachments";
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

beforeEach(() => clearDraft(KEY));
afterEach(() => {
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
    sessionStorage.getItem(`backstage-draft:${KEY}`)!,
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
