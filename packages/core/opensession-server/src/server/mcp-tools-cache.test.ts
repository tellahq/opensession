import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Pin the state dir BEFORE importing the module under test, and re-pin in
// beforeEach: another test file's afterAll restoring/deleting this env var
// mid-suite would otherwise redirect these writes at the live store.
const DIR = mkdtempSync(join(tmpdir(), "mcp-tools-cache-"));
const PREV = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = DIR;

const {
  DEFAULT_TTL_MS,
  forgetCachedTools,
  readCachedTools,
  toolsCacheKey,
  writeCachedTools,
} = await import("./mcp-tools-cache");

const TOOLS = [
  {
    name: "search",
    description: "Search things",
    inputSchema: { type: "object" },
  },
  { name: "fetch", description: "Fetch a thing" },
];

beforeEach(() => {
  process.env.OPENSESSION_STATE_DIR = DIR;
  delete process.env.OPENSESSION_MCP_TOOLS_CACHE;
  forgetCachedTools();
});

afterAll(() => {
  if (PREV === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = PREV;
  rmSync(DIR, { recursive: true, force: true });
});

describe("toolsCacheKey", () => {
  test("ignores key order so a reformatted config is still a hit", () => {
    const a = { command: "npx", args: ["-y", "srv"], env: { A: "1", B: "2" } };
    const b = { env: { B: "2", A: "1" }, args: ["-y", "srv"], command: "npx" };
    expect(toolsCacheKey(a)).toBe(toolsCacheKey(b));
  });

  test("changes when any part of the config changes", () => {
    const base = { command: "npx", args: ["-y", "srv@1.0.0"] };
    expect(toolsCacheKey(base)).not.toBe(
      toolsCacheKey({ ...base, args: ["-y", "srv@1.1.0"] }),
    );
    expect(toolsCacheKey(base)).not.toBe(
      toolsCacheKey({ ...base, env: { TOKEN: "x" } }),
    );
  });

  test("array order is significant (args are positional)", () => {
    expect(toolsCacheKey({ args: ["a", "b"] })).not.toBe(
      toolsCacheKey({ args: ["b", "a"] }),
    );
  });
});

describe("read/write round trip", () => {
  test("a written listing reads back under the same hash", () => {
    const hash = toolsCacheKey({ command: "npx" });
    writeCachedTools("acme", hash, TOOLS);
    expect(readCachedTools("acme", hash)).toEqual(TOOLS);
  });

  test("a different config hash misses, so a changed server re-lists", () => {
    writeCachedTools("acme", toolsCacheKey({ command: "npx" }), TOOLS);
    expect(
      readCachedTools("acme", toolsCacheKey({ command: "bunx" })),
    ).toBeUndefined();
  });

  test("entries are per server", () => {
    const hash = toolsCacheKey({ command: "npx" });
    writeCachedTools("acme", hash, TOOLS);
    expect(readCachedTools("other", hash)).toBeUndefined();
  });

  test("an entry past its TTL misses", () => {
    const hash = toolsCacheKey({ command: "npx" });
    const then = Date.now() - DEFAULT_TTL_MS - 1000;
    writeCachedTools("acme", hash, TOOLS, then);
    expect(readCachedTools("acme", hash, DEFAULT_TTL_MS)).toBeUndefined();
    // Still readable under a TTL long enough to cover it.
    expect(readCachedTools("acme", hash, DEFAULT_TTL_MS * 3)).toEqual(TOOLS);
  });

  test("an empty listing is never cached, so it cannot pin a server to no tools", () => {
    const hash = toolsCacheKey({ command: "npx" });
    writeCachedTools("acme", hash, []);
    expect(readCachedTools("acme", hash)).toBeUndefined();
  });

  test("forget drops one server without touching the others", () => {
    const hash = toolsCacheKey({ command: "npx" });
    writeCachedTools("acme", hash, TOOLS);
    writeCachedTools("other", hash, TOOLS);
    forgetCachedTools("acme");
    expect(readCachedTools("acme", hash)).toBeUndefined();
    expect(readCachedTools("other", hash)).toEqual(TOOLS);
  });
});

describe("degradation", () => {
  test("the kill switch makes every read a miss", () => {
    const hash = toolsCacheKey({ command: "npx" });
    writeCachedTools("acme", hash, TOOLS);
    process.env.OPENSESSION_MCP_TOOLS_CACHE = "0";
    expect(readCachedTools("acme", hash)).toBeUndefined();
  });

  test("a corrupt cache file is a cold cache, not a throw", () => {
    writeFileSync(join(DIR, ".opensession-mcp-tools-cache.json"), "{ not json");
    expect(() => readCachedTools("acme", "deadbeef")).not.toThrow();
    expect(readCachedTools("acme", "deadbeef")).toBeUndefined();
    // And it heals: the next write replaces the file wholesale.
    const hash = toolsCacheKey({ command: "npx" });
    writeCachedTools("acme", hash, TOOLS);
    expect(readCachedTools("acme", hash)).toEqual(TOOLS);
  });

  test("a file from a future schema version is ignored", () => {
    writeFileSync(
      join(DIR, ".opensession-mcp-tools-cache.json"),
      JSON.stringify({
        version: 99,
        servers: { acme: { hash: "h", tools: TOOLS, at: Date.now() } },
      }),
    );
    expect(readCachedTools("acme", "h")).toBeUndefined();
  });
});
