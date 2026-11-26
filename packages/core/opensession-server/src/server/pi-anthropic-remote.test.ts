/**
 * The pi Anthropic provider over the "remote" transport: the real provider,
 * the real client, a real Claude host listener on loopback, and a scripted
 * stand-in for Claude Code behind it. Checks that a tool turn behaves as it
 * does in-process and that the account's token never reaches the host.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  startClaudeHostServer,
  type ClaudeHostServer,
} from "../claude-host/server";
import * as accounts from "./claude-accounts";
import type {
  ClaudeQueryHandle,
  ClaudeQueryIo,
  ClaudeQuerySpec,
} from "./claude-sdk-query";
import { __claudeTokenLeaseCountForTest } from "./claude-token-proxy";
import { loadModelProviders } from "./model-providers";
import {
  buildPiAnthropicProvider,
  liveSdkConversations,
  type PiCatalogModel,
} from "./pi-model-runtime";
import { loadPiConfig } from "./pi-config";

const ACCOUNT = "remote-account";
const REAL_TOKEN = `sk-ant-oat01-${ACCOUNT}`;
const HOST_TOKEN = "remote-test-host-token";

const dir = mkdtempSync(join(tmpdir(), "pi-anthropic-remote-"));
const piConfigFile = join(dir, "pi.json");
const providerConfigFile = join(dir, "model-providers.json");
const accountsFile = join(dir, "accounts.json");
const hostTokenFile = join(dir, "claude-host-token");
const ENV = {
  OPENSESSION_PI_CONFIG: piConfigFile,
  OPENSESSION_MODEL_PROVIDERS_CONFIG: providerConfigFile,
  OPENSESSION_CLAUDE_ACCOUNTS_PATH: accountsFile,
  OPENSESSION_CLAUDE_HOST_TOKEN_FILE: hostTokenFile,
} as const;
const savedEnv = Object.fromEntries(
  Object.keys(ENV).map((key) => [key, process.env[key]]),
);

const model = {
  id: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200_000,
  maxTokens: 64_000,
} as unknown as PiCatalogModel;

/** What the scripted Claude Code saw, per started query. */
interface Started {
  spec: ClaudeQuerySpec;
  inputs: unknown[];
  toolReplies: unknown[];
  closed: boolean;
}
const started: Started[] = [];

const usage = (output: number) => ({
  input_tokens: 2,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 10,
});
const stream = (event: Record<string, unknown>) => ({
  type: "stream_event",
  event,
  session_id: "sdk-remote",
});

/** Acts like Claude Code on one conversation: the first user message leads to
 *  a `bash` call that waits for its result, then to an answer quoting it. */
function scriptedClaudeCode(
  spec: ClaudeQuerySpec,
  io: ClaudeQueryIo,
): ClaudeQueryHandle {
  const record: Started = { spec, inputs: [], toolReplies: [], closed: false };
  started.push(record);
  const out: Array<Record<string, any>> = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  const emit = (message: Record<string, any>) => {
    out.push(message);
    waiters.shift()?.();
  };
  void (async () => {
    const input = io.prompt[Symbol.asyncIterator]();
    const first = await input.next();
    if (first.done) return;
    record.inputs.push(first.value.message.content);
    emit({ type: "system", subtype: "init", session_id: "sdk-remote" });
    emit(
      stream({
        type: "message_start",
        message: { id: "msg_1", usage: usage(1) },
      }),
    );
    emit({
      type: "assistant",
      uuid: "asst-1",
      session_id: "sdk-remote",
      message: {
        id: "msg_1",
        usage: usage(1),
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "mcp__oc__bash",
            input: { command: "ls" },
          },
        ],
      },
    });
    const reply = await io.onToolCall("toolu_1");
    record.toolReplies.push(reply);
    if (record.closed) return;
    const text = `saw: ${reply.content.map((part) => ("text" in part ? part.text : "")).join("")}`;
    emit(stream({ type: "message_delta", usage: usage(20) }));
    emit(stream({ type: "message_stop" }));
    emit(
      stream({
        type: "message_start",
        message: { id: "msg_2", usage: usage(1) },
      }),
    );
    emit({
      type: "assistant",
      uuid: "asst-2",
      session_id: "sdk-remote",
      message: {
        id: "msg_2",
        usage: usage(1),
        content: [{ type: "text", text }],
      },
    });
    emit(stream({ type: "message_delta", usage: usage(7) }));
    emit(stream({ type: "message_stop" }));
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: text,
      usage: usage(27),
      session_id: "sdk-remote",
    });
    // A later user message gets no answer: the test cancels that turn.
    const second = await input.next();
    if (!second.done) record.inputs.push(second.value.message.content);
  })();
  return {
    async next() {
      while (!out.length && !ended)
        await new Promise<void>((resolve) => waiters.push(resolve));
      const value = out.shift();
      return value ? { value, done: false } : { value: undefined, done: true };
    },
    close() {
      record.closed = true;
      ended = true;
      for (const wake of waiters.splice(0)) wake();
    },
  };
}

let host: ClaudeHostServer;

async function writeConfig(port: number): Promise<void> {
  writeFileSync(
    piConfigFile,
    JSON.stringify({
      enabled: true,
      anthropicTransport: "remote",
      claudeHostUrl: `ws://127.0.0.1:${port}`,
    }),
  );
  await loadPiConfig();
}

