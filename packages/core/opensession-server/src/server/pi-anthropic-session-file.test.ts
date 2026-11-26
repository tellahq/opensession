/**
 * The pi Anthropic provider across "processes": a turn's SDK-session mapping
 * is written to the session's file, and a later turn that starts with empty
 * memory resumes that SDK session instead of replaying the conversation.
 * The Claude Agent SDK is replaced by a scripted query; nothing is spawned.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { AnthropicMessage } from "./anthropic-bridge";
import * as accounts from "./claude-accounts";
import {
  MAX_SDK_SESSION_FILE_ENTRIES,
  readSdkSessionEntries,
  writeSdkSessionEntry,
} from "./claude-sdk-session-file";
import { loadModelProviders } from "./model-providers";
import {
  buildPiAnthropicProvider,
  historyDigest,
  hydrateSdkSession,
  liveSdkConversations,
  piSdkSessionStore,
  rememberSdkTurn,
  splitSystemPrompt,
  type PiCatalogModel,
  type PiWireMessage,
} from "./pi-model-runtime";
import { loadPiConfig } from "./pi-config";

const dir = mkdtempSync(join(tmpdir(), "pi-anthropic-session-file-"));
const ENV = {
  OPENSESSION_PI_CONFIG: join(dir, "pi.json"),
  OPENSESSION_MODEL_PROVIDERS_CONFIG: join(dir, "model-providers.json"),
  OPENSESSION_CLAUDE_ACCOUNTS_PATH: join(dir, "accounts.json"),
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

const usage = (utilization: number) => ({
  fetchedAt: new Date().toISOString(),
  fiveHour: { utilization, resetsAt: null },
  sevenDay: null,
  extraUsage: null,
});

beforeAll(async () => {
  Object.assign(process.env, ENV);
  writeFileSync(ENV.OPENSESSION_PI_CONFIG, JSON.stringify({ enabled: true }));
  writeFileSync(
    ENV.OPENSESSION_MODEL_PROVIDERS_CONFIG,
    JSON.stringify({ enabled: true, bridgeAccountIds: ["acct-a", "acct-b"] }),
  );
  writeFileSync(
    ENV.OPENSESSION_CLAUDE_ACCOUNTS_PATH,
    JSON.stringify({
      accounts: ["acct-a", "acct-b"].map((id) => ({
        id,
        name: id,
        token: `sk-ant-oat01-${id}`,
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
    }),
  );
  await Promise.all([
    loadPiConfig(),
    loadModelProviders(),
    accounts.loadClaudeAccounts(),
  ]);
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Forget everything a process would lose when it exits. */
function newProcess(): void {
  for (const live of [...liveSdkConversations().values()]) {
    live.disposed = true;
    liveSdkConversations().delete(live.key);
  }
  piSdkSessionStore().clear();
}

interface FakeCall {
  resume?: string;
  token?: string;
  system?: string;
  prompts: unknown[];
}

/** A scripted Claude Code: each user message gets `respond`'s text, an
 *  error result, or (null) no answer at all. */
