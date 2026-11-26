/**
 * Claude host tests: the wire protocol end to end over a real loopback
 * WebSocket, with a scripted query in place of the Claude Agent SDK. No
 * Claude Code process is started.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { startRemoteClaudeQuery } from "../server/claude-host-client";
import {
  ClaudeInputQueue,
  type ClaudeQueryHandle,
  type ClaudeQueryIo,
  type ClaudeQuerySpec,
} from "../server/claude-sdk-query";
import { filterClaudeHostEnv, parseClaudeHostClientFrame } from "./protocol";
import { startClaudeHostServer, type ClaudeHostServer } from "./server";

const TOKEN = "host-test-token";

const spec = (extra: Partial<ClaudeQuerySpec> = {}): ClaudeQuerySpec => ({
  accountId: "account-a",
  model: "claude-sonnet-5",
  system: "Be brief",
  tools: [{ name: "bash", description: "Run a command" }],
  env: { CLAUDE_CODE_OAUTH_TOKEN: "placeholder" },
  ...extra,
});

const user = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});

/** A query driven by the test: `emit` produces its next message. */
function scriptedQuery() {
  const out: Array<IteratorResult<Record<string, any>> | Error> = [];
  const waiters: Array<() => void> = [];
  const push = (item: IteratorResult<Record<string, any>> | Error) => {
    out.push(item);
    waiters.shift()?.();
  };
  let closed = 0;
  const handle: ClaudeQueryHandle = {
    async next() {
      while (!out.length)
        await new Promise<void>((resolve) => waiters.push(resolve));
      const item = out.shift()!;
      if (item instanceof Error) throw item;
      return item;
    },
    close() {
      closed += 1;
      push({ value: undefined, done: true });
    },
  };
  return {
    handle,
    emit: (message: Record<string, any>) =>
      push({ value: message, done: false }),
    finish: () => push({ value: undefined, done: true }),
    fail: (message: string) => push(new Error(message)),
    closed: () => closed,
  };
}

let servers: ClaudeHostServer[] = [];
afterEach(() => {
  for (const server of servers) server.stop();
  servers = [];
});

function host(
  startQuery: (spec: ClaudeQuerySpec, io: ClaudeQueryIo) => ClaudeQueryHandle,
  options: {
    maxQueries?: number;
    prepare?: (id: string) => Promise<void>;
  } = {},
) {
  const server = startClaudeHostServer({
    hostname: "127.0.0.1",
    port: 0,
    token: TOKEN,
    maxQueries: options.maxQueries ?? 8,
    prepare: options.prepare,
    startQuery,
  });
  servers.push(server);
  return {
    server,
    endpoint: (token = TOKEN) =>
      Promise.resolve({ url: `ws://127.0.0.1:${server.port}`, token }),
  };
}

function clientIo(
  onToolCall: ClaudeQueryIo["onToolCall"] = async () => ({
    content: [{ type: "text", text: "unused" }],
  }),
) {
  const prompt = new ClaudeInputQueue();
  const abortController = new AbortController();
  return {
    prompt,
    abortController,
    io: { prompt, abortController, onToolCall },
  };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await Bun.sleep(5);
  }
}

