import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workerSource = readFileSync(new URL("./sw.js", import.meta.url), "utf8");

type WorkerEvent = {
  waitUntil?: (task: Promise<unknown>) => void;
  request?: { method: string; mode: string; url: string };
  respondWith?: (response: Promise<Response>) => void;
};

type WorkerListener = (event: WorkerEvent) => void;
type CacheInput = string | { url: string };
/** What the worker posts to a window client (sw.js notifyShellUpdated). */
type WorkerMessage = { type: string };

function cacheUrl(input: CacheInput): string {
  return input instanceof Object ? input.url : input;
}

type NetworkFetch = (
  input: string | { url: string },
  init?: RequestInit,
) => Promise<Response>;

const offline: NetworkFetch = async () => {
  throw new TypeError("offline");
};

function workerHarness(
  scopePath = "/",
  existingCacheNames: string[] = [],
  networkFetch: NetworkFetch = offline,
) {
  const origin = "https://os.test";
  const scope = new URL(scopePath, origin).href;
  const listeners = new Map<string, WorkerListener>();
  const added: string[] = [];
  const deletedCacheNames: string[] = [];
  const navigated: string[] = [];
  const posted: WorkerMessage[] = [];
  const entries = new Map<string, Response>();
  const cache = {
    async add(input: string) {
      added.push(input);
      entries.set(new URL(input, scope).href, new Response(`cached:${input}`));
    },
    async match(input: CacheInput) {
      return entries.get(new URL(cacheUrl(input), scope).href)?.clone();
    },
    async put(input: CacheInput, response: Response) {
      entries.set(new URL(cacheUrl(input), scope).href, response.clone());
    },
    async keys() {
      return [...entries.keys()].map((url) => ({ url }));
    },
    async delete(input: CacheInput) {
      return entries.delete(new URL(cacheUrl(input), scope).href);
    },
  };
  const caches = {
    async open() {
      return cache;
    },
    async keys() {
      return existingCacheNames;
    },
    async delete(name: string) {
      deletedCacheNames.push(name);
      return true;
    },
  };
  const serviceWorker = {
    registration: {
      scope,
      async getNotifications() {
        return [];
      },
      async showNotification() {},
    },
    location: { origin },
    navigator: {},
    clients: {
      async claim() {},
      async matchAll() {
        return [
          {
            url: scope,
            async navigate(url: string) {
              navigated.push(url);
            },
            postMessage(message: WorkerMessage) {
              posted.push(message);
            },
          },
        ];
      },
      async openWindow() {},
    },
    skipWaiting() {},
    addEventListener(type: string, listener: WorkerListener) {
      listeners.set(type, listener);
    },
  };

  new Function("self", "caches", "fetch", workerSource)(
    serviceWorker,
    caches,
    networkFetch,
  );

  return { added, deletedCacheNames, listeners, navigated, posted, cache };
}