function fakeClaude(
  respond: (call: FakeCall) => { text: string } | { error: string } | null,
) {
  const calls: FakeCall[] = [];
  const spy = spyOn(sdk, "query").mockImplementation((input: any) => {
    const call: FakeCall = {
      resume: input.options.resume,
      token: input.options.env.CLAUDE_CODE_OAUTH_TOKEN,
      system: input.options.systemPrompt,
      prompts: [],
    };
    calls.push(call);
    const n = calls.length;
    const sessionId: string = input.options.resume ?? `sdk-${n}`;
    const out: Array<Record<string, any>> = [];
    const waiters: Array<() => void> = [];
    let closed = false;
    const emit = (message: Record<string, any>) => {
      out.push(message);
      waiters.shift()?.();
    };
    void (async () => {
      for await (const message of input.prompt) {
        call.prompts.push(message.message.content);
        const reply = respond(call);
        if (!reply) continue;
        emit({ type: "system", subtype: "init", session_id: sessionId });
        if ("error" in reply) {
          emit({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: [reply.error],
            session_id: sessionId,
          });
          continue;
        }
        const step = `${n}-${call.prompts.length}`;
        emit({
          type: "assistant",
          uuid: `asst-${step}`,
          session_id: sessionId,
          message: {
            id: `msg-${step}`,
            usage: { input_tokens: 1, output_tokens: 1 },
            content: [{ type: "text", text: reply.text }],
          },
        });
        emit({
          type: "result",
          subtype: "success",
          is_error: false,
          result: reply.text,
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: sessionId,
        });
      }
    })();
    return {
      async next() {
        while (!out.length && !closed)
          await new Promise<void>((resolve) => waiters.push(resolve));
        const value = out.shift();
        return value
          ? { value, done: false }
          : { value: undefined, done: true };
      },
      close() {
        closed = true;
        for (const wake of waiters.splice(0)) wake();
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    } as any;
  });
  return { calls, restore: () => spy.mockRestore() };
}

let restoreFake: (() => void) | undefined;
afterEach(() => {
  restoreFake?.();
  restoreFake = undefined;
  newProcess();
});

function session(
  head: Record<string, unknown> = { role: "system", content: "Base prompt" },
) {
  const sessionId = `sess-${crypto.randomUUID()}`;
  const file = join(dir, `${sessionId}.json`);
  const run = async (messages: unknown[], signal?: AbortSignal) => {
    // A provider per turn, as each run builds its own.
    const provider = buildPiAnthropicProvider({
      unifiedSessionId: sessionId,
      builtinModels: [model],
      sdkSessionFile: file,
    }) as any;
    const events: any[] = [];
    for await (const event of provider.streamSimple(
      model,
      { messages: [head, ...messages] },
      { sessionId, signal },
    ))
      events.push(event);
    return events;
  };
  const stored = (): Record<string, any>[] =>
    Object.values(JSON.parse(readFileSync(file, "utf8")).entries);
  return { file, run, stored };
}

const done = (events: any[]) => events.find((e) => e.type === "done")?.message;

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await Bun.sleep(5);
  }
}

