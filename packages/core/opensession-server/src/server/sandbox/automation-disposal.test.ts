import { getConfigAsync } from "../config";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "automation-disposal-"));
const previousEnv = {
  HOME: process.env.HOME,
  OPENSESSION_STATE_DIR: process.env.OPENSESSION_STATE_DIR,
  OPENSESSION_SESSIONS_DIR: process.env.OPENSESSION_SESSIONS_DIR,
  OPENSESSION_CONFIG: process.env.OPENSESSION_CONFIG,
};
process.env.HOME = root;
process.env.OPENSESSION_STATE_DIR = root;
process.env.OPENSESSION_SESSIONS_DIR = join(root, "sessions");
process.env.OPENSESSION_CONFIG = join(root, "config.json");
await getConfigAsync();
writeFileSync(process.env.OPENSESSION_CONFIG, JSON.stringify({ repos: {} }));
// Set isolated paths before importing modules that cache configuration. Keep
// the real list worker so asynchronous export completion is exercised too.
const { disposeAutomationSandbox } = await import("./automation-disposal");
const { SESSIONS_DIR, updateSessionFile } = await import("../session-cache");
const { closeSessionListIndex } = await import("../session-list-store");
const { __sessionKernelStoreForTest } =
  await import("../session-kernel/kernel");

const created: string[] = [];

afterAll(() => {
  closeSessionListIndex();
  __sessionKernelStoreForTest().close();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

async function writeSession(sessionId: string, sandboxId: string) {
  created.push(sessionId);
  mkdirSync(SESSIONS_DIR, { recursive: true });
  await updateSessionFile(sessionId, () => ({
    id: sessionId,
    claudeSessionId: "",
    branch: "main",
    worktreeDir: "/remote/worktree",
    createdBy: "Automation (automation)",
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    sandbox: {
      provider: "daytona",
      sandboxId,
      workspace: "volume",
      lifecycle: "awake",
    },
  }));
}

afterEach(() => {
  for (const sessionId of created.splice(0)) {
    const path = `${SESSIONS_DIR}/${sessionId}.json`;
    if (existsSync(path)) unlinkSync(path);
  }
});

describe("disposable automation Executor cleanup", () => {
  test("removes the destroyed id but retains the provider for a fresh resume", async () => {
    const sessionId = `automation-disposal-${crypto.randomUUID()}`;
    await writeSession(sessionId, "executor-old");
    const destroyed: string[] = [];

    await disposeAutomationSandbox({
      sessionId,
      sandboxId: "executor-old",
      provider: {
        id: "daytona",
        destroy: async (sandboxId) => {
          destroyed.push(sandboxId);
        },
      },
    });

    expect(destroyed).toEqual(["executor-old"]);
    const written = JSON.parse(
      readFileSync(`${SESSIONS_DIR}/${sessionId}.json`, "utf8"),
    );
    expect(written.sandbox).toEqual({
      provider: "daytona",
      lifecycle: "sleeping",
    });
  });

  test("stale cleanup cannot erase a replacement Executor id", async () => {
    const sessionId = `automation-disposal-${crypto.randomUUID()}`;
    await writeSession(sessionId, "executor-new");

    await disposeAutomationSandbox({
      sessionId,
      sandboxId: "executor-old",
      provider: {
        id: "daytona",
        destroy: async () => {},
      },
    });

    const written = JSON.parse(
      readFileSync(`${SESSIONS_DIR}/${sessionId}.json`, "utf8"),
    );
    expect(written.sandbox.sandboxId).toBe("executor-new");
  });

  test("failed strict disposal keeps the Executor fenced", async () => {
    const sessionId = `automation-disposal-${crypto.randomUUID()}`;
    await writeSession(sessionId, "executor-live");

    const disposal = disposeAutomationSandbox({
      sessionId,
      sandboxId: "executor-live",
      provider: {
        id: "daytona",
        destroy: async () => {
          throw new Error("delete unconfirmed");
        },
      },
    });
    // Bun's rejects matcher can block pending Worker replies. Settle the real
    // operation first, then assert that it rejected with the expected error.
    await disposal.catch(() => undefined);
    await expect(disposal).rejects.toThrow("delete unconfirmed");

    const written = JSON.parse(
      readFileSync(`${SESSIONS_DIR}/${sessionId}.json`, "utf8"),
    );
    expect(written.sandbox).toMatchObject({
      sandboxId: "executor-live",
      lifecycle: "needs_attention",
      lastLifecycleError: "delete unconfirmed",
    });
  });
});
