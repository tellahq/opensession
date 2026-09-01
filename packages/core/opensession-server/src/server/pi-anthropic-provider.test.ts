/**
 * pi-anthropic-provider tests: the hermetic pieces only — SDK-session
 * continuation/divergence planning and store pruning, pi→Anthropic-wire
 * message conversion (+ its integration with the bridge's flatten/replay
 * helpers), the capture-block wording contract, catalog carry-through,
 * usage/cost math, provider build gating on the bridge designation, the
 * pre-SDK stream failure paths (account pick, pre-aborted signal), and the
 * pickBridgeAccount pin semantics shared with the bridge — every case checked
 * against isPiUsageLimitShape so the runner's fallback walk keys correctly.
 * Config/store seams point at throwaway files; nothing reads live state and
 * nothing spawns the SDK. The real SDK turn (token streaming, capture hook,
 * resume) needs the live smoke: POST /api/admin/pi-smoke with
 * anthropicTransport left at its "inprocess" default.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MAX_PI_SDK_SESSIONS,
  PI_PASSTHROUGH_BLOCK_REASON,
  buildPiAnthropicModels,
  buildPiAnthropicProvider,
  IMAGE_ONLY_PROMPT,
  MAX_TURN_IMAGES,
  piImageBlockToAnthropic,
  piMessagesToAnthropic,
  piSdkSessionStore,
  planSdkTurn,
  sdkPromptContent,
  turnImages,
  rememberSdkTurn,
  shouldDeferClaudeText,
  usageFromSdkResult,
  type PiCatalogModel,
  type PiWireMessage,
} from "./pi-anthropic-provider";
import {
  createEarlyStopTracker,
  noteAssistantMessage,
  noteUserContent,
  shouldEarlyStop,
} from "./meridian-passthrough";
import {
  admitBridgeRequest,
  ensureAnthropicBridgeCwd,
  flattenMessageText,
  pickBridgeAccount,
  replayConversation,
  type AnthropicMessage,
} from "./anthropic-bridge";
import { isPiUsageLimitShape } from "./pi-runner";
import * as accounts from "./claude-accounts";

// Seam everything at a throwaway dir. The config/store modules read their env
// seams per call, so setting them here (after hoisted imports) is safe — and
// they are restored in afterAll so later test files see the originals.
const dir = mkdtempSync(join(tmpdir(), "pi-anthropic-provider-"));
const piConfigFile = join(dir, "pi.json");
const providerConfigFile = join(dir, "model-providers.json");
const accountsFile = join(dir, "accounts.json");
const savedEnv = {
  pi: process.env.OPENSESSION_PI_CONFIG,
  oc: process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG,
  accounts: process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH,
};

beforeAll(() => {
  process.env.OPENSESSION_PI_CONFIG = piConfigFile;
  process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = providerConfigFile;
  process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = accountsFile;
});

afterAll(() => {
  for (const [envKey, value] of [
    ["OPENSESSION_PI_CONFIG", savedEnv.pi],
    ["OPENSESSION_MODEL_PROVIDERS_CONFIG", savedEnv.oc],
    ["OPENSESSION_CLAUDE_ACCOUNTS_PATH", savedEnv.accounts],
  ] as const) {
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Configure the pick mode: null = everything disabled; [] = pi enabled with
 *  no designation (pool mode — the default in production); a non-empty list
 *  designates accounts through pi's bridgeAccountIds, the only
 *  designation path left (pi's own bridgeAccounts field is retired). */
function designate(bridgeAccountIds: string[] | null): void {
  if (bridgeAccountIds === null) {
    writeFileSync(piConfigFile, JSON.stringify({ enabled: false }));
    rmSync(providerConfigFile, { force: true });
    return;
  }
  writeFileSync(piConfigFile, JSON.stringify({ enabled: true }));
  if (bridgeAccountIds.length) {
    writeFileSync(
      providerConfigFile,
      JSON.stringify({ enabled: true, bridgeAccountIds }),
    );
  } else {
    rmSync(providerConfigFile, { force: true });
  }
}

function seedAccounts(
  entries: Array<string | { id: string; owner?: string }>,
): void {
  writeFileSync(
    accountsFile,
    JSON.stringify({
      accounts: entries.map((e) => {
        const { id, owner } =
          typeof e === "string" ? { id: e, owner: undefined } : e;
        return {
          id,
          name: id,
          token: `sk-ant-oat01-${id}`,
          createdAt: "2026-01-01T00:00:00.000Z",
          ...(owner ? { owner } : {}),
        };
      }),
    }),
  );
}

const freshUsage = {
  fetchedAt: new Date().toISOString(),
  fiveHour: { utilization: 10, resetsAt: null },
  sevenDay: null,
  extraUsage: null,
};
const maxedUsage = {
  ...freshUsage,
  fiveHour: { utilization: 100, resetsAt: null },
};

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

