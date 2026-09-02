import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { disposeAutomationSandbox } from "./automation-disposal";
import { SESSIONS_DIR, updateSessionFile } from "../session-cache";

const created: string[] = [];

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

    await expect(
      disposeAutomationSandbox({
        sessionId,
        sandboxId: "executor-live",
        provider: {
          id: "daytona",
          destroy: async () => {
            throw new Error("delete unconfirmed");
          },
        },
      }),
    ).rejects.toThrow("delete unconfirmed");

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
