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
import { createScheduleMcpServer, resolveDeliveryTime } from "./schedule-mcp";
import { __setIdentitiesForTest } from "./shared/user-mappings";

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

async function connect(sessionId: string, user = "Jaap") {
  const server = createScheduleMcpServer({ sessionId, user });
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
  // schedule_prompt is handed to the model by name, so its declaration is in
  // every request's cached prefix. It must not depend on who started the
  // turn: a time zone in it rewrote the prompt cache whenever a teammate or
  // a GitHub event followed the session's owner.
  test("the tools are declared the same for every prompter", async () => {
    const restore = __setIdentitiesForTest([
      {
        name: "Ada",
        email: "ada@example.test",
        aliases: ["ada"],
        timezone: "Europe/Amsterdam",
      },
      {
        name: "Bo",
        email: "bo@example.test",
        aliases: ["bo"],
        timezone: "America/New_York",
      },
    ]);
    try {
      const declared = async (sessionId: string, user: string) =>
        JSON.stringify(
          (await (await connect(sessionId, user)).listTools()).tools,
        );
      const ada = await declared("s1", "Ada");
      expect(await declared("s1", "Bo")).toBe(ada);
      expect(await declared("s2", "GitHub")).toBe(ada);
      expect(ada).not.toContain("Amsterdam");
    } finally {
      restore();
    }
  });

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
    const [prompt] = await listScheduledPrompts("s1");
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
    expect(await listScheduledPrompts("s1")).toHaveLength(0);
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
    const [prompt] = await listScheduledPrompts("s1");
    const other = await connect("s2");
    const refused = textOf(
      await other.callTool({
        name: "cancel_scheduled_prompt",
        arguments: { id: prompt!.id },
      }),
    );
    expect(refused).toContain("No scheduled prompt");
    expect(await listScheduledPrompts("s1")).toHaveLength(1);
  });

  test("takes a relative delay so the model never computes a timestamp", async () => {
    const client = await connect("s1");
    const before = Date.now();
    const created = textOf(
      await client.callTool({
        name: "schedule_prompt",
        arguments: { in_minutes: 20, prompt: "check the benchmark" },
      }),
    );
    expect(created).toContain("Scheduled [sched-");
    const [prompt] = await listScheduledPrompts("s1");
    const delay = Date.parse(prompt!.at) - before;
    expect(delay).toBeGreaterThanOrEqual(20 * 60_000 - 1_000);
    expect(delay).toBeLessThan(20 * 60_000 + 5_000);
  });

  test("needs exactly one of in_minutes or at", () => {
    const now = Date.parse("2026-09-01T12:00:00Z");
    expect(resolveDeliveryTime({ in_minutes: 1.5 }, now)).toEqual({
      at: "2026-09-01T12:01:30.000Z",
    });
    expect(resolveDeliveryTime({ at: " 2026-09-02T00:00:00Z " }, now)).toEqual({
      at: "2026-09-02T00:00:00Z",
    });
    expect(resolveDeliveryTime({}, now)).toHaveProperty("error");
    expect(
      resolveDeliveryTime({ in_minutes: 5, at: "2026-09-02T00:00:00Z" }, now),
    ).toHaveProperty("error");
    expect(resolveDeliveryTime({ in_minutes: 0 }, now)).toHaveProperty("error");
    expect(resolveDeliveryTime({ in_minutes: 20_000 }, now)).toHaveProperty(
      "error",
    );
  });
});