const wire = (
  m: Partial<AnthropicMessage> & { role: "user" | "assistant" },
): AnthropicMessage => ({ content: "", ...m }) as AnthropicMessage;

describe("Meridian source dependency", () => {
  test("tracks the same release as the published package", () => {
    const dependencyRoot = join(
      import.meta.dir,
      "../../../../../node_modules/@rynfar",
    );
    const published = JSON.parse(
      readFileSync(join(dependencyRoot, "meridian/package.json"), "utf8"),
    );
    const source = JSON.parse(
      readFileSync(
        join(dependencyRoot, "meridian-source/package.json"),
        "utf8",
      ),
    );
    expect(source.version).toBe(published.version);
  });
});

describe("ensureAnthropicBridgeCwd", () => {
  test("creates a missing SDK cwd and is idempotent", () => {
    const cwd = join(dir, "missing-state", "bridge-cwd");
    expect(existsSync(cwd)).toBe(false);

    expect(ensureAnthropicBridgeCwd(cwd)).toBe(cwd);
    expect(ensureAnthropicBridgeCwd(cwd)).toBe(cwd);
    expect(statSync(cwd).isDirectory()).toBe(true);
  });

  test("recreates the SDK cwd after its state tree is removed", () => {
    const root = join(dir, "removed-state");
    const cwd = ensureAnthropicBridgeCwd(join(root, "bridge-cwd"));
    rmSync(root, { recursive: true, force: true });

    expect(existsSync(cwd)).toBe(false);
    expect(ensureAnthropicBridgeCwd(cwd)).toBe(cwd);
    expect(statSync(cwd).isDirectory()).toBe(true);
  });

  test("preserves the filesystem error when the cwd path is invalid", () => {
    const cwd = join(dir, "cwd-is-a-file");
    writeFileSync(cwd, "not a directory");

    expect(() => ensureAnthropicBridgeCwd(cwd)).toThrow();
  });
});

describe("planSdkTurn (continuation vs replay)", () => {
  const messages: AnthropicMessage[] = [
    wire({ role: "user", content: "first question" }),
    wire({
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
    }),
    wire({ role: "user", content: "second question" }),
  ];

  test("no stored session → fresh full replay", () => {
    const plan = planSdkTurn(undefined, messages);
    expect(plan.continuation).toBe(false);
    expect(plan.resume).toBeUndefined();
    expect(plan.prompt).toContain("first question");
    expect(plan.prompt).toContain("second question");
    expect(plan.prompt).toContain("[Your previous reply]");
  });

  test("history strictly grew → resume with only the new tail", () => {
    const plan = planSdkTurn(
      {
        sdkSessionId: "sdk-1",
        messageCount: 2,
        accountId: "acc-1",
        lastUsedAt: Date.now(),
      },
      messages,
    );
    expect(plan.continuation).toBe(true);
    expect(plan.resume).toBe("sdk-1");
    expect(plan.prompt).toBe("second question");
    expect(plan.prompt).not.toContain("first question");
  });

  test("same-length history (retry of a seen turn) → fresh replay, not resume", () => {
    const plan = planSdkTurn(
      {
        sdkSessionId: "sdk-1",
        messageCount: 3,
        accountId: "acc-1",
        lastUsedAt: Date.now(),
      },
      messages,
    );
    expect(plan.continuation).toBe(false);
    expect(plan.resume).toBeUndefined();
    expect(plan.prompt).toContain("first question");
  });

  test("shrunk history (edit/compaction divergence) → fresh replay", () => {
    const plan = planSdkTurn(
      {
        sdkSessionId: "sdk-1",
        messageCount: 9,
        accountId: "acc-1",
        lastUsedAt: Date.now(),
      },
      messages,
    );
    expect(plan.continuation).toBe(false);
    expect(plan.resume).toBeUndefined();
  });

  test("checkpointed turn resumes at its assistant UUID with exact structured results", () => {
    const tail: AnthropicMessage[] = [
      wire({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "A" }],
      }),
      wire({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-2", content: "B" }],
      }),
    ];
    const plan = planSdkTurn(
      {
        sdkSessionId: "sdk-1",
        messageCount: 2,
        accountId: "acc-1",
        passthroughToolCallAssistantUuid: "assistant-uuid",
        passthroughToolCallIds: ["tool-1", "tool-2"],
        lastUsedAt: Date.now(),
      },
      [messages[0], messages[1], ...tail],
    );
    expect(plan.continuation).toBe(true);
    expect(plan.resume).toBe("sdk-1");
    expect(plan.resumeSessionAt).toBe("assistant-uuid");
    expect(plan.prompt).toBe("");
    expect(plan.toolResults).toEqual([
      { type: "tool_result", tool_use_id: "tool-1", content: "A" },
      { type: "tool_result", tool_use_id: "tool-2", content: "B" },
    ]);
  });

  test("checkpoint mismatch full-replays instead of resuming the hidden digest tail", () => {
    const partial = [
      wire({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "A" }],
      }),
    ];
    const plan = planSdkTurn(
      {
        sdkSessionId: "sdk-1",
        messageCount: 2,
        accountId: "acc-1",
        passthroughToolCallAssistantUuid: "assistant-uuid",
        passthroughToolCallIds: ["tool-1", "tool-2"],
        lastUsedAt: Date.now(),
      },
      [messages[0], messages[1], ...partial],
    );
    expect(plan.continuation).toBe(false);
    expect(plan.resume).toBeUndefined();
    expect(plan.resumeSessionAt).toBeUndefined();
    expect(plan.prompt).toContain("A");
  });
});