describe("SDK session mapping across processes", () => {
  test("the next turn's process resumes the session on the account that holds it", async () => {
    const fake = fakeClaude((call) => ({
      text: `answer ${call.prompts.length}`,
    }));
    restoreFake = fake.restore;
    accounts.__setUsageCacheForTest("acct-a", usage(10));
    accounts.__setUsageCacheForTest("acct-b", usage(50));
    const s = session();

    const first = { role: "user", content: "first question" };
    const reply1 = done(await s.run([first]));
    expect(reply1.content).toEqual([{ type: "text", text: "answer 1" }]);
    expect(fake.calls[0]).toMatchObject({
      resume: undefined,
      token: "sk-ant-oat01-acct-a",
    });
    expect(s.stored()).toEqual([
      expect.objectContaining({
        sdkSessionId: "sdk-1",
        accountId: "acct-a",
        messageCount: 2,
        historyDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);

    // The other account now has more room; the session still stays put.
    newProcess();
    accounts.__setUsageCacheForTest("acct-a", usage(60));
    accounts.__setUsageCacheForTest("acct-b", usage(5));
    const second = { role: "user", content: "what next?" };
    const reply2 = done(await s.run([first, reply1, second]));
    expect(reply2.content).toEqual([{ type: "text", text: "answer 1" }]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]).toMatchObject({
      resume: "sdk-1",
      token: "sk-ant-oat01-acct-a",
    });
    // Only the new message is sent; the session already holds the rest.
    expect(fake.calls[1].prompts).toEqual(["what next?"]);
    expect(s.stored()).toEqual([
      expect.objectContaining({ sdkSessionId: "sdk-1", messageCount: 4 }),
    ]);

    // And again, from the file the second process wrote.
    newProcess();
    const third = { role: "user", content: "and then?" };
    await s.run([first, reply1, second, reply2, third]);
    expect(fake.calls[2]).toMatchObject({ resume: "sdk-1" });
    expect(fake.calls[2].prompts).toEqual(["and then?"]);
  });

  test("a changed history replays instead of resuming", async () => {
    const fake = fakeClaude(() => ({ text: "ok" }));
    restoreFake = fake.restore;
    accounts.__setUsageCacheForTest("acct-a", usage(10));
    accounts.__setUsageCacheForTest("acct-b", usage(50));
    const s = session();
    const first = { role: "user", content: "first question" };
    const reply1 = done(await s.run([first]));

    newProcess();
    const edited = { role: "user", content: "a different first question" };
    await s.run([edited, reply1, { role: "user", content: "what next?" }]);
    expect(fake.calls[1].resume).toBeUndefined();
    expect(String(fake.calls[1].prompts[0])).toContain(
      "a different first question",
    );
    // The file now describes the replayed conversation.
    expect(s.stored()).toEqual([
      expect.objectContaining({ sdkSessionId: "sdk-2", messageCount: 4 }),
    ]);
  });

  test("a stored session that cannot be resumed is replayed once, not failed", async () => {
    const fake = fakeClaude((call) =>
      call.resume
        ? { error: "No conversation found with session ID" }
        : { text: "recovered" },
    );
    restoreFake = fake.restore;
    accounts.__setUsageCacheForTest("acct-a", usage(10));
    accounts.__setUsageCacheForTest("acct-b", usage(50));
    const s = session();
    const first = { role: "user", content: "first question" };
    const reply1 = done(await s.run([first]));

    newProcess();
    const events = await s.run([
      first,
      reply1,
      { role: "user", content: "what next?" },
    ]);
    expect(done(events)?.content).toEqual([
      { type: "text", text: "recovered" },
    ]);
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(fake.calls.map((call) => call.resume)).toEqual([
      undefined,
      "sdk-1",
      undefined,
    ]);
    // The retry is the full replay, on the same account.
    expect(String(fake.calls[2].prompts[0])).toContain("first question");
    expect(fake.calls[2].token).toBe("sk-ant-oat01-acct-a");
    expect(s.stored()).toEqual([
      expect.objectContaining({ sdkSessionId: "sdk-3" }),
    ]);
  });

  test("a canceled turn removes the mapping", async () => {
    const fake = fakeClaude((call) =>
      call.resume ? null : { text: "answer" },
    );
    restoreFake = fake.restore;
    accounts.__setUsageCacheForTest("acct-a", usage(10));
    accounts.__setUsageCacheForTest("acct-b", usage(50));
    const s = session();
    const first = { role: "user", content: "first question" };
    const reply1 = done(await s.run([first]));
    expect(s.stored()).toHaveLength(1);

    newProcess();
    const cancel = new AbortController();
    const turn = s.run(
      [first, reply1, { role: "user", content: "what next?" }],
      cancel.signal,
    );
    await until(() => fake.calls[1]?.prompts.length === 1);
    cancel.abort();
    expect((await turn).at(-1)).toMatchObject({
      type: "error",
      reason: "aborted",
    });
    expect(s.stored()).toEqual([]);
  });

  test("a process killed mid-step leaves nothing to resume", async () => {
    const fake = fakeClaude((call) =>
      call.resume ? null : { text: "answer" },
    );
    restoreFake = fake.restore;
    accounts.__setUsageCacheForTest("acct-a", usage(10));
    accounts.__setUsageCacheForTest("acct-b", usage(50));
    const s = session();
    const first = { role: "user", content: "first question" };
    const reply1 = done(await s.run([first]));
    expect(s.stored()).toHaveLength(1);

    newProcess();
    const cancel = new AbortController();
    const turn = s.run(
      [first, reply1, { role: "user", content: "what next?" }],
      cancel.signal,
    );
    // The resumed session has the new message and has not answered: the
    // file must already be empty, as a killed process could not empty it.
    await until(() => fake.calls[1]?.prompts.length === 1);
    expect(s.stored()).toEqual([]);
    cancel.abort();
    await turn;
  });

  test("a changed model, prompt or tool set is reported and replays", async () => {
    const fake = fakeClaude(() => ({ text: "ok" }));
    restoreFake = fake.restore;
    accounts.__setUsageCacheForTest("acct-a", usage(10));
    accounts.__setUsageCacheForTest("acct-b", usage(50));
    const s = session();
    const first = { role: "user", content: "first question" };
    const reply1 = done(await s.run([first]));
    const [key] = Object.keys(JSON.parse(readFileSync(s.file, "utf8")).entries);

    newProcess();
    const otherConfig = `${key.slice(0, key.lastIndexOf(":"))}:other`;
    expect(await hydrateSdkSession(s.file, otherConfig, [])).toBe(
      "config_changed",
    );
    expect(
      await hydrateSdkSession(s.file, "pi:someone-else:other", []),
    ).toBeUndefined();
    expect(piSdkSessionStore().size).toBe(0);
    void reply1;
  });

  test("without a session file nothing is written and nothing resumes", async () => {
    const fake = fakeClaude(() => ({ text: "ok" }));
    restoreFake = fake.restore;
    accounts.__setUsageCacheForTest("acct-a", usage(10));
    accounts.__setUsageCacheForTest("acct-b", usage(50));
    const sessionId = `sess-${crypto.randomUUID()}`;
    const run = async (messages: unknown[]) => {
      const provider = buildPiAnthropicProvider({
        unifiedSessionId: sessionId,
        builtinModels: [model],
      }) as any;
      const events: any[] = [];
      for await (const event of provider.streamSimple(
        model,
        { messages },
        { sessionId },
      ))
        events.push(event);
      return events;
    };
    const first = { role: "user", content: "first question" };
    const reply1 = done(await run([first]));
    expect(
      [...piSdkSessionStore().values()].map((state) => state.historyDigest),
    ).toEqual([undefined]);
    newProcess();
    await run([first, reply1, { role: "user", content: "what next?" }]);
    expect(fake.calls[1].resume).toBeUndefined();
  });
});

// Pi's prompt as it records it: the instructions bare, every other section
// wrapped in a tag of its name.
const promptSections = (parts: {
  instructions: string[];
  skills: string[];
  cwd?: string;
}) => ({
  preamble: parts.instructions.join("\n\n"),
  skills: `<skills>\n${parts.skills
    .map((path) => `  <location>${path}</location>`)
    .join("\n")}\n</skills>`,
  cwd: `<cwd>\n${parts.cwd ?? "/work/checkout"}\n</cwd>`,
});

const INSTRUCTIONS = [
  "## Finish your turns\nLead with the outcome.",
  "## Memory\n- `/scratch/memory/user-a`: A's personal memory (the person prompting)\n- `/scratch/memory/user-b`: B's personal memory",
  "## Tools\n- `sessions`: start sessions.\n- `portals`: start services.",
];

describe("the system prompt across a conversation's turns", () => {
  // The guard against a whole class of regressions: whatever makes pi's
  // prompt differ from one turn to the next (who prompts, a memory edit, a
  // deploy that moves the shipped skills, a tool added to the guidance), the
  // SDK must get the same system prompt and keep its session. A new source
  // of change costs a note in the conversation, never the prompt cache.
  test("a prompt that changed between turns is the same system prompt and the same SDK session", async () => {
    const fake = fakeClaude((call) => ({
      text: `answer ${call.prompts.length}`,
    }));
    restoreFake = fake.restore;
    accounts.__setUsageCacheForTest("acct-a", usage(10));
    accounts.__setUsageCacheForTest("acct-b", usage(50));
    const started = promptSections({
      instructions: INSTRUCTIONS,
      skills: ["/releases/aaa/skills/simplify/SKILL.md"],
    });
    const s = session({ role: "system", content: "", sections: started });

    const first = { role: "user", content: "first question" };
    const reply1 = done(await s.run([first]));
    const system = fake.calls[0].system;
    expect(system).toContain("## Finish your turns");
    expect(system).toContain("/releases/aaa/skills/simplify/SKILL.md");

    // Next turn, from a new process: another person prompts, the memory
    // folders are listed in another order, a tool joined the guidance, a
    // deploy moved the shipped skills, and the checkout moved.
    newProcess();
    const later = promptSections({
      instructions: [
        INSTRUCTIONS[0],
        "## Memory\n- `/scratch/memory/user-b`: B's personal memory (the person prompting)\n- `/scratch/memory/user-a`: A's personal memory",
        `${INSTRUCTIONS[2]}\n- \`keychain\`: borrow a credential.`,
      ],
      skills: ["/releases/bbb/skills/simplify/SKILL.md"],
      cwd: "/work/elsewhere",
    });
    const change1 = { role: "system", content: "", sections: later };
    const second = { role: "user", content: "what next?" };
    const reply2 = done(await s.run([first, reply1, change1, second]));
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].resume).toBe("sdk-1");
    expect(fake.calls[1].system).toBe(system);
    const sent = String(fake.calls[1].prompts[0]);
    expect(sent).toContain("what next?");
    expect(sent).toContain("- `keychain`: borrow a credential.");
    expect(sent).toContain("/releases/bbb/skills/simplify/SKILL.md");
    expect(sent).toContain("/work/elsewhere");
    // Only what changed is sent, not the prompt again.
    expect(sent).not.toContain("Lead with the outcome.");
    expect(sent).not.toContain("- `sessions`: start sessions.");

    // And a third turn, with the earlier change now behind it and one more
    // section dropped.
    newProcess();
    const change2 = { role: "system", content: "", sections: { skills: null } };
    const third = { role: "user", content: "and then?" };
    await s.run([first, reply1, change1, second, reply2, change2, third]);
    expect(fake.calls[2].resume).toBe("sdk-1");
    expect(fake.calls[2].system).toBe(system);
    const sentThird = String(fake.calls[2].prompts[0]);
    expect(sentThird).toContain(
      "<skills> part of your system prompt was removed",
    );
    expect(sentThird).not.toContain("keychain");
  });

  test("a change mid-turn keeps the system prompt too", async () => {
    const fake = fakeClaude(() => ({ text: "ok" }));
    restoreFake = fake.restore;
    accounts.__setUsageCacheForTest("acct-a", usage(10));
    accounts.__setUsageCacheForTest("acct-b", usage(50));
    const s = session();
    const first = { role: "user", content: "first question" };
    const reply1 = done(await s.run([first]));
    // Same process: the conversation is still live.
    await s.run([
      first,
      reply1,
      { role: "system", content: "Answer in French." },
      { role: "user", content: "what next?" },
    ]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].system).toBe("Base prompt");
    expect(String(fake.calls[0].prompts[1])).toContain("Answer in French.");
  });
});