function shellHtml(entry: string): Response {
  return new Response(
    `<html><head></head><body><script type="module" crossorigin src="/${entry}"></script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

async function navigateShell(harness: ReturnType<typeof workerHarness>) {
  let response: Promise<Response> | undefined;
  const tasks: Promise<unknown>[] = [];
  harness.listeners.get("fetch")?.({
    request: { method: "GET", mode: "navigate", url: "https://os.test/" },
    respondWith(value: Promise<Response>) {
      response = value;
    },
    waitUntil(task: Promise<unknown>) {
      tasks.push(task);
    },
  });
  const html = await (await response!).text();
  return { html, settled: Promise.all(tasks) };
}

async function runWorkerLifecycleEvent(
  harness: ReturnType<typeof workerHarness>,
  type: "install" | "activate",
) {
  const tasks: Promise<unknown>[] = [];
  harness.listeners.get(type)?.({
    waitUntil(task: Promise<unknown>) {
      tasks.push(task);
    },
  });
  await Promise.all(tasks);
}

async function installWorker(harness: ReturnType<typeof workerHarness>) {
  await runWorkerLifecycleEvent(harness, "install");
}

describe("service worker navigation freshness", () => {
  test("bypasses WebKit's HTTP cache before falling back to its own shell", () => {
    expect(workerSource).toContain('fetch(req, { cache: "no-store" })');
  });

  test("retires the shell cached before navigations bypassed WebKit", async () => {
    const harness = workerHarness("/", [
      "os1-shell-html-v1",
      "os1-shell-html-v2",
      "os1-shell-assets-v1",
      "os1-shell-gate-v1",
      "os1-shell-gate-v2",
    ]);

    await runWorkerLifecycleEvent(harness, "activate");

    expect(harness.deletedCacheNames).toEqual([
      "os1-shell-html-v1",
      "os1-shell-gate-v1",
    ]);
    expect(harness.navigated).toEqual(["https://os.test/"]);
  });

  test("does not reload clients after an ordinary worker update", async () => {
    const harness = workerHarness("/", [
      "os1-shell-html-v2",
      "os1-shell-assets-v1",
      "os1-shell-gate-v2",
    ]);

    await runWorkerLifecycleEvent(harness, "activate");

    expect(harness.deletedCacheNames).toEqual([]);
    expect(harness.navigated).toEqual([]);
  });

  test("serves the network shell when it answers, without a nudge", async () => {
    const harness = workerHarness("/", [], async () => shellHtml("App-new.js"));
    await harness.cache.put("/__app-shell__", shellHtml("App-old.js"));

    const { html, settled } = await navigateShell(harness);
    await settled;

    expect(html).toContain("App-new.js");
    expect(harness.posted).toEqual([]);
  });

  test("paints the cached shell once the network stalls and nudges when the late answer is a newer build", async () => {
    let answer: (response: Response) => void = () => {};
    const harness = workerHarness(
      "/",
      [],
      () => new Promise<Response>((resolve) => (answer = resolve)),
    );
    await harness.cache.put("/__app-shell__", shellHtml("App-old.js"));

    const { html, settled } = await navigateShell(harness);
    expect(html).toContain("App-old.js");
    expect(harness.posted).toEqual([]);

    answer(shellHtml("App-new.js"));
    await settled;

    expect(harness.posted).toEqual([{ type: "os1-shell-updated" }]);
    const cached = await harness.cache.match("/__app-shell__");
    expect(await cached!.text()).toContain("App-new.js");
  });

  test("stays quiet when the late answer is the same build", async () => {
    let answer: (response: Response) => void = () => {};
    const harness = workerHarness(
      "/",
      [],
      () => new Promise<Response>((resolve) => (answer = resolve)),
    );
    await harness.cache.put("/__app-shell__", shellHtml("App-same.js"));

    const { html, settled } = await navigateShell(harness);
    expect(html).toContain("App-same.js");

    answer(shellHtml("App-same.js"));
    await settled;

    expect(harness.posted).toEqual([]);
  });

  test("falls back to the cached shell when the network fails outright", async () => {
    const harness = workerHarness();
    await harness.cache.put("/__app-shell__", shellHtml("App-old.js"));

    const { html, settled } = await navigateShell(harness);
    await settled;

    expect(html).toContain("App-old.js");
    expect(harness.posted).toEqual([]);
  });
});

describe("service worker gate assets", () => {
  test("precaches the icon and still backgrounds during installation", async () => {
    const harness = workerHarness();
    await installWorker(harness);

    expect(harness.added).toEqual([
      "/mac-app-icon.png",
      "/onboarding-bg.webp",
      "/onboarding-bg-dark.webp",
    ]);
  });

  test("serves the sign-in icon from cache while offline", async () => {
    const harness = workerHarness();
    await installWorker(harness);

    let response: Promise<Response> | undefined;
    const tasks: Promise<unknown>[] = [];
    harness.listeners.get("fetch")?.({
      request: {
        method: "GET",
        mode: "cors",
        url: "https://os.test/mac-app-icon.png",
      },
      respondWith(value: Promise<Response>) {
        response = value;
      },
      waitUntil(task: Promise<unknown>) {
        tasks.push(task);
      },
    });

    expect(response).toBeDefined();
    expect(await (await response!).text()).toBe("cached:/mac-app-icon.png");
    await Promise.all(tasks);
  });
});