describe("SDK session store", () => {
  afterEach(() => piSdkSessionStore().clear());

  test("rememberSdkTurn stores messageCount + 1 and its durable checkpoint", () => {
    rememberSdkTurn("pi:s1", "sdk-abc", 4, "acc-1", {
      assistantUuid: "assistant-uuid",
      toolCallIds: ["tool-1"],
    });
    expect(piSdkSessionStore().get("pi:s1")).toMatchObject({
      sdkSessionId: "sdk-abc",
      messageCount: 5,
      accountId: "acc-1",
      passthroughToolCallAssistantUuid: "assistant-uuid",
      passthroughToolCallIds: ["tool-1"],
    });
  });

  test("prunes the oldest entries past the cap", () => {
    const store = piSdkSessionStore();
    for (let i = 0; i < MAX_PI_SDK_SESSIONS; i++) {
      store.set(`pi:old-${i}`, {
        sdkSessionId: `sdk-${i}`,
        messageCount: 1,
        accountId: "acc-1",
        lastUsedAt: i,
      });
    }
    rememberSdkTurn("pi:newest", "sdk-new", 1, "acc-1");
    expect(store.size).toBe(MAX_PI_SDK_SESSIONS);
    expect(store.has("pi:old-0")).toBe(false);
    expect(store.has("pi:newest")).toBe(true);
    expect(store.has(`pi:old-${MAX_PI_SDK_SESSIONS - 1}`)).toBe(true);
  });
});

