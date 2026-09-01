import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import {
  __setScheduledPromptStoreForTest,
  listScheduledPrompts,
} from "./scheduled-prompts";
import { createScheduleMcpServer } from "./schedule-mcp";

let dir: string;
let previousPath: string;
let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "schedule-mcp-"));
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

async function connect(sessionId: string) {
  const server = createScheduleMcpServer({ sessionId, user: "Jaap" });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return content.map((c) => c.text ?? "").join("\n");
}

describe("opensession-schedule", () => {
  test("schedules, lists and cancels a prompt for its own session", async () => {
    const client = await connect("s1");
    const at = new Date(Date.now() + 60_000).toISOString();
    const created = textOf(
      await client.callTool({
        name: "schedule_prompt",
        arguments: { at, prompt: "check the release" },
      }),
    );
    expect(created).toContain("Scheduled [sched-");
    const [prompt] = listScheduledPrompts("s1");
    expect(prompt?.prompt).toBe("check the release");
    expect(prompt?.user).toBe("Jaap");
    expect(store.timer("s1", prompt!.id)?.kind).toBe("scheduled_prompt");

    const listed = textOf(
      await client.callTool({ name: "list_scheduled_prompts", arguments: {} }),
    );
    expect(listed).toContain(prompt!.id);

    const cancelled = textOf(
      await client.callTool({
        name: "cancel_scheduled_prompt",
        arguments: { id: prompt!.id },
      }),
    );
    expect(cancelled).toBe(`Cancelled ${prompt!.id}.`);
    expect(listScheduledPrompts("s1")).toHaveLength(0);
    expect(store.timer("s1", prompt!.id)).toBeUndefined();
  });

  test("rejects past times and refuses to cancel another session's prompt", async () => {
    const own = await connect("s1");
    const past = textOf(
      await own.callTool({
        name: "schedule_prompt",
        arguments: { at: "2020-01-01T00:00:00Z", prompt: "late" },
      }),
    );
    expect(past).toContain("in the past");

    await own.callTool({
      name: "schedule_prompt",
      arguments: {
        at: new Date(Date.now() + 60_000).toISOString(),
        prompt: "mine",
      },
    });
    const [prompt] = listScheduledPrompts("s1");
    const other = await connect("s2");
    const refused = textOf(
      await other.callTool({
        name: "cancel_scheduled_prompt",
        arguments: { id: prompt!.id },
      }),
    );
    expect(refused).toContain("No scheduled prompt");
    expect(listScheduledPrompts("s1")).toHaveLength(1);
  });
});