beforeAll(async () => {
  Object.assign(process.env, ENV);
  host = startClaudeHostServer({
    hostname: "127.0.0.1",
    port: 0,
    token: HOST_TOKEN,
    maxQueries: 4,
    startQuery: scriptedClaudeCode,
  });
  writeFileSync(hostTokenFile, `${HOST_TOKEN}\n`);
  writeFileSync(
    providerConfigFile,
    JSON.stringify({ enabled: true, bridgeAccountIds: [ACCOUNT] }),
  );
  writeFileSync(
    accountsFile,
    JSON.stringify({
      accounts: [
        {
          id: ACCOUNT,
          name: ACCOUNT,
          token: REAL_TOKEN,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  );
  await writeConfig(host.port);
  await Promise.all([loadModelProviders(), accounts.loadClaudeAccounts()]);
  accounts.__setUsageCacheForTest(ACCOUNT, {
    fetchedAt: new Date().toISOString(),
    fiveHour: { utilization: 10, resetsAt: null },
    sevenDay: null,
    extraUsage: null,
  });
});

afterAll(() => {
  host.stop();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const context = (messages: unknown[]) => ({
  messages: [
    {
      role: "system",
      content: "Base prompt",
      toolsAdded: [
        {
          name: "bash",
          description: "Run a command",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
      timestamp: 0,
    },
    ...messages,
  ],
});

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await Bun.sleep(5);
  }
}

describe("pi Anthropic provider over a remote Claude host", () => {
  test("a tool turn runs on the host, which never sees the account token", async () => {
    const sessionId = `remote-${crypto.randomUUID()}`;
    const provider = buildPiAnthropicProvider({
      unifiedSessionId: sessionId,
      builtinModels: [model],
    }) as any;
    const run = async (messages: unknown[], signal?: AbortSignal) => {
      const events: any[] = [];
      for await (const event of provider.streamSimple(
        model,
        context(messages),
        {
          sessionId,
          signal,
        },
      ))
        events.push(event);
      return events;
    };
    const leasesBefore = __claudeTokenLeaseCountForTest();
    started.length = 0;

    const user = { role: "user", content: "list files" };
    const step1 = (await run([user])).find((e) => e.type === "done")?.message;
    expect(step1?.stopReason).toBe("toolUse");
    expect(step1.content).toEqual([
      {
        type: "toolCall",
        id: "toolu_1",
        name: "bash",
        arguments: { command: "ls" },
      },
    ]);

    const toolResult = {
      role: "toolResult",
      toolCallId: "toolu_1",
      toolName: "bash",
      content: [{ type: "text", text: "a.txt" }],
      isError: false,
      timestamp: Date.now(),
    };
    const step2 = (await run([user, step1, toolResult])).find(
      (e) => e.type === "done",
    )?.message;
    expect(step2?.stopReason).toBe("stop");
    expect(step2.content).toEqual([{ type: "text", text: "saw: a.txt" }]);

    // One Claude Code process served both steps, on the host.
    expect(started).toHaveLength(1);
    expect(host.queries()).toBe(1);
    const { spec, inputs, toolReplies } = started[0];
    expect(inputs).toEqual(["list files"]);
    expect(toolReplies).toEqual([
      { content: [{ type: "text", text: "a.txt" }] },
    ]);
    expect(spec).toMatchObject({
      accountId: ACCOUNT,
      model: "claude-sonnet-5",
      system: "Base prompt",
      tools: [{ name: "bash", description: "Run a command" }],
    });
    // The host got a placeholder and the proxy's address, not the token.
    expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toStartWith(
      "sk-ant-oat01-placeholder-",
    );
    expect(spec.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(spec.env.DISABLE_COMPACT).toBe("1");
    expect(JSON.stringify(spec)).not.toContain(REAL_TOKEN);
    expect(__claudeTokenLeaseCountForTest()).toBe(leasesBefore + 1);

    // Canceling a later turn retires the process and its placeholder.
    const cancel = new AbortController();
    const step3 = run(
      [user, step1, toolResult, step2, { role: "user", content: "more" }],
      cancel.signal,
    );
    await until(() => started[0].inputs.length === 2);
    cancel.abort();
    const last = (await step3).at(-1);
    expect(last).toMatchObject({ type: "error", reason: "aborted" });
    await until(() => host.queries() === 0);
    expect(started[0].closed).toBe(true);
    expect(__claudeTokenLeaseCountForTest()).toBe(leasesBefore);
    expect(
      [...liveSdkConversations().keys()].filter((key) =>
        key.startsWith(`pi:${sessionId}:`),
      ),
    ).toEqual([]);
  });

  test("an unreachable host fails the turn and says how to switch back", async () => {
    await writeConfig(1);
    try {
      const sessionId = `remote-down-${crypto.randomUUID()}`;
      const provider = buildPiAnthropicProvider({
        unifiedSessionId: sessionId,
        builtinModels: [model],
      }) as any;
      const events: any[] = [];
      for await (const event of provider.streamSimple(
        model,
        context([{ role: "user", content: "hi" }]),
        { sessionId },
      ))
        events.push(event);
      const last = events.at(-1);
      expect(last.type).toBe("error");
      expect(last.error.errorMessage).toContain(
        "Could not connect to the Claude host",
      );
      expect(last.error.errorMessage).toContain("anthropicTransport");
      expect(
        [...liveSdkConversations().keys()].filter((key) =>
          key.startsWith(`pi:${sessionId}:`),
        ),
      ).toEqual([]);
    } finally {
      await writeConfig(host.port);
    }
  });
});