describe("splitSystemPrompt", () => {
  const user = (content: string): PiWireMessage => ({ role: "user", content });
  const system = (
    sections: Record<string, string | null>,
    content = "",
  ): PiWireMessage => ({ role: "system", content, sections });
  const notes = (messages: PiWireMessage[]) =>
    splitSystemPrompt(messages)
      .messages.filter(
        (m) =>
          typeof m.content === "string" &&
          m.content.startsWith("<system-reminder>"),
      )
      .map((m) => String(m.content));

  test("the system prompt is the leading message, whatever follows", () => {
    const head = system({ preamble: "Be brief.", cwd: "<cwd>\n/a\n</cwd>" });
    const alone = splitSystemPrompt([head, user("hi")]);
    expect(alone).toEqual({
      system: "Be brief.\n\n<cwd>\n/a\n</cwd>",
      messages: [user("hi")],
      updates: 0,
    });
    const changed = splitSystemPrompt([
      head,
      user("hi"),
      system({ preamble: "Be thorough.", cwd: null }, "And kind."),
      user("again"),
    ]);
    expect(changed.system).toBe(alone.system);
    expect(changed.updates).toBe(1);
    expect(changed.messages.map((m) => m.role)).toEqual([
      "user",
      "user",
      "user",
    ]);
  });

  test("the leading prompt is rendered the way pi renders it", () => {
    const transcript = [
      { ...system({ preamble: "Be brief." }, "First."), timestamp: 1 },
      {
        ...system({ cwd: "<cwd>\n/a\n</cwd>", preamble: "Be kind." }, "More."),
        timestamp: 2,
      },
      user("hi"),
    ];
    expect(splitSystemPrompt(transcript).system).toBe(
      getCurrentSystemPrompt(transcript as never),
    );
  });

  test("a changed section is sent as its changed lines", () => {
    const before = ["## Tools", "- a: one", "- b: two", "- c: three"];
    const [note] = notes([
      system({ preamble: before.join("\n") }),
      user("hi"),
      system({
        preamble: ["## Tools", "- a: one", "- c: three", "- d: four"].join(
          "\n",
        ),
      }),
    ]);
    expect(note).toContain(
      "In the opening part of your system prompt, these lines were removed:\n- b: two",
    );
    expect(note).toContain("these lines were added:\n- d: four");
    expect(note).not.toContain("- a: one");
  });

  test("each change is described against the one before it", () => {
    const all = notes([
      system({ preamble: "## Tools\n- a\n- b\n- c\n- d" }),
      user("hi"),
      system({ preamble: "## Tools\n- a\n- b\n- c\n- d\n- e" }),
      user("again"),
      system({ preamble: "## Tools\n- a\n- b\n- c\n- d" }),
    ]);
    expect(all).toHaveLength(2);
    expect(all[0]).toContain("these lines were added:\n- e");
    expect(all[1]).toContain("these lines were removed:\n- e");
  });

  test("lines in another order say nothing", () => {
    const split = splitSystemPrompt([
      system({ preamble: "- a\n- b\n\n- c" }),
      user("hi"),
      system({ preamble: "- c\n- a\n- b" }),
      user("again"),
    ]);
    expect(split.updates).toBe(0);
    expect(split.messages).toEqual([user("hi"), user("again")]);
  });

  test("a section that is mostly new is sent whole, and a long dropped line is cut", () => {
    const long = `- ${"x".repeat(400)}`;
    const [rewritten, trimmed] = notes([
      system({
        preamble: `intro\n${long}`,
        skills: "<skills>\nold\n</skills>",
      }),
      user("hi"),
      system({
        skills: "<skills>\nnew one, at length\nnew two, at length\n</skills>",
      }),
      user("again"),
      system({ preamble: "intro\n- short" }),
    ]);
    expect(rewritten).toContain(
      "The <skills> part of your system prompt now reads:\n\n<skills>\nnew one, at length\nnew two, at length\n</skills>",
    );
    expect(trimmed).toContain(`- ${"x".repeat(198)}…`);
    expect(trimmed).not.toContain("x".repeat(250));
  });

  test("new and dropped sections, and plain added text", () => {
    const [note] = notes([
      system({ preamble: "Be brief.", cwd: "<cwd>\n/a\n</cwd>" }),
      user("hi"),
      system(
        { cwd: null, skills: "<skills>\none\n</skills>" },
        "Answer in French.",
      ),
    ]);
    expect(note).toContain("Added to your system prompt:\n\nAnswer in French.");
    expect(note).toContain("The <cwd> part of your system prompt was removed.");
    expect(note).toContain(
      "New <skills> part of your system prompt:\n\n<skills>\none\n</skills>",
    );
  });

  test("a transcript older than its first system message starts the prompt there", () => {
    const split = splitSystemPrompt([
      user("old"),
      system({ preamble: "Be brief." }),
      user("new"),
      { role: "system", content: "", toolsAdded: [{ name: "read" }] },
    ]);
    expect(split).toEqual({
      system: "Be brief.",
      messages: [user("old"), user("new")],
      updates: 0,
    });
    expect(splitSystemPrompt([user("only")])).toEqual({
      system: "",
      messages: [user("only")],
      updates: 0,
    });
  });
});

