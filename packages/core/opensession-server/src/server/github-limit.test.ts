import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GithubRateLimits, ghCredentialScope } from "./github-limit";

const a = { token: "fake-a-read", rateLimitKey: "installation:acme-app:101" };
const b = { token: "fake-b-read", rateLimitKey: "installation:acme-app:202" };
const originalFetch = globalThis.fetch;
let dir: string;
let path: string;
let limits: GithubRateLimits;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "os-github-limits-"));
  path = join(dir, "github-limit.json");
  limits = new GithubRateLimits(path);
  globalThis.fetch = (() => {
    throw new Error("Unexpected network call");
  }) as unknown as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(dir, { recursive: true, force: true });
});

describe("GitHub rate-limit identity", () => {
  test("separates installations and resources, not permission sets or rotated tokens", async () => {
    const reset = Date.now() + 60_000;
    await limits.note("test", reset, "graphql", a);
    expect(await limits.backoff("graphql", a)).toBe(reset + 30_000);
    expect(await limits.backoff("rest", a)).toBe(0);
    expect(await limits.backoff("graphql", b)).toBe(0);
    expect(
      await limits.backoff("graphql", { ...a, token: "fake-a-write-rotated" }),
    ).toBe(reset + 30_000);
    await limits.note("test", reset, "rest", b);
    expect(await limits.backoff("rest", b)).toBe(reset + 30_000);
    expect(await limits.backoff("rest", a)).toBe(0);
    expect(
      await limits.backoff("graphql", {
        ...a,
        rateLimitKey: "installation:other-app:101",
      }),
    ).toBe(0);
  });

  test("persists only identity and deadlines and restores independent buckets", async () => {
    const reset = Date.now() + 60_000;
    await Promise.all([
      limits.note("test", reset, "graphql", a),
      limits.note("test", reset + 20_000, "rest", b),
    ]);
    const saved = await readFile(path, "utf8");
    expect(saved).not.toContain(a.token);
    expect(saved).not.toContain(b.token);
    const restarted = new GithubRateLimits(path);
    expect(await restarted.backoff("graphql", a)).toBe(reset + 30_000);
    expect(await restarted.backoff("rest", b)).toBe(reset + 50_000);
    expect(await restarted.backoff("rest", a)).toBe(0);
    expect(await restarted.backoff("graphql", b)).toBe(0);
  });

  test("probes the rejected credential and resource, once per bucket", async () => {
    const resetA = Math.floor(Date.now() / 1000) + 60;
    const resetB = resetA + 60;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    let started!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe("https://api.github.com/rate_limit");
      const auth = new Headers(init?.headers).get("Authorization")!;
      calls.push(auth);
      if (calls.length === 2) started();
      await pending;
      return Response.json({
        resources: {
          graphql: { reset: resetA },
          core: { reset: resetB },
        },
      });
    }) as unknown as typeof fetch;
    const first = limits.note("test", undefined, "graphql", a);
    const second = limits.note("test", undefined, "rest", b);
    await bothStarted;
    await limits.note("duplicate", undefined, "graphql", a);
    expect(await limits.backoff("graphql", a)).toBeGreaterThan(Date.now());
    expect(await limits.backoff("rest", a)).toBe(0);
    release();
    await Promise.all([first, second]);
    expect(calls.sort()).toEqual(["Bearer fake-a-read", "Bearer fake-b-read"]);
    expect(await limits.backoff("graphql", a)).toBe(resetA * 1000 + 30_000);
    expect(await limits.backoff("rest", b)).toBe(resetB * 1000 + 30_000);
  });

  test("a late probe cannot shorten a newer header deadline", async () => {
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    globalThis.fetch = (async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Response.json({
        resources: { core: { reset: Math.floor(Date.now() / 1000) + 60 } },
      });
    }) as unknown as typeof fetch;
    const probe = limits.note("test", undefined, "rest", a);
    await began;
    const reset = Date.now() + 3600_000;
    await limits.note("header", reset, "rest", a);
    release();
    await probe;
    expect(await limits.backoff("rest", a)).toBe(reset + 30_000);
  });

  test("probe failure keeps a bounded fallback only for the rejected bucket", async () => {
    const start = Date.now();
    await limits.note("test", undefined, "rest", a);
    expect(await limits.backoff("rest", a)).toBeGreaterThanOrEqual(
      start + 15 * 60_000,
    );
    expect(await limits.backoff("rest", b)).toBe(0);
    expect(await limits.backoff("graphql", a)).toBe(0);
    await limits.note("test", Date.now() + 24 * 3600_000, "rest", b);
    expect(await limits.backoff("rest", b)).toBeLessThanOrEqual(
      Date.now() + 2 * 3600_000,
    );
  });

  test("ignores expired, malformed and unattributable legacy state", async () => {
    for (const saved of [
      "not json",
      JSON.stringify({ resources: { rest: Date.now() + 60_000 } }),
      JSON.stringify({ backoffUntil: Date.now() + 60_000 }),
      JSON.stringify({
        version: 3,
        installations: {
          [a.rateLimitKey]: { graphql: Date.now() - 1, rest: "bad" },
        },
      }),
    ]) {
      await writeFile(path, saved);
      const restarted = new GithubRateLimits(path);
      expect(await restarted.backoff("graphql", a)).toBe(0);
      expect(await restarted.backoff("rest", a)).toBe(0);
      expect(await restarted.backoff("rest", b)).toBe(0);
    }
  });

  test("connected user and opaque credentials do not poison an installation", async () => {
    const user = ghCredentialScope({
      kind: "user",
      principal: "user:alice",
      env: { GH_TOKEN: "fake-user" },
    });
    await limits.note("test", Date.now() + 60_000, "graphql", user);
    expect(await limits.backoff("graphql", user)).toBeGreaterThan(Date.now());
    expect(await limits.backoff("graphql", a)).toBe(0);
    const opaque = ghCredentialScope({
      kind: "service",
      principal: "service",
      env: { GH_TOKEN: "fake-opaque" },
    });
    expect(opaque.rateLimitKey).not.toContain("fake-opaque");
    expect(await limits.backoff("graphql", opaque)).toBe(0);
  });
});
