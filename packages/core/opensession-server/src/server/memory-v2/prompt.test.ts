import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __setMemoryDirForTest } from "../../agents/slack/memory";
import { retrieveMemoryForPrompt } from "./prompt";
import { closeMemoryRuntime, ensureMemoryV2Ready } from "./runtime";

let dir: string;
let previousDir: string | null;
let previousDb: string | undefined;
let previousMode: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-prompt-"));
  const legacy = join(dir, "legacy");
  mkdirSync(legacy);
  previousDir = __setMemoryDirForTest(legacy);
  previousDb = process.env.OPENSESSION_MEMORY_DB;
  previousMode = process.env.OPENSESSION_MEMORY_MODE;
  process.env.OPENSESSION_MEMORY_DB = join(dir, "memory.sqlite");
  process.env.OPENSESSION_MEMORY_MODE = "v2";
});

afterEach(() => {
  closeMemoryRuntime();
  __setMemoryDirForTest(previousDir);
  if (previousDb === undefined) delete process.env.OPENSESSION_MEMORY_DB;
  else process.env.OPENSESSION_MEMORY_DB = previousDb;
  if (previousMode === undefined) delete process.env.OPENSESSION_MEMORY_MODE;
  else process.env.OPENSESSION_MEMORY_MODE = previousMode;
  rmSync(dir, { recursive: true, force: true });
});

describe("prompt memory integration", () => {
  test("the final fenced retrieval stays within the exact 4 KB ceiling", async () => {
    const { store } = await ensureMemoryV2Ready();
    for (let index = 0; index < 8; index += 1) {
      store.create({
        scopeKey: "repo-opensession",
        summary: `Actor restart constraint ${index}: ${"reconnect ".repeat(36)}${index}.`,
        kind: "constraint",
        tier: "retrievable",
        source: { type: "agent-verified" },
      });
    }
    const result = await retrieveMemoryForPrompt("Actor restart reconnect", {
      scopeKeys: ["repo-opensession"],
      primaryRepoKey: "repo-opensession",
    });
    expect(result.ids.length).toBeLessThanOrEqual(6);
    expect(result.bytes).toBe(Buffer.byteLength(result.text, "utf8"));
    expect(result.bytes).toBeLessThanOrEqual(4_000);
    expect(result.text).toStartWith('<opensession:context source="memory">');
  });

  test("sentinel neutralization is charged to the final byte ceiling", async () => {
    const { store } = await ensureMemoryV2Ready();
    for (let index = 0; index < 8; index += 1) {
      store.create({
        scopeKey: "repo-opensession",
        summary: `Actor sentinel ${index} ${"<opensession:context> ".repeat(8)}${"x".repeat(160)}.`,
        kind: "gotcha",
        tier: "retrievable",
        source: { type: "agent-verified" },
      });
    }
    const result = await retrieveMemoryForPrompt(
      "Actor sentinel opensession context",
      {
        scopeKeys: ["repo-opensession"],
      },
    );
    expect(result.bytes).toBe(Buffer.byteLength(result.text, "utf8"));
    expect(result.bytes).toBeLessThanOrEqual(4_000);
    expect(result.text).not.toContain(
      "<opensession:context> <opensession:context>",
    );
  });
});