describe("Claude host", () => {
  test("relays input, SDK messages and a client tool call in order", async () => {
    const script = scriptedQuery();
    const seen: { spec?: ClaudeQuerySpec; inputs: SDKUserMessage[] } = {
      inputs: [],
    };
    const prepared: string[] = [];
    const { endpoint } = host(
      (received, io) => {
        seen.spec = received;
        void (async () => {
          for await (const message of io.prompt) {
            seen.inputs.push(message);
            script.emit({ type: "assistant", text: "calling bash" });
            const reply = await io.onToolCall("toolu_1");
            script.emit({ type: "tool_reply", reply });
            script.emit({ type: "result", subtype: "success" });
          }
          script.finish();
        })();
        return script.handle;
      },
      {
        prepare: async (accountId) => {
          prepared.push(accountId);
        },
      },
    );
    const toolCalls: string[] = [];
    const client = clientIo(async (toolUseId) => {
      toolCalls.push(toolUseId);
      return { content: [{ type: "text", text: "a.txt" }] };
    });
    const query = startRemoteClaudeQuery(
      spec({ env: { CLAUDE_CODE_OAUTH_TOKEN: "placeholder", PATH: "/evil" } }),
      client.io,
      endpoint(),
    );
    client.prompt.push(user("list files"));

    expect((await query.next()).value).toEqual({
      type: "assistant",
      text: "calling bash",
    });
    expect((await query.next()).value).toEqual({
      type: "tool_reply",
      reply: { content: [{ type: "text", text: "a.txt" }] },
    });
    expect((await query.next()).value).toMatchObject({ type: "result" });
    expect(toolCalls).toEqual(["toolu_1"]);
    expect(prepared).toEqual(["account-a"]);
    expect(seen.inputs).toEqual([user("list files")]);
    expect(seen.spec).toMatchObject({
      accountId: "account-a",
      model: "claude-sonnet-5",
      system: "Be brief",
      tools: [{ name: "bash", description: "Run a command" }],
    });
    // Only allowlisted variables reach the Claude Code process.
    expect(seen.spec?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "placeholder" });

    // Ending the input ends the query, and the stream stays ended.
    client.prompt.close();
    expect(await query.next()).toEqual({ value: undefined, done: true });
    expect(await query.next()).toEqual({ value: undefined, done: true });
  });

  test("closing the client handle ends the process on the host", async () => {
    const script = scriptedQuery();
    let aborted = false;
    const { server, endpoint } = host((_spec, io) => {
      io.abortController.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return script.handle;
    });
    const client = clientIo();
    const query = startRemoteClaudeQuery(spec(), client.io, endpoint());
    script.emit({ type: "system", subtype: "init" });
    expect((await query.next()).value).toMatchObject({ type: "system" });
    expect(server.queries()).toBe(1);

    query.close();
    expect(await query.next()).toEqual({ value: undefined, done: true });
    await until(() => server.queries() === 0);
    expect(script.closed()).toBe(1);
    expect(aborted).toBe(true);
  });

  test("an abort on the client ends the query like a close", async () => {
    const script = scriptedQuery();
    const { server, endpoint } = host(() => script.handle);
    const client = clientIo();
    const query = startRemoteClaudeQuery(spec(), client.io, endpoint());
    script.emit({ type: "system", subtype: "init" });
    await query.next();
    client.abortController.abort();
    expect(await query.next()).toEqual({ value: undefined, done: true });
    await until(() => server.queries() === 0);
    expect(script.closed()).toBe(1);
  });

  test("a parked tool call is released when the client goes away", async () => {
    const script = scriptedQuery();
    let reply: unknown;
    const { server, endpoint } = host((_spec, io) => {
      void io.onToolCall("toolu_parked").then((value) => {
        reply = value;
      });
      return script.handle;
    });
    let asked = false;
    const client = clientIo(() => {
      asked = true;
      return new Promise(() => {});
    });
    const query = startRemoteClaudeQuery(spec(), client.io, endpoint());
    await until(() => asked);
    query.close();
    await until(() => server.queries() === 0);
    expect(reply).toMatchObject({ isError: true });
  });

  test("losing the host rejects the stream instead of hanging", async () => {
    const script = scriptedQuery();
    const { server, endpoint } = host(() => script.handle);
    const client = clientIo();
    const query = startRemoteClaudeQuery(spec(), client.io, endpoint());
    script.emit({ type: "system", subtype: "init" });
    await query.next();
    const pending = query.next();
    server.stop();
    await expect(pending).rejects.toThrow(/Lost the connection/);
    expect(script.closed()).toBe(1);
  });

  test("a failing query reaches the client as its error", async () => {
    const script = scriptedQuery();
    const { server, endpoint } = host(() => script.handle);
    const client = clientIo();
    const query = startRemoteClaudeQuery(spec(), client.io, endpoint());
    script.fail("Claude Code process exited with code 1");
    await expect(query.next()).rejects.toThrow(/exited with code 1/);
    await until(() => server.queries() === 0);
  });

  test("a wrong token or an absent host fails with what to do", async () => {
    const { endpoint } = host(() => scriptedQuery().handle);
    const refused = startRemoteClaudeQuery(
      spec(),
      clientIo().io,
      endpoint("wrong"),
    );
    await expect(refused.next()).rejects.toThrow(/Could not connect/);

    const absent = startRemoteClaudeQuery(
      spec(),
      clientIo().io,
      Promise.resolve({ url: "ws://127.0.0.1:1", token: TOKEN }),
    );
    await expect(absent.next()).rejects.toThrow(/anthropicTransport/);

    const noToken = startRemoteClaudeQuery(
      spec(),
      clientIo().io,
      Promise.reject(new Error("token file missing")),
    );
    await expect(noToken.next()).rejects.toThrow(/token file missing/);
  });

  test("refuses queries past its limit and frees the slot afterwards", async () => {
    const scripts = [scriptedQuery(), scriptedQuery(), scriptedQuery()];
    let started = 0;
    const { server, endpoint } = host(() => scripts[started++].handle, {
      maxQueries: 1,
    });
    const first = startRemoteClaudeQuery(spec(), clientIo().io, endpoint());
    scripts[0].emit({ type: "system" });
    await first.next();
    const second = startRemoteClaudeQuery(spec(), clientIo().io, endpoint());
    await expect(second.next()).rejects.toThrow(/limit of 1/);
    first.close();
    await until(() => server.queries() === 0);
    const third = startRemoteClaudeQuery(spec(), clientIo().io, endpoint());
    scripts[1].emit({ type: "system" });
    expect((await third.next()).value).toEqual({ type: "system" });
  });

  test("the probe and unknown paths need no token; queries do", async () => {
    const { server } = host(() => scriptedQuery().handle);
    const base = `http://127.0.0.1:${server.port}`;
    const live = await fetch(`${base}/live`);
    expect(await live.json()).toEqual({ ok: true, protocol: 1, queries: 0 });
    expect((await fetch(`${base}/v1/queries`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/v1/queries`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(426);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });
});

describe("Claude host protocol", () => {
  test("drops environment variables outside the allowlist", () => {
    expect(
      filterClaudeHostEnv({
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
        ANTHROPIC_API_KEY: "placeholder",
        DISABLE_COMPACT: "1",
        HOME: "/root",
        LD_PRELOAD: "/tmp/x.so",
        CLAUDE_CONFIG_DIR: "/elsewhere",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: 5 as unknown as string,
      }),
    ).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      ANTHROPIC_API_KEY: "placeholder",
      DISABLE_COMPACT: "1",
    });
  });

  test("ignores frames it cannot act on", () => {
    expect(parseClaudeHostClientFrame("not json")).toBeNull();
    expect(parseClaudeHostClientFrame('{"t":"start","id":"a"}')).toBeNull();
    expect(parseClaudeHostClientFrame('{"t":"close"}')).toBeNull();
    expect(parseClaudeHostClientFrame('{"t":"exec","id":"a"}')).toBeNull();
    expect(
      parseClaudeHostClientFrame('{"t":"tool_result","id":"a","toolUseId":1}'),
    ).toBeNull();
    expect(parseClaudeHostClientFrame('{"t":"close","id":"a"}')).toEqual({
      t: "close",
      id: "a",
    });
  });
});
