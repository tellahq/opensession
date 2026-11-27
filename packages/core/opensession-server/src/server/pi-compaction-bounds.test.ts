import { describe, expect, test } from "bun:test";
import {
  contentText,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import {
  compact,
  findCutPoint,
  generateSummaryWithUsage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { vertexFallbackModel } from "./vertex-provider";

// Exercises the installed dependency, including our Bun patch. No provider I/O.
const model: Model<"google-vertex"> = {
  ...vertexFallbackModel("gemini-4-neon"),
  api: "google-vertex",
  provider: "google-vertex",
  baseUrl: "https://vertex.example.test",
  contextWindow: 20_000,
};
const usage = {
  input: 100,
  output: 20,
  cacheRead: 10,
  cacheWrite: 0,
  reasoning: 5,
  totalTokens: 130,
  cost: {
    input: 0.03,
    output: 0.04,
    cacheRead: 0.01,
    cacheWrite: 0,
    total: 0.08,
  },
};
type Stream = NonNullable<Parameters<typeof generateSummaryWithUsage>[9]>;

function harness(stopReason: AssistantMessage["stopReason"] = "stop") {
  const prompts: string[] = [];
  const stream: Stream = (selected, context, options) => {
    const bytes = context.messages.reduce(
      (sum, message) => sum + Buffer.byteLength(contentText(message.content)),
      0,
    );
    expect(bytes + (options?.maxTokens ?? 0)).toBeLessThan(
      selected.contextWindow,
    );
    const prompt = context.messages
      .filter((message) => message.role === "user")
      .map((message) => contentText(message.content))
      .join("\n");
    prompts.push(prompt);
    const response: AssistantMessage = {
      role: "assistant",
      api: "google-vertex",
      provider: selected.provider,
      model: selected.id,
      content: [{ type: "text", text: `Summary ${prompts.length}` }],
      stopReason,
      timestamp: 1,
      usage: { ...usage, cost: { ...usage.cost } },
      ...(stopReason === "error"
        ? { errorMessage: "Provider unavailable" }
        : {}),
    };
    return { result: async () => response } as ReturnType<Stream>;
  };
  return { stream, prompts };
}

function summarize(
  text: string,
  stream: Stream,
  previousSummary?: string,
  signal?: AbortSignal,
) {
  return generateSummaryWithUsage(
    [{ role: "user", content: text, timestamp: 1 }],
    model,
    16_384,
    undefined,
    undefined,
    signal,
    "Preserve the build steps.",
    previousSummary,
    undefined,
    stream,
  );
}

describe("bounded Pi compaction", () => {
  test("the retained tail keeps complete tool exchanges and the newest input", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({
      role: "user",
      content: "Old history ".repeat(4_000),
      timestamp: 1,
    });
    manager.appendMessage({
      role: "assistant",
      api: "google-vertex",
      provider: model.provider,
      model: model.id,
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "example.ts" },
        },
      ],
      stopReason: "toolUse",
      timestamp: 2,
      usage,
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "File content" }],
      isError: false,
      timestamp: 3,
    });
    manager.appendMessage({
      role: "user",
      content: "Continue with this requirement.",
      timestamp: 4,
    });
    const entries = manager.getEntries();
    const cut = findCutPoint(entries, 0, entries.length, 1_000);
    expect(cut.firstKeptEntryIndex).toBe(1);
    expect(cut.isSplitTurn).toBe(true);
    expect(
      entries
        .slice(cut.firstKeptEntryIndex)
        .map((entry) =>
          entry.type === "message" ? entry.message.role : entry.type,
        ),
    ).toEqual(["assistant", "toolResult", "user"]);
    // A new user input with no subsequent assistant response cannot be skipped.
    const newest = SessionManager.inMemory();
    newest.appendMessage({
      role: "user",
      content: "New request ".repeat(4_000),
      timestamp: 1,
    });
    expect(
      findCutPoint(newest.getEntries(), 0, 1, 1_000).firstKeptEntryIndex,
    ).toBe(0);
  });

  test("an overflowed resumed turn compacts bounded chunks and retries successfully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "os-compact-recovery-"));
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("google-vertex", async () => ({
      type: "api_key",
      key: "test-key",
    }));
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider("google-vertex", { models: [model] });
    const manager = SessionManager.inMemory(dir);
    manager.appendMessage({
      role: "user",
      content: "Earlier conversation ".repeat(6_000),
      timestamp: 1,
    });
    // A stale provider count can underestimate the resumed projection.
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Working" }],
      api: "google-vertex",
      provider: "previous-provider",
      model: "previous-model",
      stopReason: "stop",
      timestamp: 2,
      usage,
    });
    const settings = SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: 4_000,
        keepRecentTokens: 1_000,
      },
      cacheWarming: "off",
    });
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => "You are a helpful assistant.",
    });
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      modelRuntime: runtime,
      model,
      tools: [],
      sessionManager: manager,
      settingsManager: settings,
      resourceLoader: loader,
    });
    let overflows = 0;
    let summaries = 0;
    let completions = 0;
    session.agent.streamFunction = (selected, context, options) => {
      const stream = createAssistantMessageEventStream();
      const bytes = context.messages.reduce(
        (sum, m) => sum + Buffer.byteLength(contentText(m.content)),
        0,
      );
      const isSummary = options?.cacheRetention === "none";
      if (isSummary) {
        expect(bytes + (options?.maxTokens ?? 0)).toBeLessThan(
          selected.contextWindow,
        );
        summaries++;
      }
      const overflow = !isSummary && bytes > selected.contextWindow;
      if (overflow) overflows++;
      else if (!isSummary) completions++;
      const response: AssistantMessage = {
        role: "assistant",
        api: "google-vertex",
        provider: selected.provider,
        model: selected.id,
        content: overflow
          ? []
          : [
              {
                type: "text",
                text: isSummary
                  ? "A concise summary of earlier progress."
                  : "OK",
              },
            ],
        stopReason: overflow ? "error" : "stop",
        timestamp: Date.now(),
        usage,
        ...(overflow
          ? {
              errorMessage: `The input token count exceeds the maximum number of tokens allowed (${selected.contextWindow}); input token count: ${bytes}.`,
            }
          : {}),
      };
      if (overflow)
        stream.push({ type: "error", reason: "error", error: response });
      else stream.push({ type: "done", reason: "stop", message: response });
      stream.end();
      return stream;
    };
    try {
      await session.prompt("Continue.");
      expect(overflows).toBe(1);
      expect(summaries).toBeGreaterThan(1);
      expect(completions).toBe(1);
      expect(
        manager.getEntries().some((entry) => entry.type === "compaction"),
      ).toBe(true);
    } finally {
      session.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ordinary compaction stays a single request", async () => {
    const h = harness();
    const result = await summarize("Please fix the build.", h.stream);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("Preserve the build steps.");
    expect(result.usage).toEqual(usage);
  });

  test("a single oversized message is split without losing Unicode or source text", async () => {
    const h = harness();
    const text = "Start\n" + "café 日本語 🦊\n".repeat(10_000) + "End";
    const result = await summarize(text, h.stream);
    expect(h.prompts.length).toBeGreaterThan(2);
    const chunks = h.prompts.map(
      (p) => p.match(/<conversation>\n([\s\S]*?)\n<\/conversation>/)![1],
    );
    expect(chunks.join("")).toBe(`[User]: ${text}`);
    for (let i = 1; i < h.prompts.length; i++) {
      expect(h.prompts[i]).toContain(`<previous-summary>\nSummary ${i}`);
      expect(h.prompts[i]).toContain("Preserve the build steps.");
    }
    expect(result.text).toBe(`Summary ${h.prompts.length}`);
    expect(result.usage.input).toBe(100 * h.prompts.length);
    expect(result.usage.output).toBe(20 * h.prompts.length);
    expect(result.usage.reasoning).toBe(5 * h.prompts.length);
    expect(result.usage.cost.total).toBeCloseTo(0.08 * h.prompts.length);
  });

  test("an oversized previous summary is also processed after a model switch", async () => {
    const h = harness();
    const previous = "Prior decisions. ".repeat(3_000);
    await summarize("Continue the work.", h.stream, previous);
    const chunks = h.prompts.map((p) =>
      p.slice(
        p.indexOf("<conversation>\n") + 15,
        p.lastIndexOf("\n</conversation>"),
      ),
    );
    expect(chunks.join("")).toContain(previous);
    expect(chunks.join("")).toContain("[User]: Continue the work.");
  });

  test("split-turn compaction bounds both summary requests and aggregates costs", async () => {
    const h = harness();
    const result = await compact(
      {
        firstKeptEntryId: "keep-entry",
        messagesToSummarize: [
          { role: "user", content: "Old history", timestamp: 1 },
        ],
        turnPrefixMessages: [
          { role: "user", content: "Large turn ".repeat(8_000), timestamp: 2 },
        ],
        isSplitTurn: true,
        tokensBefore: 40_000,
        fileOps: {
          read: new Set(["src/example.ts"]),
          written: new Set(),
          edited: new Set(),
        },
        settings: {
          enabled: true,
          reserveTokens: 16_384,
          keepRecentTokens: 2_000,
        },
      },
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      h.stream,
    );
    expect(h.prompts.length).toBeGreaterThan(2);
    expect(result.firstKeptEntryId).toBe("keep-entry");
    expect(result.summary).toContain("src/example.ts");
    expect(result.summary).toContain("Turn Context (split turn)");
    expect(result.usage?.cost.total).toBeCloseTo(0.08 * h.prompts.length);
  });

  test.each(["error", "length", "aborted"] as const)(
    "does not accept a %s summary as a checkpoint",
    async (reason) => {
      const h = harness(reason);
      await expect(
        summarize("History ".repeat(8_000), h.stream),
      ).rejects.toThrow();
      expect(h.prompts).toHaveLength(1);
    },
  );

  test("cancellation between chunks stops further requests", async () => {
    const h = harness();
    const controller = new AbortController();
    const stream: Stream = (...args) => {
      const result = h.stream(...args);
      controller.abort();
      return result;
    };
    await expect(
      summarize("History ".repeat(8_000), stream, undefined, controller.signal),
    ).rejects.toThrow();
    expect(h.prompts).toHaveLength(1);
  });
});