describe("hydrateSdkSession", () => {
  const user = (text: string): AnthropicMessage =>
    ({ role: "user", content: text }) as AnthropicMessage;
  const assistant = (text: string): AnthropicMessage =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
    }) as AnthropicMessage;
  const history = [user("one"), assistant("two"), user("three")];

  async function seed(messages: AnthropicMessage[]) {
    const file = join(dir, `hydrate-${crypto.randomUUID()}.json`);
    const state = rememberSdkTurn(
      "key",
      "sdk-x",
      messages.length,
      "acct-a",
      undefined,
      messages,
    );
    await writeSdkSessionEntry(file, "key", state);
    piSdkSessionStore().clear();
    return file;
  }

  test("accepts a history that extends what the session has seen", async () => {
    const file = await seed(history);
    const next = [...history, assistant("four"), user("five")];
    expect(await hydrateSdkSession(file, "key", next)).toBe("resumable");
    expect(piSdkSessionStore().get("key")).toMatchObject({
      sdkSessionId: "sdk-x",
      accountId: "acct-a",
      messageCount: 4,
    });
  });

  test("rejects anything else and leaves the mapping empty", async () => {
    const file = await seed(history);
    const cases: AnthropicMessage[][] = [
      // An earlier message was edited.
      [user("ONE"), assistant("two"), user("three"), assistant("4"), user("5")],
      // Nothing new since the session's last reply.
      [...history, assistant("four")],
      // The history shrank (a compaction).
      [user("summary"), user("five")],
      // No reply where the session's last one belongs.
      [...history, user("four"), user("five")],
    ];
    for (const messages of cases) {
      expect(await hydrateSdkSession(file, "key", messages)).toBe(
        "history_changed",
      );
      expect(piSdkSessionStore().has("key")).toBe(false);
    }
    expect(await hydrateSdkSession(file, "other-key", history)).toBeUndefined();
    await writeSdkSessionEntry(file, "bad", {
      lastUsedAt: 1,
      sdkSessionId: 7,
    } as any);
    expect(await hydrateSdkSession(file, "bad", history)).toBe("invalid_entry");
  });

  test("a digest continued step by step equals one computed at once", () => {
    const messages = [...history, assistant("four"), user("five")];
    const whole = historyDigest(messages, 5);
    const stepped = historyDigest(messages, 5, 3, historyDigest(messages, 3));
    expect(stepped).toBe(whole);
    expect(historyDigest(messages, 4)).not.toBe(whole);
    expect(historyDigest(messages, 0)).toBe("");
  });
});

