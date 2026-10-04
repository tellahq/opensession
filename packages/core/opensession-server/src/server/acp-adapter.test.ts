import { describe, expect, test } from "bun:test";
import {
  createAcpAdapter,
  acpCapabilities,
  type AcpRunOptions,
} from "./acp-adapter";
import type { StreamEvent } from "./run-events";

const fixture = new URL("./testing/fake-acp-agent.fixture.ts", import.meta.url)
  .pathname;
const agent = (env?: Record<string, string>) =>
  createAcpAdapter({
    id: "fake",
    name: "Fake",
    command: process.execPath,
    args: [fixture],
    env,
  });
const options = (overrides: Partial<AcpRunOptions> = {}): AcpRunOptions => ({
  prompt: "hello",
  cwd: process.cwd(),
  mode: "code",
  mcpServers: [],
  startToken: crypto.randomUUID(),
  ...overrides,
});
async function collect(
  events: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const result: StreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("ACP adapter", () => {
  test("negotiates features and streams a complete turn with one-time permission", async () => {
    const adapter = agent();
    const events = await collect(adapter.run(options(), "acp/fake"));
    expect(events.map((event) => event.type)).toEqual([
      "init",
      "text_chunk",
      "runner_notice",
      "tool_use",
      "tool_result",
      "done",
    ]);
    expect(events[0]).toMatchObject({
      sessionId: "fake-session",
      engineKind: "acp",
      engineInstanceId: "fake",
      engineCapabilities: {
        version: 1,
        canResume: true,
        supportsSteering: false,
        supportsImages: true,
      },
    });
    expect(events[3]).toMatchObject({
      toolName: "Read",
      toolUseId: "tool-1",
      toolInput: { path: "example.txt" },
    });
    expect(events[4].content).toContain('"optionId":"once"');
    expect(events.at(-1)?.result).toBe("Hello");
    expect(adapter.activeCount()).toBe(0);
  });
  test("loads the stored cursor instead of starting a fresh conversation", async () => {
    const events = await collect(
      agent().run(options({ sessionId: "fake-session" }), "acp/fake"),
    );
    expect(events.at(-1)).toMatchObject({ type: "done", result: "Resumed" });
  });
  test("unsupported resume fails explicitly", async () => {
    const events = await collect(
      agent({ FAKE_NO_RESUME: "1" }).run(
        options({ sessionId: "fake-session" }),
        "acp/fake",
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0].content).toContain("does not support loading");
  });
  test("cancel reaches the active handle and cleans up aliases", async () => {
    const adapter = agent();
    const opts = options({ prompt: "wait" });
    const events = adapter.run(opts, "acp/fake");
    expect((await events.next()).value?.type).toBe("init");
    expect((await events.next()).value?.type).toBe("text_chunk");
    expect(adapter.busy(opts.startToken!)).toBe(true);
    expect(adapter.cancel(opts.startToken!)).toBe(true);
    expect((await events.next()).value).toMatchObject({
      type: "error",
      content: "ACP turn cancelled",
    });
    await events.next();
    expect(adapter.busy("fake-session")).toBe(false);
    expect(adapter.activeCount()).toBe(0);
    expect(adapter.cancel(opts.startToken!)).toBe(false);
  });
  test("early consumer return kills its process", async () => {
    const adapter = agent();
    const events = adapter.run(options({ prompt: "wait" }), "acp/fake");
    await events.next();
    await events.return(undefined);
    expect(adapter.activeCount()).toBe(0);
  });
  test("unavailable binary gives a clear error", async () => {
    const adapter = createAcpAdapter({
      id: "missing",
      name: "Missing",
      command: "/nonexistent/example-acp",
    });
    const events = await collect(adapter.run(options(), "acp/missing"));
    expect(events[0].type).toBe("error");
    expect(events[0].content).toContain("could not start");
  });
  test("unexpected agent exit settles the turn", async () => {
    const events = await collect(
      agent().run(options({ prompt: "crash" }), "acp/fake"),
    );
    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)?.content).toContain("exited");
  });
  test("refuses policies it cannot enforce before spawning", async () => {
    for (const policy of [
      { mode: "ask" as const },
      { mcpServers: "all" as const },
      { deniedTools: { bash: "Denied" } },
    ]) {
      const events = await collect(agent().run(options(policy), "acp/fake"));
      expect(events).toHaveLength(1);
      expect(events[0].content).toContain("tool policy");
    }
  });
  test("capabilities are conservative before negotiation", () => {
    expect(acpCapabilities()).toMatchObject({
      canResume: false,
      supportsImages: false,
      supportsSteering: false,
    });
  });
});