describe("piMessagesToAnthropic", () => {
  test("maps the three pi roles onto the bridge's wire shape", () => {
    const messages: PiWireMessage[] = [
      { role: "user", content: "plain string" },
      {
        role: "user",
        content: [
          { type: "text", text: "with attachment" },
          { type: "image", data: "…base64…", mimeType: "image/png" },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "secret reasoning",
            thinkingSignature: "sig",
          },
          { type: "text", text: "I'll check that file" },
          {
            type: "toolCall",
            id: "tc-1",
            name: "read",
            arguments: { path: "a.ts" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tc-1",
        content: [{ type: "text", text: "file contents here" }],
      },
    ];
    expect(piMessagesToAnthropic(messages)).toEqual([
      { role: "user", content: "plain string" },
      // Images are KEPT: planSdkTurn lifts them onto the turn as real content
      // blocks. Dropping them here was silent data loss.
      {
        role: "user",
        content: [
          { type: "text", text: "with attachment" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "…base64…",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          // Thinking dropped: signatures cannot round-trip.
          { type: "text", text: "I'll check that file" },
          {
            type: "tool_use",
            id: "tc-1",
            name: "read",
            input: { path: "a.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tc-1",
            content: [{ type: "text", text: "file contents here" }],
          },
        ],
      },
    ]);
  });

  test("bridge flatten/replay reads the converted shapes (tool results unwrap raw)", () => {
    const converted = piMessagesToAnthropic([
      {
        role: "toolResult",
        toolCallId: "tc-9",
        content: [{ type: "text", text: "42 matches" }],
      },
    ]);
    expect(flattenMessageText(converted[0].content)).toBe("42 matches");
    const replay = replayConversation(
      piMessagesToAnthropic([
        { role: "user", content: "count them" },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "t1",
              name: "grep",
              arguments: { pattern: "x" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "t1",
          content: [{ type: "text", text: "42 matches" }],
        },
      ]),
    );
    expect(replay).toContain("count them");
    expect(replay).toContain('[called tool grep with {"pattern":"x"}]');
    expect(replay).toContain("42 matches");
    expect(replay).not.toContain("tool_result");
  });
});

describe("images survive the turn", () => {
  const img = (mimeType: string, data = "AAAA") => ({
    type: "image",
    data,
    mimeType,
  });

  test("piImageBlockToAnthropic converts the four media types the API reads", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(piImageBlockToAnthropic(img(mime))).toEqual({
        type: "image",
        source: { type: "base64", media_type: mime, data: "AAAA" },
      });
    }
    // Uppercase mimes are normalized rather than rejected.
    expect(piImageBlockToAnthropic(img("IMAGE/PNG"))).toMatchObject({
      source: { media_type: "image/png" },
    });
  });

  test("drops what the API cannot read rather than poisoning the request", () => {
    expect(piImageBlockToAnthropic(img("image/bmp"))).toBeNull();
    expect(piImageBlockToAnthropic(img("image/svg+xml"))).toBeNull();
    expect(piImageBlockToAnthropic({ type: "image", data: "AAAA" })).toBeNull();
    expect(
      piImageBlockToAnthropic({ type: "image", mimeType: "image/png" }),
    ).toBeNull();
    expect(piImageBlockToAnthropic({ type: "text", text: "hi" })).toBeNull();
  });

  test("turnImages collects user images and keeps the newest past the cap", () => {
    expect(turnImages([wire({ role: "user", content: "no blocks" })])).toEqual(
      [],
    );
    const many: AnthropicMessage[] = Array.from(
      { length: MAX_TURN_IMAGES + 3 },
      (_, i) =>
        wire({
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: `d${i}`,
              },
            },
          ],
        }),
    );
    const kept = turnImages(many);
    expect(kept).toHaveLength(MAX_TURN_IMAGES);
    // Newest kept: the last block in the slice is the last block kept.
    expect(kept.at(-1)).toMatchObject({
      source: { data: `d${MAX_TURN_IMAGES + 2}` },
    });
  });

  test("planSdkTurn carries only the DELIVERED slice's images on a continuation", () => {
    const messages: AnthropicMessage[] = [
      wire({
        role: "user",
        content: [
          { type: "text", text: "old shot" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "old" },
          },
        ],
      }),
      wire({ role: "assistant", content: [{ type: "text", text: "seen it" }] }),
      wire({
        role: "user",
        content: [
          { type: "text", text: "new shot" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "new" },
          },
        ],
      }),
    ];
    const cont = planSdkTurn(
      {
        sdkSessionId: "sdk-1",
        messageCount: 2,
        accountId: "acc-1",
        lastUsedAt: Date.now(),
      },
      messages,
    );
    expect(cont.continuation).toBe(true);
    expect(cont.images).toHaveLength(1);
    expect(cont.images[0]).toMatchObject({ source: { data: "new" } });
    // A fresh replay re-delivers the whole conversation, images included.
    expect(planSdkTurn(undefined, messages).images).toHaveLength(2);
  });

  test("sdkPromptContent puts images before the text, and only for image turns", () => {
    const plain = planSdkTurn(undefined, [
      wire({ role: "user", content: "just words" }),
    ]);
    expect(sdkPromptContent(plain)).toBeNull();

    const withImage = planSdkTurn(undefined, [
      wire({
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "d" },
          },
        ],
      }),
    ]);
    const content = sdkPromptContent(withImage)!;
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ type: "image" });
    expect(content[1]).toEqual({ type: "text", text: "look at this" });
  });

  test("an image-only turn still gets a text block (an empty prompt reads as an empty turn)", () => {
    const plan = planSdkTurn(undefined, [
      wire({
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "d" },
          },
        ],
      }),
    ]);
    expect(plan.prompt.trim()).toBe("");
    const content = sdkPromptContent(plan)!;
    expect(content.at(-1)).toEqual({ type: "text", text: IMAGE_ONLY_PROMPT });
  });
});

describe("Pi passthrough durable checkpoint", () => {
  test("uses Meridian's explicit model-facing stop instruction", () => {
    expect(PI_PASSTHROUGH_BLOCK_REASON).toContain(
      "This tool call has been forwarded to the client for execution.",
    );
    expect(PI_PASSTHROUGH_BLOCK_REASON).toContain("End your turn now.");
  });

  test("settles only after every parallel call and retains its assistant UUID", () => {
    const tracker = createEarlyStopTracker();
    noteAssistantMessage(tracker, {
      type: "assistant",
      uuid: "assistant-uuid",
      message: {
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "tool-1", name: "read", input: {} },
          { type: "tool_use", id: "tool-2", name: "grep", input: {} },
        ],
      },
    });
    noteUserContent(tracker, [
      { type: "tool_result", tool_use_id: "tool-1", content: "blocked" },
    ]);
    expect(shouldEarlyStop(tracker)).toBe(false);
    noteUserContent(tracker, [
      { type: "tool_result", tool_use_id: "tool-2", content: "blocked" },
    ]);
    expect(shouldEarlyStop(tracker)).toBe(true);
    expect(tracker.toolCallAssistantUuid).toBe("assistant-uuid");
    expect(shouldEarlyStop(tracker)).toBe(false);
  });

  test("handles a blocked result arriving before its assistant envelope", () => {
    const tracker = createEarlyStopTracker();
    noteUserContent(tracker, [
      { type: "tool_result", tool_use_id: "tool-1", content: "blocked" },
    ]);
    expect(shouldEarlyStop(tracker)).toBe(false);
    noteAssistantMessage(tracker, {
      type: "assistant",
      uuid: "assistant-uuid",
      message: {
        content: [{ type: "tool_use", id: "tool-1", name: "read", input: {} }],
      },
    });
    expect(shouldEarlyStop(tracker)).toBe(true);
  });
});

