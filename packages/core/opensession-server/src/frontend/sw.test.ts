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

function cacheUrl(input: CacheInput): string {
  return input instanceof Object ? input.url : input;
}

function workerHarness(scopePath = "/", existingCacheNames: string[] = []) {
  const origin = "https://os.test";
  const scope = new URL(scopePath, origin).href;
  const listeners = new Map<string, WorkerListener>();
  const added: string[] = [];
  const deletedCacheNames: string[] = [];
  const navigated: string[] = [];
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
  const networkFetch = async () => {
    throw new TypeError("offline");
  };

  new Function("self", "caches", "fetch", workerSource)(
    serviceWorker,
    caches,
    networkFetch,
  );

  return { added, deletedCacheNames, listeners, navigated };
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
