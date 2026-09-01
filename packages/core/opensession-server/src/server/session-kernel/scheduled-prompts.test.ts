import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionKernelStore, __setSessionKernelStoreForTest } from ".";
import {
  __setScheduledPromptStoreForTest,
  createScheduledPrompt,
  deleteScheduledPrompt,
  hydrateScheduledPromptTimers,
  listScheduledPrompts,
} from "../scheduled-prompts";

let dir: string;
let previousPath: string;
let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scheduled-kernel-"));
  previousPath = __setScheduledPromptStoreForTest(join(dir, "scheduled.json"));
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
});

afterEach(() => {
  __setScheduledPromptStoreForTest(previousPath);
  __setSessionKernelStoreForTest(previousStore);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("scheduled prompt kernel timers", () => {
  test("creation and deletion update the durable timer", async () => {
    const created = createScheduledPrompt({
      sessionId: "s1",
      prompt: "continue",
      user: "Jaap",
      at: new Date(Date.now() + 60_000).toISOString(),
    });
    if ("error" in created) throw new Error(created.error);
    expect(store.timer("s1", created.id)?.kind).toBe("scheduled_prompt");
    expect(listScheduledPrompts("s1")).toHaveLength(1);
    expect(await deleteScheduledPrompt(created.id)).toBe(true);
    expect(store.timer("s1", created.id)).toBeUndefined();
  });

  test("boot hydration reconstructs missing timer rows", () => {
    const created = createScheduledPrompt({
      sessionId: "s1",
      prompt: "continue",
      user: "Jaap",
      at: new Date(Date.now() + 60_000).toISOString(),
    });
    if ("error" in created) throw new Error(created.error);
    store.cancelTimer("s1", created.id);
    expect(hydrateScheduledPromptTimers()).toBe(1);
    expect(store.timer("s1", created.id)).toBeDefined();
  });
});