describe("buildPiAnthropicModels", () => {
  test("carries the builtin catalog through untouched and appends a zero-cost fallback", () => {
    const out = buildPiAnthropicModels([model], "claude-brand-new-9");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: "claude-sonnet-5",
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200_000,
    });
    expect(out[1]).toMatchObject({
      id: "claude-brand-new-9",
      provider: "anthropic",
      api: "anthropic-messages",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    });
  });

  test("does not duplicate a model the catalog already has", () => {
    expect(buildPiAnthropicModels([model], "claude-sonnet-5")).toHaveLength(1);
  });
});

describe("usageFromSdkResult", () => {
  test("maps SDK usage fields and prices from the model's cost table", () => {
    const usage = usageFromSdkResult(model, {
      input_tokens: 1_000_000,
      output_tokens: 2_000_000,
      cache_read_input_tokens: 3_000_000,
      cache_creation_input_tokens: 4_000_000,
    });
    expect(usage).toMatchObject({
      input: 1_000_000,
      output: 2_000_000,
      cacheRead: 3_000_000,
      cacheWrite: 4_000_000,
      totalTokens: 10_000_000,
    });
    expect(usage.cost.input).toBeCloseTo(3);
    expect(usage.cost.output).toBeCloseTo(30);
    expect(usage.cost.cacheRead).toBeCloseTo(0.9);
    expect(usage.cost.cacheWrite).toBeCloseTo(15);
    expect(usage.cost.total).toBeCloseTo(48.9);
  });

  test("applies the highest matching request-wide pricing tier", () => {
    const tiered = {
      ...model,
      cost: {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
        tiers: [
          {
            inputTokensAbove: 200_000,
            input: 6,
            output: 22.5,
            cacheRead: 0.6,
            cacheWrite: 7.5,
          },
        ],
      },
    } as unknown as PiCatalogModel;
    const usage = usageFromSdkResult(tiered, {
      input_tokens: 100_000,
      output_tokens: 1_000,
      cache_read_input_tokens: 150_000,
      cache_creation_input_tokens: 0,
    });
    // input + cacheRead + cacheWrite = 250k > 200k → tier rates apply.
    expect(usage.cost.input).toBeCloseTo((6 / 1_000_000) * 100_000);
    expect(usage.cost.cacheRead).toBeCloseTo((0.6 / 1_000_000) * 150_000);
  });

  test("missing usage → zeros (never NaN)", () => {
    const usage = usageFromSdkResult(model, undefined);
    expect(usage.totalTokens).toBe(0);
    expect(usage.cost.total).toBe(0);
  });
});

describe("Claude account notice probe", () => {
  test("holds short output until it can rule out a synthetic account notice", () => {
    expect(shouldDeferClaudeText("Replying normally")).toBe(true);
    expect(
      shouldDeferClaudeText(
        "This is a normal answer that is now long enough to stream without waiting for its result.",
      ),
    ).toBe(false);
  });

  test("keeps observed limit notices hidden from the stream", () => {
    expect(
      shouldDeferClaudeText(
        "You've hit your weekly limit · resets Aug 20, 9am (UTC)",
      ),
    ).toBe(true);
    expect(
      shouldDeferClaudeText(
        "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.",
      ),
    ).toBe(true);
    expect(
      shouldDeferClaudeText(
        "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
      ),
    ).toBe(true);
  });
});

