import { afterEach, expect, test } from "bun:test";
import { installClientDataTransport } from "./client-data-transport";
import { publishClientDataIdentity } from "./client-data-scope";
const originalFetch = globalThis.fetch;
const originalLocation = Object.getOwnPropertyDescriptor(
  globalThis,
  "location",
);
Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { href: "https://os.example/", origin: "https://os.example" },
});
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  globalThis.fetch = originalFetch;
  publishClientDataIdentity(null);
});
const identify = (id: number) =>
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: id,
  });
test("only scoped same-origin API calls advertise privacy; auth status learns identity while unresolved", async () => {
  publishClientDataIdentity(null);
  const calls: RequestInit[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return Response.json({ ok: true });
    },
    { preconnect: originalFetch.preconnect },
  );
  restore = installClientDataTransport();
  await fetch("/api/auth/status");
  expect(new Headers(calls[0]?.headers).has("X-OpenSession-Privacy")).toBe(
    false,
  );
  await expect(fetch("/api/repos")).rejects.toThrow("account changed");
  identify(11);
  await fetch("/api/repos");
  const headers = new Headers(calls[1]?.headers);
  expect(headers.get("X-OpenSession-Privacy")).toBe("personal-v1");
  expect(headers.get("X-OpenSession-Expected-GitHub-Account-Id")).toBe("11");
  await fetch("https://external.example/api/repos");
  expect(new Headers(calls[2]?.headers).has("X-OpenSession-Privacy")).toBe(
    false,
  );
});
test("a captured A expected-ID header is never replaced with B", async () => {
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
  restore = installClientDataTransport();
  identify(22);
  await expect(
    fetch("/api/repos", {
      headers: { "X-OpenSession-Expected-GitHub-Account-Id": "11" },
    }),
  ).rejects.toThrow("another GitHub account");
  expect(calls).toBe(0);
});
test("A response cannot be parsed after logout or B, including cloned responses", async () => {
  globalThis.fetch = Object.assign(async () => Response.json({ secret: "A" }), {
    preconnect: originalFetch.preconnect,
  });
  restore = installClientDataTransport();
  identify(11);
  const response = await fetch("/api/repos");
  const clone = response.clone();
  identify(22);
  await expect(response.json()).rejects.toThrow("account changed");
  await expect(clone.text()).rejects.toThrow("account changed");
});
import { afterAll } from "bun:test";
afterAll(() => {
  if (originalLocation)
    Object.defineProperty(globalThis, "location", originalLocation);
  else Reflect.deleteProperty(globalThis, "location");
});