describe("SDK session file", () => {
  test("keeps the newest entries, removes on null, and survives a bad file", async () => {
    const file = join(dir, `file-${crypto.randomUUID()}.json`);
    expect((await readSdkSessionEntries(file))["a"]).toBeUndefined();
    // Queued in call order without awaiting each one.
    const total = MAX_SDK_SESSION_FILE_ENTRIES + 2;
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        writeSdkSessionEntry(file, `k${i}`, { lastUsedAt: i, n: i } as any),
      ),
    );
    const entries = JSON.parse(readFileSync(file, "utf8")).entries;
    expect(Object.keys(entries).sort()).toEqual(
      Array.from(
        { length: MAX_SDK_SESSION_FILE_ENTRIES },
        (_, i) => `k${i + 2}`,
      ),
    );
    expect((await readSdkSessionEntries(file))["k0"]).toBeUndefined();
    expect((await readSdkSessionEntries(file))[`k${total - 1}`]).toEqual({
      lastUsedAt: total - 1,
      n: total - 1,
    });
    await writeSdkSessionEntry(file, `k${total - 1}`, null);
    expect(
      (await readSdkSessionEntries(file))[`k${total - 1}`],
    ).toBeUndefined();

    writeFileSync(file, "{ not json");
    expect((await readSdkSessionEntries(file))["k3"]).toBeUndefined();
    await writeSdkSessionEntry(file, "fresh", { lastUsedAt: 1 });
    expect((await readSdkSessionEntries(file))["fresh"]).toEqual({
      lastUsedAt: 1,
    });
  });
});