describe("buildPiAnthropicProvider", () => {
  test("throws the bridge's gate error when disabled or no accounts exist", () => {
    designate(null);
    expect(() =>
      buildPiAnthropicProvider({ unifiedSessionId: "os-1" }),
    ).toThrow(/Anthropic bridge is disabled/);
    // Enabled but zero Claude accounts configured: the other wording.
    designate([]);
    seedAccounts([]);
    expect(() =>
      buildPiAnthropicProvider({ unifiedSessionId: "os-1" }),
    ).toThrow(/no accounts to serve on/);
    // Pool mode: an existing account is enough — no designation required.
    seedAccounts(["pool-gate-a"]);
    expect(() =>
      buildPiAnthropicProvider({
        unifiedSessionId: "os-1",
        builtinModels: [model],
      }),
    ).not.toThrow();
  });

  test("builds a configured provider carrying the catalog under the builtin id", async () => {
    designate(["pi-test-acc-1"]);
    const provider = buildPiAnthropicProvider({
      unifiedSessionId: "os-1",
      builtinModels: [model],
      ensureModelId: "claude-brand-new-9",
    }) as any;
    expect(provider.id).toBe("anthropic");
    expect(provider.getModels().map((m: any) => m.id)).toEqual([
      "claude-sonnet-5",
      "claude-brand-new-9",
    ]);
    // Auth always resolves (accounts are picked per request) so ModelRuntime
    // treats the provider as configured without inventing a secret.
    const resolved = await provider.auth.apiKey.resolve({
      ctx: {},
      credential: undefined,
    });
    expect(resolved).toEqual({
      auth: {},
      source: "in-process claude-agent-sdk",
    });
    expect(typeof provider.stream).toBe("function");
    expect(provider.streamSimple).toBe(provider.stream);
  });

  test("stream fails classifier-flagged when no designated account is usable", async () => {
    designate(["pi-test-missing-acc"]);
    seedAccounts([]); // the designated id does not exist in the store
    const provider = buildPiAnthropicProvider({
      unifiedSessionId: "os-1",
      builtinModels: [model],
    }) as any;
    const events: any[] = [];
    for await (const ev of provider.streamSimple(model, {
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    expect(events[1].reason).toBe("error");
    const message = events[1].error.errorMessage as string;
    expect(message).toMatch(/no designated bridge account is currently usable/);
    expect(isPiUsageLimitShape(message, "anthropic")).toBe(true);
    // A failed turn must not mint a session-store mapping.
    expect(piSdkSessionStore().size).toBe(0);
  });

  test("rolling-cap refusal is classifier-flagged but never sidelines the account", async () => {
    designate(["pi-cap-acc"]);
    seedAccounts(["pi-cap-acc"]);
    accounts.__setUsageCacheForTest("pi-cap-acc", freshUsage);
    // Trip the shared per-boot hourly counter (same map the bridge admits
    // against) so the stream's own admission refuses pre-SDK.
    const limit = 300; // bridgeMaxRequestsPerHour default (no pi config in this seam)
    for (let i = 0; i < limit; i++) admitBridgeRequest("pi-cap-acc", 1);
    const provider = buildPiAnthropicProvider({
      unifiedSessionId: "os-cap",
      builtinModels: [model],
    }) as any;
    const events: any[] = [];
    for await (const ev of provider.streamSimple(model, {
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    const message = events[1].error.errorMessage as string;
    expect(message).toMatch(/pi-anthropic 429/);
    // 429-worded so the runner's fallback walk engages…
    expect(isPiUsageLimitShape(message, "anthropic")).toBe(true);
    // …but the account is NOT markExhausted'd: the cap is local admission
    // control (frees within the hour) and the exhaustion sideline is shared
    // with the pi bridge — the account must stay pickable.
    const stillUsable = pickBridgeAccount("claude-sonnet-5");
    expect((stillUsable as any).id).toBe("pi-cap-acc");
  });

  test("a usage-limited account rotates to the next one inside the same turn", async () => {
    // More than the old four-account ceiling, all with their rolling hourly
    // cap tripped. The cap refuses before any SDK spawn, so this proves the
    // walk follows the picker until the real pool is dry.
    const ids = ["cap-a", "cap-b", "cap-c", "cap-d", "cap-e", "cap-f"];
    designate(ids);
    seedAccounts(ids);
    const limit = 300; // bridgeMaxRequestsPerHour default (no pi config in this seam)
    for (const id of ids) {
      accounts.__setUsageCacheForTest(id, freshUsage);
      for (let i = 0; i < limit; i++) admitBridgeRequest(id, 1);
    }
    const provider = buildPiAnthropicProvider({
      unifiedSessionId: "os-rotate",
      builtinModels: [model],
    }) as any;
    const events: any[] = [];
    for await (const ev of provider.streamSimple(model, {
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(ev);
    }
    // ONE `start` for the whole walk: a rotation replays the attempt, never
    // the pi-visible stream, so the reader still sees one assistant message.
    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    // The surfaced error names account six. The old hard cap stopped after
    // account four even though two eligible accounts remained.
    const message = events[1].error.errorMessage as string;
    expect(message).toContain("cap-f");
    expect(isPiUsageLimitShape(message, "anthropic")).toBe(true);
    // Neither account was sidelined on the way through: the rolling cap is
    // local admission control, and the sideline map is shared with pi.
    const stillPickable = pickBridgeAccount("claude-sonnet-5");
    expect((stillPickable as any).id).toBe("cap-a");
  });

  test("a dry pool says so, instead of echoing the last account's limit", async () => {
    // The bug this replaced: the walk consulted every account, the picker
    // refused, that refusal was dropped on the floor, and the reader was shown
    // the LAST account's sentence, so a working rotation read as no rotation
    // at all (it misled two people for an afternoon).
    designate(["dry-a", "dry-b"]);
    seedAccounts(["dry-a", "dry-b"]);
    accounts.__setUsageCacheForTest("dry-a", freshUsage);
    accounts.__setUsageCacheForTest("dry-b", freshUsage);
    for (let i = 0; i < 300; i++) {
      admitBridgeRequest("dry-a", 1);
      admitBridgeRequest("dry-b", 1);
    }
    const provider = buildPiAnthropicProvider({
      unifiedSessionId: "os-dry",
      builtinModels: [model],
    }) as any;
    const events: any[] = [];
    for await (const ev of provider.streamSimple(model, {
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(ev);
    }
    const message = events[events.length - 1].error.errorMessage as string;
    expect(message).toContain("every Claude account is usage-limited");
    // Still names what was tried last, so the detail is not lost…
    expect(message).toContain("dry-b");
    // …and still classifies as exhaustion, so the model fallback upstream
    // (agent-runner) engages exactly as it did before.
    expect(isPiUsageLimitShape(message, "anthropic")).toBe(true);
  });

  test("a strict pin refuses instead of rotating off the pinned account", async () => {
    designate(["pin-strict", "pin-other"]);
    seedAccounts(["pin-strict", "pin-other"]);
    accounts.__setUsageCacheForTest("pin-strict", freshUsage);
    accounts.__setUsageCacheForTest("pin-other", freshUsage);
    const limit = 300;
    for (let i = 0; i < limit; i++) admitBridgeRequest("pin-strict", 1);
    const provider = buildPiAnthropicProvider({
      unifiedSessionId: "os-pin",
      accountId: "pin-strict",
      accountStrict: true,
      builtinModels: [model],
    }) as any;
    const events: any[] = [];
    for await (const ev of provider.streamSimple(model, {
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    // The pinned account's own refusal — a hard pin must never silently
    // rotate onto an account the person deliberately did not choose.
    const message = events[1].error.errorMessage as string;
    expect(message).toContain("pin-strict");
    expect(message).not.toContain("pin-other");
  });

  test("a pre-aborted signal ends with reason aborted before any SDK work", async () => {
    designate(["pi-test-acc-1"]);
    const provider = buildPiAnthropicProvider({
      unifiedSessionId: "os-1",
      builtinModels: [model],
    }) as any;
    const controller = new AbortController();
    controller.abort();
    const events: any[] = [];
    for await (const ev of provider.streamSimple(
      model,
      { messages: [{ role: "user", content: "hi" }] },
      { signal: controller.signal },
    )) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    expect(events[1].reason).toBe("aborted");
    expect(events[1].error.stopReason).toBe("aborted");
  });
});

describe("pickBridgeAccount pins (in-process runs only; designation is the ceiling)", () => {
  test("a designated, usable pin is picked first", () => {
    designate(["des-a", "des-b"]);
    seedAccounts(["des-a", "des-b"]);
    accounts.__setUsageCacheForTest("des-a", freshUsage);
    accounts.__setUsageCacheForTest("des-b", freshUsage);
    const picked = pickBridgeAccount("claude-sonnet-5", { accountId: "des-b" });
    expect("error" in picked).toBe(false);
    expect((picked as any).id).toBe("des-b");
  });

  test("strict pin outside the designation is a config error, not exhaustion", () => {
    designate(["des-a"]);
    seedAccounts(["des-a", "outsider"]);
    accounts.__setUsageCacheForTest("des-a", freshUsage);
    const picked = pickBridgeAccount("claude-sonnet-5", {
      accountId: "outsider",
      accountStrict: true,
    });
    // Read the string BEFORE asserting on the object: bun's toMatchObject
    // with an asymmetric matcher mutates the received object in place.
    const error = (picked as any).error as string;
    expect(error).toContain("not a designated bridge account");
    // Deliberately NOT usage-limit-shaped: model-hopping cannot fix a bad pin.
    expect(isPiUsageLimitShape(error, "anthropic")).toBe(false);
  });

  test("non-strict pin outside the designation falls back to the designated walk", () => {
    designate(["des-a"]);
    seedAccounts(["des-a", "outsider"]);
    accounts.__setUsageCacheForTest("des-a", freshUsage);
    const picked = pickBridgeAccount("claude-sonnet-5", {
      accountId: "outsider",
    });
    expect((picked as any).id).toBe("des-a");
  });

  test("strict pin on an exhausted designated account fails exhaustion-shaped", () => {
    designate(["des-maxed", "des-a"]);
    seedAccounts(["des-maxed", "des-a"]);
    accounts.__setUsageCacheForTest("des-maxed", maxedUsage);
    accounts.__setUsageCacheForTest("des-a", freshUsage);
    const picked = pickBridgeAccount("claude-sonnet-5", {
      accountId: "des-maxed",
      accountStrict: true,
    });
    const error = (picked as any).error as string;
    expect(error).toMatch(/no designated bridge account is currently usable/);
    expect(error).toMatch(/strict pin/);
    expect(isPiUsageLimitShape(error, "anthropic")).toBe(true);
    // Non-strict: the same pin widens to the rest of the designation.
    const widened = pickBridgeAccount("claude-sonnet-5", {
      accountId: "des-maxed",
    });
    expect((widened as any).id).toBe("des-a");
  });

  test("no pin keeps the plain designated walk (bridge behavior unchanged)", () => {
    designate(["des-maxed", "des-a"]);
    seedAccounts(["des-maxed", "des-a"]);
    accounts.__setUsageCacheForTest("des-maxed", maxedUsage);
    accounts.__setUsageCacheForTest("des-a", freshUsage);
    const picked = pickBridgeAccount("claude-sonnet-5");
    expect((picked as any).id).toBe("des-a");
  });
});

describe("pickBridgeAccount pool mode (no designation — picks like pi)", () => {
  test("picks the least-used usable account from the general pool", () => {
    designate([]);
    seedAccounts(["pool-a", "pool-b"]);
    accounts.__setUsageCacheForTest("pool-a", maxedUsage);
    accounts.__setUsageCacheForTest("pool-b", freshUsage);
    const picked = pickBridgeAccount("claude-sonnet-5");
    expect((picked as any).id).toBe("pool-b");
  });

  test("exhausted pool fails usage-limit-shaped; empty pool is a config error", () => {
    designate([]);
    seedAccounts(["pool-maxed"]);
    accounts.__setUsageCacheForTest("pool-maxed", maxedUsage);
    const picked = pickBridgeAccount("claude-sonnet-5");
    const error = (picked as any).error as string;
    expect(error).toMatch(/no usable Claude account in the pool/);
    expect(isPiUsageLimitShape(error, "anthropic")).toBe(true);
    // Zero accounts configured: a config problem, not exhaustion — the
    // model-fallback walk must NOT engage (hopping models can't fix it).
    seedAccounts([]);
    const empty = pickBridgeAccount("claude-sonnet-5");
    const emptyError = (empty as any).error as string;
    expect(emptyError).toMatch(/no Claude accounts configured/);
    expect(isPiUsageLimitShape(emptyError, "anthropic")).toBe(false);
  });

  test("pins are honored; a strict pin never widens to the pool", () => {
    designate([]);
    seedAccounts(["pool-pin-a", "pool-pin-maxed"]);
    accounts.__setUsageCacheForTest("pool-pin-a", freshUsage);
    accounts.__setUsageCacheForTest("pool-pin-maxed", maxedUsage);
    const pinned = pickBridgeAccount("claude-sonnet-5", {
      accountId: "pool-pin-a",
    });
    expect((pinned as any).id).toBe("pool-pin-a");
    const strict = pickBridgeAccount("claude-sonnet-5", {
      accountId: "pool-pin-maxed",
      accountStrict: true,
    });
    const error = (strict as any).error as string;
    expect(error).toMatch(/no usable Claude account/);
    expect(isPiUsageLimitShape(error, "anthropic")).toBe(true);
    // Non-strict pin on an exhausted account widens to the pool.
    const widened = pickBridgeAccount("claude-sonnet-5", {
      accountId: "pool-pin-maxed",
    });
    expect((widened as any).id).toBe("pool-pin-a");
  });

  test("a user's personal account wins for their runs, never for others", () => {
    designate([]);
    seedAccounts(["pool-shared", { id: "pool-personal", owner: "alice" }]);
    accounts.__setUsageCacheForTest("pool-shared", freshUsage);
    accounts.__setUsageCacheForTest("pool-personal", freshUsage);
    const alice = pickBridgeAccount("claude-sonnet-5", { user: "alice" });
    expect((alice as any).id).toBe("pool-personal");
    const bob = pickBridgeAccount("claude-sonnet-5", { user: "bob" });
    expect((bob as any).id).toBe("pool-shared");
    const anonymous = pickBridgeAccount("claude-sonnet-5");
    expect((anonymous as any).id).toBe("pool-shared");
  });
});
