/**
 * Focused pi-runner tests: the pure pieces — model-id parsing, the
 * deny-by-default run gate, the provider-aware usage-limit classifier, the
 * local-tool path containment guard (the in-process engine's security
 * invariant), the custom bash tool's exit-gated completion (wedge
 * regression), and pi/openai account wiring against an isolated Codex store
 * plus a fake SDK for the in-band terminal path. No test reaches the network.
 * A real engine turn is covered by the smoke harness
 * (POST /api/admin/pi-smoke) against a live bridge, not unit tests.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  acceptSteerOnce,
  assertContainedPiPath,
  assistantRenderableBlockCount,
  buildPiThirdPartyProviderPlan,
  cancelPiRun,
  isPiSessionBusy,
  isPiUsageLimitShape,
  makeGuardedGrepExecute,
  makeGuardedToolOps,
  makePiBashTool,
  parsePiModel,
  piModelResolutionError,
  piBashHomeEnv,
  piAssistantTranscriptEntries,
  PI_STATE_DIR,
  PI_CODEMODE_TOOL,
  PI_STEER_TOOL_SKIP,
  piCodemodeExtension,
  piGateReason,
  piStreamEventRequiresAccountContinuation,
  piSteeringBoundaryTools,
  interruptPiThinkingForSteer,
  piToolNames,
  resolvePiRoutedModel,
  retractPendingSteer,
  runPi,
  runPiSmokeTurn,
  steerPiRun,
} from "./pi-runner";
import type { PiBashAuditEvent } from "./pi-runner";
import { __setCodexAccountsPathForTest } from "./codex-accounts";

describe("acceptSteerOnce", () => {
  test("records only successful acceptance and deduplicates retries", () => {
    const accepted = new Set<string>();
    expect(() =>
      acceptSteerOnce(accepted, "one", () => {
        throw new Error("not accepted");
      }),
    ).toThrow("not accepted");
    expect(accepted.has("one")).toBe(false);
    let calls = 0;
    expect(
      acceptSteerOnce(accepted, "one", () => {
        calls += 1;
      }),
    ).toBe(true);
    expect(
      acceptSteerOnce(accepted, "one", () => {
        calls += 1;
      }),
    ).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("piSteeringBoundaryTools", () => {
  test("runs calls sequentially and skips work that has not started after a steer", async () => {
    const executed: string[] = [];
    let steeringPending = false;
    const tools = piSteeringBoundaryTools(
      [
        {
          name: "first",
          label: "first",
          description: "first",
          parameters: {} as any,
          async execute() {
            executed.push("first");
            return {
              content: [{ type: "text", text: "first result" }],
              details: {},
            };
          },
        },
        {
          name: "second",
          label: "second",
          description: "second",
          parameters: {} as any,
          async execute() {
            executed.push("second");
            return {
              content: [{ type: "text", text: "second result" }],
              details: {},
            };
          },
        },
      ],
      () => steeringPending,
    );

    expect(tools.map((tool) => tool.executionMode)).toEqual([
      "sequential",
      "sequential",
    ]);
    await tools[0].execute("call-1", {}, undefined, undefined, {} as any);
    steeringPending = true;
    const skipped = await tools[1].execute(
      "call-2",
      {},
      undefined,
      undefined,
      {} as any,
    );

    expect(executed).toEqual(["first"]);
    expect(skipped.content).toEqual([
      { type: "text", text: PI_STEER_TOOL_SKIP },
    ]);
  });

  test("rejects a codemode script's call once a steer is waiting", async () => {
    let executed = 0;
    const [tool] = piSteeringBoundaryTools(
      [
        {
          name: "read",
          label: "read",
          description: "read",
          parameters: {} as any,
          async execute() {
            executed++;
            return { content: [{ type: "text", text: "ok" }], details: {} };
          },
        },
      ],
      () => true,
    );
    await expect(
      tool!.execute("call-1/2", {}, undefined, undefined, {} as any),
    ).rejects.toThrow(PI_STEER_TOOL_SKIP);
    expect(executed).toBe(0);
  });
});

describe("interruptPiThinkingForSteer", () => {
  const thinking = [{ type: "thinking", thinking: "planning" }];
  const agent = (opts: {
    streaming?: string;
    content?: unknown[];
    tools?: string[];
    queued?: boolean;
  }) => {
    const calls = { abort: 0 };
    return {
      calls,
      state: {
        streamingMessage: opts.streaming
          ? { role: opts.streaming, content: opts.content ?? [] }
          : undefined,
        pendingToolCalls: new Set(opts.tools ?? []),
      },
      hasQueuedMessages: () => opts.queued ?? true,
      abort: () => {
        calls.abort++;
      },
    };
  };

  test("cuts a response short while it is only thinking", () => {
    for (const content of [[], thinking]) {
      const target = agent({ streaming: "assistant", content });
      expect(interruptPiThinkingForSteer(target)).toBe(true);
      expect(target.calls.abort).toBe(1);
    }
  });

  test("lets reply text, tool calls and running tools finish", () => {
    for (const target of [
      agent({
        streaming: "assistant",
        content: [...thinking, { type: "text", text: "Here is" }],
      }),
      agent({
        streaming: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash" }],
      }),
      agent({ streaming: "assistant", tools: ["call-1"] }),
      agent({}),
      agent({ streaming: "user" }),
      agent({ streaming: "assistant", queued: false }),
    ]) {
      expect(interruptPiThinkingForSteer(target)).toBe(false);
      expect(target.calls.abort).toBe(0);
    }
  });
});

describe("piCodemodeExtension", () => {
  test("registers pi's codemode tool behind the steering boundary", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent");
    let steeringPending = false;
    const registered: any[] = [];
    // Methods read `this`, as pi's extension API does.
    class FakePi {
      tools = registered;
      registerTool(tool: any) {
        this.tools.push(tool);
      }
      getSettings() {
        return {};
      }
    }
    await piCodemodeExtension(sdk, () => steeringPending)(new FakePi() as any);

    expect(registered).toHaveLength(1);
    const tool = registered[0];
    expect(tool.name).toBe(PI_CODEMODE_TOOL);
    expect(tool.executionMode).toBe("sequential");
    expect(typeof tool.prepareLoadout).toBe("function");
    steeringPending = true;
    const skipped = await tool.execute(
      "call-1",
      { code: "return 1" },
      undefined,
      undefined,
      {} as any,
    );
    expect(skipped.content).toEqual([
      { type: "text", text: PI_STEER_TOOL_SKIP },
    ]);
  });
});

describe("retractPendingSteer", () => {
  test("retracts an exact duplicate id and replays the remaining payloads in order", () => {
    const pending = [
      { steerId: "first", text: "same", images: ["first-image"] },
      { steerId: "second", text: "same", images: ["second-image"] },
      { steerId: "third", text: "after" },
    ];
    let replayed: readonly (typeof pending)[number][] = [];

    expect(
      retractPendingSteer(pending, "second", (remaining) => {
        replayed = [...remaining];
      }),
    ).toBe(true);
    expect(pending.map((item) => item.steerId)).toEqual(["first", "third"]);
    expect(replayed).toEqual(pending);
    expect(retractPendingSteer(pending, "missing", () => {})).toBe(false);
  });
});

describe("assistant transcript output", () => {
  test("counts thinking, text, and tool-call blocks as visible output", () => {
    expect(
      assistantRenderableBlockCount([
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Done." },
        { type: "toolCall", id: "t1", name: "bash" },
      ]),
    ).toBe(3);
  });

  test("persists thinking and text in provider order around tools", () => {
    expect(
      piAssistantTranscriptEntries(
        [
          { type: "thinking", thinking: "I should inspect the repository." },
          {
            type: "toolCall",
            id: "t1",
            name: "read",
            arguments: { path: "README.md" },
          },
          { type: "text", text: "The repository is ready." },
        ],
        "2026-08-24T12:00:00.000Z",
        "gpt-5.6-terra",
        "message-1",
      ),
    ).toEqual([
      {
        id: "message-1",
        type: "assistant",
        content: "I should inspect the repository.",
        timestamp: "2026-08-24T12:00:00.000Z",
        model: "gpt-5.6-terra",
        isReasoning: true,
      },
      {
        id: "t1",
        type: "tool_use",
        content: "",
        timestamp: "2026-08-24T12:00:00.000Z",
        toolName: "read",
        toolInput: { path: "README.md" },
        toolUseId: "t1",
      },
      {
        id: "message-1-b1",
        type: "assistant",
        content: "The repository is ready.",
        timestamp: "2026-08-24T12:00:00.000Z",
        model: "gpt-5.6-terra",
      },
    ]);
  });

  test("places a media marker in the text block and lists its media", () => {
    expect(
      piAssistantTranscriptEntries(
        [
          { type: "thinking", thinking: "OPENSESSION_IMAGE: /tmp/plan.png" },
          {
            type: "text",
            text: "Done.\n\nOPENSESSION_IMAGE: /tmp/shot.png\nThe result\n",
          },
        ],
        "2026-08-24T12:00:00.000Z",
        "gpt-5.6-terra",
        "message-1",
      ),
    ).toEqual([
      {
        id: "message-1",
        type: "assistant",
        content: "![](/media?path=%2Ftmp%2Fplan.png)",
        timestamp: "2026-08-24T12:00:00.000Z",
        model: "gpt-5.6-terra",
        isReasoning: true,
        images: ["/media?path=%2Ftmp%2Fplan.png"],
        featuredMedia: ["/media?path=%2Ftmp%2Fplan.png"],
      },
      {
        id: "message-1-b1",
        type: "assistant",
        content: "Done.\n\n![The result](/media?path=%2Ftmp%2Fshot.png)",
        timestamp: "2026-08-24T12:00:00.000Z",
        model: "gpt-5.6-terra",
        images: ["/media?path=%2Ftmp%2Fshot.png"],
        featuredMedia: ["/media?path=%2Ftmp%2Fshot.png"],
      },
    ]);
  });

  test("zero for the empty-completion shapes providers emit", () => {
    // The exact os-01a02486 shape: content: [] with stopReason "stop".
    expect(assistantRenderableBlockCount([])).toBe(0);
    expect(assistantRenderableBlockCount(undefined)).toBe(0);
    expect(
      assistantRenderableBlockCount([{ type: "text", text: "  \n" }]),
    ).toBe(0);
    expect(
      assistantRenderableBlockCount([{ type: "thinking", thinking: "  \n" }]),
    ).toBe(0);
    expect(assistantRenderableBlockCount([null, 42, {}])).toBe(0);
  });
});

describe("parsePiModel", () => {
  test("splits pi/<provider>/<model>", () => {
    expect(parsePiModel("pi/anthropic/claude-opus-5-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-5-5",
    });
  });

  test("model id may itself contain slashes", () => {
    expect(parsePiModel("pi/openrouter/meta/llama-3")).toEqual({
      providerID: "openrouter",
      modelID: "meta/llama-3",
    });
  });

  test("rejects non-pi ids and malformed remainders", () => {
    expect(parsePiModel("anthropic/claude-opus-5-5")).toBeNull();
    expect(parsePiModel("claude-opus-5-5")).toBeNull();
    expect(parsePiModel("pi/anthropic")).toBeNull();
    expect(parsePiModel("pi/anthropic/")).toBeNull();
    expect(parsePiModel("pi//claude-opus-5-5")).toBeNull();
  });
});

describe("resolvePiRoutedModel", () => {
  test("routes plain models to their provider and model", () => {
    expect(resolvePiRoutedModel("pi/anthropic/claude-opus-5-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-5-5",
    });
  });

  test("routes retired preset ids to the model they led", () => {
    expect(resolvePiRoutedModel("pi/dial/ultra")).toEqual({
      providerID: "anthropic",
      modelID: "claude-fable-5-1",
    });
    expect(resolvePiRoutedModel("pi/orchestrator/sol")).toEqual({
      providerID: "openai",
      modelID: "gpt-6.1-sol",
    });
  });

  test("leaves retired workspace preset ids unresolved", () => {
    expect(resolvePiRoutedModel("pi/workspace-preset/ws-acme/opus")).toBeNull();
    expect(piModelResolutionError("not-a-model")).toContain(
      "Not a pi model id",
    );
  });
});

describe("buildPiThirdPartyProviderPlan", () => {
  test("wafer registers as a generic OpenAI-compatible provider with our catalog", () => {
    const plan = buildPiThirdPartyProviderPlan({
      providerID: "wafer",
      modelID: "deepseek-v4-flash-0731-fast",
      apiKey: "wfr-test",
      builtinModelIds: [],
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.config).toMatchObject({
      apiKey: "wfr-test",
      name: "Wafer",
      api: "openai-completions",
      baseUrl: "https://pass.wafer.ai/v1",
    });
    const models = plan.config.models as unknown as Array<
      Record<string, unknown>
    >;
    const ids = models.map((m) => m.id);
    expect(ids).toContain("deepseek-v4-flash-0731-fast");
    expect(ids).toContain("kimi-k3");
    const deepseek = models.find(
      (m) => m.id === "deepseek-v4-flash-0731-fast",
    )!;
    // Pi's six-rung ladder onto Wafer's four: only the off-ladder rungs map.
    expect(deepseek.thinkingLevelMap).toEqual({ minimal: "low", xhigh: "max" });
    expect(deepseek.contextWindow).toBe(1_048_576);
    expect(deepseek.cost).toMatchObject({ input: 0.28, cacheRead: 0.07 });
    // Vision only where Wafer documents it.
    expect(deepseek.input).toEqual(["text"]);
    const kimi = models.find((m) => m.id === "kimi-k3")!;
    expect(kimi.input).toEqual(["text", "image"]);
  });

  test("a configured baseURL overrides the catalog default", () => {
    const plan = buildPiThirdPartyProviderPlan({
      providerID: "wafer",
      modelID: "glm-5.2",
      apiKey: "wfr-test",
      baseURL: "https://proxy.example.test/v1",
      builtinModelIds: [],
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.config.baseUrl).toBe("https://proxy.example.test/v1");
  });

  test("a builtin-catalog provider with a known model passes no model table", () => {
    const plan = buildPiThirdPartyProviderPlan({
      providerID: "cerebras",
      modelID: "gpt-oss-120b",
      apiKey: "csk-test",
      builtinModelIds: ["gpt-oss-120b", "zai-glm-4.7"],
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.config).toEqual({ apiKey: "csk-test" });
  });

  test("supplements OpenRouter with GLM-5.3 without replacing known builtins", () => {
    const glm = buildPiThirdPartyProviderPlan({
      providerID: "openrouter",
      modelID: "z-ai/glm-5.3",
      apiKey: "sk-or-test",
      builtinModelIds: ["anthropic/claude-sonnet-4"],
    });
    if ("error" in glm) throw new Error(glm.error);
    expect(glm.config).toMatchObject({
      apiKey: "sk-or-test",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(glm.config.models).toEqual([
      expect.objectContaining({
        id: "z-ai/glm-5.3",
        input: ["text"],
        contextWindow: 1_048_576,
        maxTokens: 131_072,
      }),
    ]);

    const builtin = buildPiThirdPartyProviderPlan({
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet-4",
      apiKey: "sk-or-test",
      builtinModelIds: ["anthropic/claude-sonnet-4"],
    });
    if ("error" in builtin) throw new Error(builtin.error);
    expect(builtin.config.models).toBeUndefined();
  });

  test("a model newer than both catalogs gets a conservative fallback entry", () => {
    const plan = buildPiThirdPartyProviderPlan({
      providerID: "cerebras",
      modelID: "brand-new-model",
      apiKey: "csk-test",
      builtinModelIds: ["gpt-oss-120b"],
    });
    if ("error" in plan) throw new Error(plan.error);
    const models = plan.config.models as unknown as Array<
      Record<string, unknown>
    >;
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "brand-new-model",
      reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  test("a provider in neither catalog fails clearly instead of guessing", () => {
    const plan = buildPiThirdPartyProviderPlan({
      providerID: "mystery",
      modelID: "some-model",
      apiKey: "k",
      builtinModelIds: [],
    });
    expect(plan).toMatchObject({ error: expect.stringContaining("neither") });
  });
});

describe("piGateReason", () => {
  test("interactive and unattended kinds pass", () => {
    for (const kind of [
      "prompt",
      "goal",
      "create",
      "linear",
      "slack",
      "workflow",
    ]) {
      expect(piGateReason({ journal: { kind } })).toBeNull();
    }
    for (const kind of [
      "automation",
      "plain",
      "action",
      "security-scan",
      "github-review",
    ]) {
      expect(piGateReason({ journal: { kind } })).toBeNull();
    }
  });

  test("resume/rerun/fallback suffixes resolve to the base kind", () => {
    expect(piGateReason({ journal: { kind: "prompt-resume" } })).toBeNull();
    expect(
      piGateReason({ journal: { kind: "automation-resume-fallback" } }),
    ).toBeNull();
  });

  test("kind-less runs are refused (deny by default)", () => {
    expect(piGateReason({})).toMatch(/explicit run kind/);
    expect(piGateReason({ journal: {} })).toMatch(/explicit run kind/);
  });

  test("unknown kinds are refused by name", () => {
    expect(piGateReason({ journal: { kind: "mystery" } })).toContain(
      '"mystery"',
    );
  });

  test("the smoke kind is refused unless the harness armed its bypass", () => {
    // Request/automation data can NAME the kind, but only runPiSmokeTurn can
    // arm the module-scoped bypass — from out here it must stay refused.
    expect(piGateReason({ journal: { kind: "pi-smoke" } })).toContain(
      '"pi-smoke"',
    );
  });
});

describe("piToolNames", () => {
  test("activates only names backed by custom definitions", () => {
    const definitions = [
      { name: "read" },
      { name: "mcp_search" },
      { name: "oracle" },
    ];

    expect(piToolNames(definitions)).toEqual(["read", "mcp_search", "oracle"]);
    expect(piToolNames(definitions.slice(1))).not.toContain("read");
  });
});

describe("isPiUsageLimitShape (provider-aware)", () => {
  test("anthropic runs match the loopback bridge's shapes", () => {
    expect(isPiUsageLimitShape("HTTP 429 from bridge", "anthropic")).toBe(true);
    expect(isPiUsageLimitShape("upstream returned 529", "anthropic")).toBe(
      true,
    );
    expect(isPiUsageLimitShape("overloaded_error", "anthropic")).toBe(true);
    expect(
      isPiUsageLimitShape("no designated bridge account", "anthropic"),
    ).toBe(true);
    expect(
      isPiUsageLimitShape(
        "Your organization has disabled Claude subscription access for Claude Code",
        "anthropic",
      ),
    ).toBe(true);
    expect(isPiUsageLimitShape("ordinary tool failure", "anthropic")).toBe(
      false,
    );
  });

  test("openai runs match the shared codex classifier plus the raw code shapes", () => {
    expect(
      isPiUsageLimitShape(
        "You have hit your ChatGPT usage limit (Plus plan). Try again in ~3 hr.",
        "openai",
      ),
    ).toBe(true);
    expect(isPiUsageLimitShape("usage_limit_reached", "openai")).toBe(true);
    expect(isPiUsageLimitShape("usage_not_included", "openai")).toBe(true);
    expect(isPiUsageLimitShape("rate_limit_exceeded", "openai")).toBe(true);
    expect(isPiUsageLimitShape("insufficient_quota", "openai")).toBe(true);
    expect(isPiUsageLimitShape("Too Many Requests", "openai")).toBe(true);
    expect(isPiUsageLimitShape("status 429", "openai")).toBe(true);
    // Bridge-only shapes must NOT flag openai runs (overload/529 is transient
    // there, not exhaustion).
    expect(isPiUsageLimitShape("no designated bridge account", "openai")).toBe(
      false,
    );
    expect(isPiUsageLimitShape("overloaded_error", "openai")).toBe(false);
    expect(isPiUsageLimitShape("upstream returned 529", "openai")).toBe(false);
    expect(isPiUsageLimitShape("ordinary tool failure", "openai")).toBe(false);
  });

  test("xai-oauth runs match the proxy's quota shapes and a dead token, not infra quota errors", () => {
    expect(
      isPiUsageLimitShape("OpenAI API error: 429 rate limited", "xai-oauth"),
    ).toBe(true);
    expect(isPiUsageLimitShape("insufficient_quota", "xai-oauth")).toBe(true);
    expect(
      isPiUsageLimitShape("credits exhausted for this period", "xai-oauth"),
    ).toBe(true);
    expect(
      isPiUsageLimitShape(
        "xAI token refresh failed: invalid_grant",
        "xai-oauth",
      ),
    ).toBe(true);
    expect(
      isPiUsageLimitShape(
        "pi/xai-oauth: no usable SuperGrok account is available",
        "xai-oauth",
      ),
    ).toBe(true);
    expect(
      isPiUsageLimitShape("EDQUOT: disk quota exceeded", "xai-oauth"),
    ).toBe(false);
    expect(isPiUsageLimitShape("overloaded_error", "xai-oauth")).toBe(false);
    expect(isPiUsageLimitShape("ordinary tool failure", "xai-oauth")).toBe(
      false,
    );
  });
});

describe("pi/openai in-band account rotation gate", () => {
  test("zero-token usage bookkeeping does not strand the rest of the account pool", () => {
    // Pi emits init → usage_snapshot(0) → stopReason:error for a provider
    // usage limit. The terminal is handled after the queue drains, so the
    // snapshot must not masquerade as assistant output and block rotation.
    expect(piStreamEventRequiresAccountContinuation({ type: "init" })).toBe(
      false,
    );
    expect(
      piStreamEventRequiresAccountContinuation({ type: "usage_snapshot" }),
    ).toBe(false);

    // Real output and durable operational notices still make replay unsafe.
    expect(
      piStreamEventRequiresAccountContinuation({ type: "text_chunk" }),
    ).toBe(true);
    expect(piStreamEventRequiresAccountContinuation({ type: "tool_use" })).toBe(
      true,
    );
    expect(
      piStreamEventRequiresAccountContinuation({ type: "tool_result" }),
    ).toBe(true);
    expect(
      piStreamEventRequiresAccountContinuation({ type: "runner_notice" }),
    ).toBe(true);
  });
});

describe("runPi pi/openai account wiring (fake engine, no network)", () => {
  // Enabled Pi config + an isolated Codex store. Most tests fail before SDK
  // import; the in-band terminal regression installs a fake SDK explicitly.
  const dir = mkdtempSync(join(tmpdir(), "pi-openai-"));
  const cfgPath = join(dir, "pi.json");
  const storePath = join(dir, "codex-accounts.json");
  let prevCfg: string | undefined;
  let prevStore = "";
  beforeAll(() => {
    writeFileSync(cfgPath, JSON.stringify({ enabled: true, pickerModels: [] }));
    prevCfg = process.env.OPENSESSION_PI_CONFIG;
    process.env.OPENSESSION_PI_CONFIG = cfgPath;
    prevStore = __setCodexAccountsPathForTest(storePath);
  });
  afterAll(() => {
    if (prevCfg === undefined) delete process.env.OPENSESSION_PI_CONFIG;
    else process.env.OPENSESSION_PI_CONFIG = prevCfg;
    __setCodexAccountsPathForTest(prevStore);
    rmSync(dir, { recursive: true, force: true });
  });

  const collect = async (
    model: string,
    extra: Record<string, unknown> = {},
  ) => {
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of runPi(
      // No osSessionId: journal/store writes are skipped — pure wiring test.
      {
        prompt: "hi",
        cwd: dir,
        mode: "ask",
        mcpServers: [],
        journal: { kind: "prompt" },
        ...extra,
      },
      model,
    )) {
      events.push(ev as unknown as Record<string, unknown>);
    }
    return events;
  };

  test("a provider with no credentials gets a clear configuration error", async () => {
    const events = await collect("pi/mistral/large");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(String(events[0].content)).toContain(
      'no credentials for provider "mistral"',
    );
    expect(String(events[0].content)).toContain(
      "Configure that model provider first",
    );
  });

  test("dry codex pool → flagged terminal so the model-fallback walk engages", async () => {
    const events = await collect("pi/openai/gpt-6.1-sol");
    const err = events.find((e) => e.type === "error")!;
    expect(err).toBeDefined();
    expect(String(err.content)).toContain(
      "no ChatGPT subscription or API-key accounts are configured",
    );
    // The pre-init throw's text never matches the classifier — the catch must
    // honor the thrown error's usageLimitExhausted property.
    expect(err.usageLimitExhausted).toBe(true);
  });

  test("a pinned API-key account uses Pi's standard OpenAI runtime", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        accounts: [
          {
            id: "k1",
            name: "org-key",
            kind: "api_key",
            value: "test-remote-runtime-key",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );

    const runtimeKeys: Array<[string, string]> = [];
    const fakeSdk = {
      ModelRuntime: {
        create: async () => ({
          getModel: (_provider: string, id: string) => ({ id, name: id }),
          registerProvider: () => {},
          setRuntimeApiKey: async (provider: string, key: string) => {
            runtimeKeys.push([provider, key]);
          },
        }),
      },
      SettingsManager: { inMemory: () => ({}) },
      DefaultResourceLoader: class {
        async reload() {}
        getSkills() {
          return { skills: [] };
        }
      },
      SessionManager: { create: () => ({}), open: () => ({}) },
      createAgentSession: async () => {
        let listener: (event: any) => void = () => {};
        const session = {
          sessionId: "fake-api-key",
          pendingMessageCount: 0,
          agent: { continue: async () => {} },
          state: { tools: [] },
          setSteeringMode: () => {},
          subscribe: (fn: (event: any) => void) => {
            listener = fn;
            return () => {};
          },
          prompt: async () => {
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                stopReason: "stop",
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: { total: 0 },
                },
                content: [{ type: "text", text: "ok" }],
                timestamp: Date.now(),
              },
            });
            listener({ type: "agent_settled" });
          },
          getLastAssistantText: () => "ok",
          steer: async () => {},
          abort: async () => {},
          abortRetry: () => {},
          dispose: () => {},
        };
        return { session };
      },
    };

    const sdkState = globalThis as any;
    const previousSdkPromise = sdkState.__piSdkPromise;
    sdkState.__piSdkPromise = Promise.resolve(fakeSdk);
    try {
      const events = await collect("pi/openai/gpt-6.1-sol", {
        accountId: "k1",
        accountStrict: true,
        disableLocalWorkspaceTools: true,
      });
      expect(runtimeKeys).toEqual([["openai", "test-remote-runtime-key"]]);
      const errors = events.filter((event) => event.type === "error");
      expect(errors, JSON.stringify(errors)).toHaveLength(0);
      expect(events.find((event) => event.type === "done")).toMatchObject({
        result: "ok",
      });
    } finally {
      sdkState.__piSdkPromise = previousSdkPromise;
    }
  });

  // An image steer stages its attachment on an async chain before it reaches
  // pi's queue (prompt-attachments.ts). steerPiRun has already answered
  // "accepted" by then, so a prompt that settles while the chain is still
  // busy must not let the pump read pendingMessageCount === 0 and finish:
  // the steer would be lost with a receipt that says it was taken.
  test("a steer accepted while its image is staging is still driven to delivery", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        accounts: [
          {
            id: "k1",
            name: "org-key",
            kind: "api_key",
            value: "test-remote-runtime-key",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const sessionKey = `pi-late-steer-${crypto.randomUUID()}`;
    const scratchDir = join(dir, `scratch-${sessionKey}`);
    mkdirSync(scratchDir, { recursive: true });
    const png = {
      mediaType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    };
    const steered: string[] = [];
    let continues = 0;
    const fakeSdk = {
      ModelRuntime: {
        create: async () => ({
          getModel: (_provider: string, id: string) => ({ id, name: id }),
          registerProvider: () => {},
          setRuntimeApiKey: async () => {},
        }),
      },
      SettingsManager: { inMemory: () => ({}) },
      DefaultResourceLoader: class {
        async reload() {}
        getSkills() {
          return { skills: [] };
        }
      },
      SessionManager: { create: () => ({}), open: () => ({}) },
      createAgentSession: async () => {
        let listener: (event: any) => void = () => {};
        const reply = (text: string) =>
          listener({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "stop",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: 0 },
              },
              content: [{ type: "text", text }],
              timestamp: Date.now(),
            },
          });
        const session = {
          sessionId: "fake-late-steer",
          pendingMessageCount: 0,
          agent: {
            continue: async () => {
              continues++;
              // Pi injects the queued steer as a user message, then answers.
              const text = steered.shift()!;
              session.pendingMessageCount--;
              listener({
                type: "message_end",
                message: {
                  role: "user",
                  content: [{ type: "text", text }],
                  timestamp: Date.now(),
                },
              });
              reply("done with the icon");
              listener({ type: "agent_settled" });
            },
          },
          state: { tools: [] },
          getLastAssistantText: () => "done with the icon",
          setSteeringMode: () => {},
          subscribe: (fn: (event: any) => void) => {
            listener = fn;
            return () => {};
          },
          prompt: async () => {
            reply("ok");
            // The steer lands after the last model boundary and before the
            // prompt resolves; its image staging is still in flight when the
            // pump sees the settled prompt.
            expect(steerPiRun(sessionKey, "Use this icon", [png], "s1")).toBe(
              true,
            );
            listener({ type: "agent_settled" });
          },
          steer: async (text: string) => {
            steered.push(text);
            session.pendingMessageCount++;
          },
          clearQueue: () => {
            steered.length = 0;
            session.pendingMessageCount = 0;
          },
          abort: async () => {},
          abortRetry: () => {},
          dispose: () => {},
        };
        return { session };
      },
    };

    const sdkState = globalThis as any;
    const previousSdkPromise = sdkState.__piSdkPromise;
    sdkState.__piSdkPromise = Promise.resolve(fakeSdk);
    try {
      const events = await collect("pi/openai/gpt-6.1-sol", {
        accountId: "k1",
        accountStrict: true,
        sessionId: sessionKey,
        scratchDir,
        disableLocalWorkspaceTools: true,
      });
      expect(continues).toBe(1);
      expect(events.find((event) => event.type === "steer_delivered")).toEqual({
        type: "steer_delivered",
        steerId: "s1",
      });
      expect(events.find((event) => event.type === "done")).toMatchObject({
        result: "done with the icon",
      });
    } finally {
      sdkState.__piSdkPromise = previousSdkPromise;
      rmSync(join(PI_STATE_DIR, "sessions", sessionKey), {
        recursive: true,
        force: true,
      });
    }
  });

  // A run host that died mid-turn left a tool call without a result and a
  // reply half streamed. The next turn on that Pi session must close the call
  // with what it had produced, hand the reply back to the model, and clear
  // the checkpoint once it ends normally.
  test("a turn after a dead one repairs its tool calls and keeps its reply", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        accounts: [
          {
            id: "k1",
            name: "org-key",
            kind: "api_key",
            value: "test-remote-runtime-key",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const sdk = await import("@earendil-works/pi-coding-agent");
    const transcriptSessionId = `pi-resume-${crypto.randomUUID()}`;
    const sessionDir = join(PI_STATE_DIR, "sessions", transcriptSessionId);
    mkdirSync(sessionDir, { recursive: true });
    const scratchDir = join(dir, `scratch-${transcriptSessionId}`);
    mkdirSync(scratchDir, { recursive: true });

    const previous = sdk.SessionManager.create(dir, sessionDir);
    previous.appendMessage({
      role: "user",
      content: "push the branch",
      timestamp: Date.now(),
    } as any);
    previous.appendMessage({
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "call-push", name: "bash", arguments: {} },
      ],
      timestamp: Date.now(),
    } as any);
    const piSessionId = previous.getSessionId();
    const checkpointPath = join(sessionDir, "turn-checkpoint.json");
    writeFileSync(
      checkpointPath,
      JSON.stringify({
        version: 1,
        piSessionId,
        updatedAt: new Date().toISOString(),
        reply: {
          id: "reply-cut",
          text: "The push is halfway",
          startedAt: new Date().toISOString(),
        },
        tools: { "call-push": { toolName: "bash", output: "Enumerating" } },
      }),
    );

    let seenResults: any[] = [];
    let seenPrompt = "";
    const fakeSdk = {
      ModelRuntime: {
        create: async () => ({
          getModel: (_provider: string, id: string) => ({ id, name: id }),
          registerProvider: () => {},
          setRuntimeApiKey: async () => {},
        }),
      },
      SettingsManager: { inMemory: () => ({}) },
      DefaultResourceLoader: class {
        async reload() {}
        getSkills() {
          return { skills: [] };
        }
      },
      SessionManager: sdk.SessionManager,
      createAgentSession: async ({ sessionManager }: any) => {
        seenResults = sdk
          .buildSessionContext(sessionManager.getEntries())
          .messages.filter((m: any) => m.role === "toolResult");
        let listener: (event: any) => void = () => {};
        const session = {
          sessionId: sessionManager.getSessionId(),
          pendingMessageCount: 0,
          agent: { continue: async () => {} },
          state: { tools: [] },
          getLastAssistantText: () => "pushed",
          setSteeringMode: () => {},
          subscribe: (fn: (event: any) => void) => {
            listener = fn;
            return () => {};
          },
          prompt: async (text: string) => {
            seenPrompt = text;
            listener({
              type: "message_start",
              message: { role: "assistant" },
            });
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                stopReason: "stop",
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: { total: 0 },
                },
                content: [{ type: "text", text: "pushed" }],
                timestamp: Date.now(),
              },
            });
            listener({ type: "agent_settled" });
          },
          abort: async () => {},
          abortRetry: () => {},
          dispose: () => {},
        };
        return { session };
      },
    };

    const sdkState = globalThis as any;
    const previousSdkPromise = sdkState.__piSdkPromise;
    sdkState.__piSdkPromise = Promise.resolve(fakeSdk);
    try {
      const events = await collect("pi/openai/gpt-6.1-sol", {
        accountId: "k1",
        accountStrict: true,
        sessionId: piSessionId,
        transcriptSessionId,
        scratchDir,
        disableLocalWorkspaceTools: true,
      });
      expect(seenResults).toHaveLength(1);
      expect(seenResults[0]).toMatchObject({
        toolCallId: "call-push",
        isError: true,
      });
      expect(seenResults[0].content[0].text).toContain("Enumerating");
      expect(seenPrompt).toContain("The push is halfway");
      expect(seenPrompt).toContain('source="restart-recovery"');
      expect(
        events.find((event) => event.type === "runner_notice"),
      ).toMatchObject({
        text: expect.stringContaining("1 tool call it was running is marked"),
      });
      expect(events.find((event) => event.type === "done")).toBeDefined();
      expect(existsSync(checkpointPath)).toBe(false);
    } finally {
      sdkState.__piSdkPromise = previousSdkPromise;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test("expired ChatGPT access token → flagged terminal (dry-pool parity)", async () => {
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor((Date.now() - 60_000) / 1000) }),
    ).toString("base64url");
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: `h.${payload}.s` } }),
    );
    writeFileSync(
      storePath,
      JSON.stringify({
        accounts: [
          {
            id: "h1",
            name: "pool-home",
            kind: "home",
            value: codexHome,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const events = await collect("pi/openai/gpt-6.1-sol");
    const err = events.find((e) => e.type === "error")!;
    expect(err).toBeDefined();
    expect(String(err.content)).toContain("expired");
    expect(err.usageLimitExhausted).toBe(true);
  });

  /** A "home" codex account whose ChatGPT token expires inside pi's 6-minute
   *  refresh window — the placeholder refresh deliberately fails there, so the
   *  turn ends flagged (dry-pool parity) with a message NAMING the account.
   *  That is what lets a rotation test assert which account the turn ended on
   *  without an engine or a network call. */
  const expiringHomeAccount = (id: string): Record<string, unknown> => {
    const home = join(dir, `codex-home-${id}`);
    mkdirSync(home, { recursive: true });
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor((Date.now() + 120_000) / 1000) }),
    ).toString("base64url");
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({ tokens: { access_token: `h.${payload}.s` } }),
    );
    return {
      id,
      name: id,
      kind: "home",
      value: home,
      createdAt: new Date().toISOString(),
    };
  };

  test("a pre-init usage failure rotates to the next account inside the same turn", async () => {
    const ids = ["rot-a", "rot-b", "rot-c", "rot-d", "rot-e", "rot-f"];
    writeFileSync(
      storePath,
      JSON.stringify({
        accounts: ids.map(expiringHomeAccount),
      }),
    );
    // Non-strict pin: attempt 1 is deterministically rot-a. Burning it adds
    // it to the walk's exclusion, which makes the picker skip its pin branch,
    // so attempt 2 falls to the pool and lands on rot-b.
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    const events = await collect("pi/openai/gpt-6.1-sol", {
      accountId: "rot-a",
    });
    const switches = warnings.mock.calls.filter(([message]) =>
      String(message).includes("[pi-runner] usage limit on codex account"),
    );
    warnings.mockRestore();
    const errors = events.filter((e) => e.type === "error");
    // ONE terminal for the whole walk: a rotation replays the attempt, never
    // the caller-visible stream.
    expect(errors).toHaveLength(1);
    // Six failed accounts require five switches. The old hard ceiling only
    // made three before stopping after its fourth attempt.
    expect(switches).toHaveLength(5);
    expect(String(errors[0].content)).not.toContain("rot-a");
    expect(errors[0].usageLimitExhausted).toBe(true);
  });

  test.each([
    { streamed: false, strict: false, cancel: false, dry: false },
    { streamed: true, strict: false, cancel: false, dry: false },
    { streamed: true, strict: true, cancel: false, dry: false },
    { streamed: true, strict: false, cancel: true, dry: false },
    { streamed: true, strict: false, cancel: false, dry: true },
  ])(
    "in-band account rotation %j",
    async ({ streamed, strict, cancel, dry }) => {
      const servingHomeAccount = (id: string, providerAccountId: string) => {
        const home = join(dir, `codex-home-${id}`);
        mkdirSync(home, { recursive: true });
        const payload = Buffer.from(
          JSON.stringify({
            exp: Math.floor((Date.now() + 60 * 60_000) / 1000),
          }),
        ).toString("base64url");
        writeFileSync(
          join(home, "auth.json"),
          JSON.stringify({
            tokens: {
              access_token: `h.${payload}.s`,
              account_id: providerAccountId,
            },
          }),
        );
        return {
          id,
          name: id,
          kind: "home",
          value: home,
          createdAt: new Date().toISOString(),
        };
      };

      const firstAccountId = `live-a-${crypto.randomUUID()}`;
      writeFileSync(
        storePath,
        JSON.stringify({
          accounts: [
            servingHomeAccount(firstAccountId, "provider-a"),
            ...(dry
              ? []
              : [
                  {
                    id: "live-b",
                    name: "live-b",
                    kind: "api_key",
                    value: "sk-provider-b",
                    createdAt: new Date().toISOString(),
                  },
                ]),
          ],
        }),
      );

      const prompts: string[] = [];
      const managers: Array<{ completedActions: number }> = [];
      let completedActions = 0;
      const usedProviderAccounts: string[] = [];
      const transportSettings: Array<Record<string, unknown>> = [];
      const fakeSdk = {
        ModelRuntime: {
          create: async ({ credentials }: any) => {
            const auth = await credentials.read("openai-codex");
            const runtime = {
              providerAccountId: String(auth?.accountId || ""),
              getModel: (_provider: string, id: string) => ({ id, name: id }),
              registerProvider: () => {},
              setRuntimeApiKey: async (provider: string, key: string) => {
                if (provider === "openai" && key === "sk-provider-b") {
                  runtime.providerAccountId = "provider-b";
                }
              },
            };
            return runtime;
          },
        },
        SettingsManager: {
          inMemory: (settings: Record<string, unknown>) => {
            transportSettings.push(settings);
            return {};
          },
        },
        DefaultResourceLoader: class {
          async reload() {}
          getSkills() {
            return { skills: [] };
          }
        },
        SessionManager: {
          create: () => ({ completedActions: 0 }),
          open: () => ({ completedActions: 0 }),
        },
        createAgentSession: async ({ modelRuntime, sessionManager }: any) => {
          const providerAccountId = String(modelRuntime.providerAccountId);
          usedProviderAccounts.push(providerAccountId);
          managers.push(sessionManager);
          const limited = providerAccountId === "provider-a";
          let listener: (event: any) => void = () => {};
          const session = {
            sessionId: `fake-${providerAccountId}`,
            sessionManager,
            pendingMessageCount: 0,
            agent: { continue: async () => {} },
            setSteeringMode: () => {},
            subscribe: (fn: (event: any) => void) => {
              listener = fn;
              return () => {};
            },
            prompt: async (prompt: string) => {
              prompts.push(prompt);
              if (streamed && prompt.endsWith("\n\nhi")) {
                completedActions++;
                sessionManager.completedActions++;
                listener({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    stopReason: "toolUse",
                    content: [{ type: "text", text: "Working on it" }],
                    usage: {
                      input: 11,
                      output: 7,
                      cacheRead: 3,
                      cacheWrite: 2,
                      cost: { total: 0.5 },
                    },
                    timestamp: Date.now(),
                  },
                });
                listener({
                  type: "tool_execution_start",
                  toolCallId: "completed-action",
                  toolName: "bash",
                  args: { command: "do-once" },
                });
                // A codemode script's own call: pi never persists it, so
                // it must not become a live card either.
                listener({
                  type: "tool_execution_start",
                  toolCallId: "completed-action/1",
                  parentToolCallId: "completed-action",
                  toolName: "read",
                  args: { path: "a.txt" },
                });
                listener({
                  type: "tool_execution_end",
                  toolCallId: "completed-action/1",
                  parentToolCallId: "completed-action",
                  toolName: "read",
                  result: { content: [{ type: "text", text: "nested" }] },
                  isError: false,
                });
                listener({
                  type: "tool_execution_end",
                  toolCallId: "completed-action",
                  toolName: "bash",
                  result: { content: [{ type: "text", text: "done" }] },
                  isError: false,
                });
              }
              listener({
                type: "message_end",
                message: {
                  role: "assistant",
                  stopReason: limited ? "error" : "stop",
                  errorMessage: limited
                    ? "Codex error: The usage limit has been reached"
                    : undefined,
                  usage: {
                    input: limited ? 0 : 1,
                    output: limited ? 0 : 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    cost: { total: 0 },
                  },
                  content: limited ? [] : [{ type: "text", text: "ok" }],
                  timestamp: Date.now(),
                },
              });
              listener({ type: "agent_settled" });
            },
            getLastAssistantText: () => (limited ? "" : "ok"),
            steer: async () => {},
            abort: async () => {},
            abortRetry: () => {},
            dispose: () => {
              if (cancel && limited) cancelPiRun(sessionKey);
            },
          };
          return { session };
        },
      };

      const sdkState = globalThis as any;
      const previousSdkPromise = sdkState.__piSdkPromise;
      const sessionKey = `pi-inband-limit-${crypto.randomUUID()}`;
      sdkState.__piSdkPromise = Promise.resolve(fakeSdk);
      const warnings = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const events = await collect("pi/openai/gpt-6.1-sol", {
          accountId: firstAccountId,
          accountStrict: strict,
          sessionId: sessionKey,
          disableLocalWorkspaceTools: true,
        });
        if (strict || cancel || dry) {
          expect(usedProviderAccounts).toEqual(["provider-a"]);
          expect(events.filter((event) => event.type === "done")).toHaveLength(
            0,
          );
          const errors = events.filter((event) => event.type === "error");
          expect(errors).toHaveLength(cancel ? 0 : 1);
          if (!cancel) expect(errors[0].usageLimitExhausted).toBe(true);
          return;
        }
        expect(usedProviderAccounts).toEqual(["provider-a", "provider-b"]);
        if (streamed) {
          expect(managers[1]).toBe(managers[0]);
          expect(managers[1].completedActions).toBe(1);
          expect(completedActions).toBe(1);
          expect(prompts).toHaveLength(2);
          expect(prompts[1]).toContain('source="auto-continue"');
          expect(prompts[1]).not.toEndWith("\n\nhi");
          expect(
            events.filter((event) => event.type === "tool_use"),
          ).toHaveLength(1);
          expect(
            events.filter((event) => event.type === "tool_result"),
          ).toHaveLength(1);
          expect(
            events.find((event) => event.type === "done")?.usage,
          ).toMatchObject({
            inputTokens: 12,
            outputTokens: 8,
            cacheReadTokens: 3,
            cacheCreationTokens: 2,
            costUsd: 0.5,
          });
        }
        // Subscription traffic skips the experimental ChatGPT WebSocket, whose
        // mid-stream 1006 failures otherwise force a visible whole-step retry.
        // The API-key rotation still uses Pi's ordinary provider defaults.
        expect(transportSettings).toEqual([
          { cacheWarming: "off", transport: "sse" },
          { cacheWarming: "off" },
        ]);
        expect(events.filter((event) => event.type === "init")).toHaveLength(2);
        expect(events.filter((event) => event.type === "error")).toHaveLength(
          0,
        );
        expect(events.find((event) => event.type === "done")).toMatchObject({
          model: "pi/openai/gpt-6.1-sol",
          result: "ok",
        });
      } finally {
        warnings.mockRestore();
        sdkState.__piSdkPromise = previousSdkPromise;
        rmSync(join(PI_STATE_DIR, "sessions", sessionKey), {
          recursive: true,
          force: true,
        });
      }
    },
  );

  test("a strict pin refuses instead of rotating off the pinned account", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        accounts: [expiringHomeAccount("pin-a"), expiringHomeAccount("pin-b")],
      }),
    );
    const events = await collect("pi/openai/gpt-6.1-sol", {
      accountId: "pin-a",
      accountStrict: true,
    });
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    // A hard pin is an explicit choice: never silently move onto an account
    // the person did not pick.
    expect(String(errors[0].content)).toContain("pin-a");
    expect(String(errors[0].content)).not.toContain("pin-b");
  });

  test("a transcript alias admits only one run and is cleaned up", async () => {
    writeFileSync(storePath, JSON.stringify({ accounts: [] }));
    const transcriptSessionId = `pi-shared-transcript-${crypto.randomUUID()}`;
    const firstRunKey = `pi-first-${crypto.randomUUID()}`;
    const secondRunKey = `pi-second-${crypto.randomUUID()}`;
    const runOpts = {
      prompt: "hi",
      cwd: dir,
      mode: "ask" as const,
      mcpServers: [],
      journal: { kind: "prompt" },
      transcriptSessionId,
    };
    const first = runPi(
      { ...runOpts, sessionId: firstRunKey },
      "pi/openai/gpt-6.1-sol",
    );

    const firstError = await first.next();
    expect(firstError.value).toMatchObject({
      type: "error",
      usageLimitExhausted: true,
    });
    expect(isPiSessionBusy(firstRunKey)).toBe(true);
    expect(isPiSessionBusy(transcriptSessionId)).toBe(true);

    const second = runPi(
      { ...runOpts, sessionId: secondRunKey },
      "pi/openai/gpt-6.1-sol",
    );
    const busy = await second.next();
    expect(busy.value).toMatchObject({
      type: "error",
      content: "Session is busy",
    });
    expect(isPiSessionBusy(secondRunKey)).toBe(false);
    expect(isPiSessionBusy(transcriptSessionId)).toBe(true);

    expect((await second.next()).done).toBe(true);
    expect((await first.next()).done).toBe(true);
    expect(isPiSessionBusy(firstRunKey)).toBe(false);
    expect(isPiSessionBusy(secondRunKey)).toBe(false);
    expect(isPiSessionBusy(transcriptSessionId)).toBe(false);
  });
});

describe("local-tool path containment", () => {
  const ws = mkdtempSync(join(tmpdir(), "pi-guard-"));
  const realWs = realpathSync(ws);
  mkdirSync(join(ws, "sub"));
  writeFileSync(join(ws, "sub", "inside.txt"), "needle-inside\n");
  writeFileSync(join(ws, "top.ts"), "export {};\n");
  symlinkSync("/etc", join(ws, "esc"));
  afterAll(() => rmSync(ws, { recursive: true, force: true }));

  test("assertContainedPiPath allows workspace paths, incl. not-yet-created ones", () => {
    expect(assertContainedPiPath(join(ws, "sub", "inside.txt"), realWs)).toBe(
      join(realWs, "sub", "inside.txt"),
    );
    expect(assertContainedPiPath(ws, realWs)).toBe(realWs);
    // write/edit targets that don't exist yet are contained via their
    // nearest existing ancestor
    expect(assertContainedPiPath(join(ws, "newdir", "new.txt"), realWs)).toBe(
      join(realWs, "newdir", "new.txt"),
    );
  });

  test("rejects absolute escapes, /proc//sys//dev, and .. traversal", () => {
    expect(() => assertContainedPiPath("/etc/passwd", realWs)).toThrow(
      /outside the session workspace/,
    );
    expect(() => assertContainedPiPath("/proc/self/environ", realWs)).toThrow(
      /not accessible/,
    );
    expect(() => assertContainedPiPath("/sys/kernel", realWs)).toThrow(
      /not accessible/,
    );
    expect(() => assertContainedPiPath("/dev/stdin", realWs)).toThrow(
      /not accessible/,
    );
    expect(() =>
      assertContainedPiPath(
        join(ws, "..", "..", "..", "..", "etc", "passwd"),
        realWs,
      ),
    ).toThrow(/outside the session workspace|not accessible/);
  });

  test("rejects symlink escapes, existing and dangling targets", () => {
    expect(() =>
      assertContainedPiPath(join(ws, "esc", "passwd"), realWs),
    ).toThrow(/outside the session workspace|not accessible/);
    // non-existent path UNDER an escaping symlink still resolves out
    expect(() =>
      assertContainedPiPath(join(ws, "esc", "nope", "x.txt"), realWs),
    ).toThrow(/outside the session workspace|not accessible/);
  });

  test("guarded read/ls/write ops enforce containment; inside paths work", async () => {
    const ops = makeGuardedToolOps(ws);
    expect(
      (await ops.read.readFile(join(ws, "sub", "inside.txt"))).toString(),
    ).toContain("needle-inside");
    await expect(ops.read.readFile("/etc/passwd")).rejects.toThrow(/outside/);
    await expect(ops.read.access("/proc/self/environ")).rejects.toThrow(
      /not accessible/,
    );
    await expect(ops.read.readFile(join(ws, "esc", "passwd"))).rejects.toThrow(
      /outside/,
    );
    expect(await ops.ls.readdir(ws)).toContain("sub");
    await expect(ops.ls.readdir("/etc")).rejects.toThrow(/outside/);
    await ops.write.mkdir(join(ws, "made"));
    await ops.write.writeFile(join(ws, "made", "ok.txt"), "ok");
    expect(
      (await ops.read.readFile(join(ws, "made", "ok.txt"))).toString(),
    ).toBe("ok");
    await expect(
      ops.write.writeFile("/tmp/pi-guard-escape.txt", "x"),
    ).rejects.toThrow(/outside/);
    await expect(ops.edit.access("/etc/hosts")).rejects.toThrow(/outside/);
  });

  test("guarded ops also reach the session's own scratch dir, not other /tmp", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "pi-scratch-"));
    try {
      const ops = makeGuardedToolOps(ws, scratch);
      await ops.write.mkdir(join(scratch, "shots"));
      await ops.write.writeFile(join(scratch, "shots", "a.txt"), "shot");
      expect(
        (await ops.read.readFile(join(scratch, "shots", "a.txt"))).toString(),
      ).toBe("shot");
      expect(await ops.ls.readdir(scratch)).toContain("shots");
      await expect(ops.read.readFile(join(tmpdir(), "x.txt"))).rejects.toThrow(
        /\$TMPDIR/,
      );
      await expect(ops.read.access("/proc/self/environ")).rejects.toThrow(
        /not accessible/,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("guarded find.glob walks in-process, contained, with ignores", async () => {
    const ops = makeGuardedToolOps(ws);
    const hits = await ops.find.glob("*.ts", ws, {
      ignore: ["**/node_modules/**", "**/.git/**"],
      limit: 100,
    });
    expect(hits).toContain(join(ws, "top.ts"));
    await expect(
      Promise.resolve(ops.find.glob("*", "/etc", { ignore: [], limit: 10 })),
    ).rejects.toThrow(/outside/);
  });

  test("guarded grep rejects escapes before any rg spawn", async () => {
    const ops = makeGuardedToolOps(ws);
    const grep = makeGuardedGrepExecute(
      ws,
      { PATH: process.env.PATH || "" },
      ops.guard,
    );
    await expect(
      grep("t", { pattern: ".", path: "/proc/self/environ" }),
    ).rejects.toThrow(/not accessible/);
    await expect(grep("t", { pattern: ".", path: "/etc" })).rejects.toThrow(
      /outside/,
    );
  });

  test.skipIf(!Bun.which("rg"))(
    "guarded grep finds matches via rg with the minimal env",
    async () => {
      const ops = makeGuardedToolOps(ws);
      const grep = makeGuardedGrepExecute(
        ws,
        { PATH: process.env.PATH || "" },
        ops.guard,
      );
      const res = await grep("t", { pattern: "needle-inside", path: ws });
      expect(res.content[0]?.text).toMatch(/inside\.txt:1:/);
      expect(res.content[0]?.text).toContain("needle-inside");
    },
  );
});

test("host runs never resolve the operator's ambient gh identity", () => {
  const env = piBashHomeEnv({
    runKey: "run/unsafe",
    scratchDir: "/scratch/session",
    isolated: false,
    hostHome: "/Users/operator",
  });
  expect(env.HOME).toBe("/Users/operator");
  // gh answers from GH_TOKEN when a credential was injected; without one it
  // must fail "not logged in" rather than act as whatever identity the host's
  // ~/.config/gh/hosts.yml holds.
  expect(env.GH_CONFIG_DIR).toBe("/scratch/session/gh-config-run_unsafe");
});

test("without a GitHub App, host runs keep the host's gh login", () => {
  expect(
    piBashHomeEnv({
      runKey: "run/unsafe",
      scratchDir: "/scratch/session",
      isolated: false,
      hostHome: "/Users/operator",
      hostGithubLogin: true,
    }),
  ).toEqual({ HOME: "/Users/operator" });
  // An automation's isolated home never reaches the host login.
  expect(
    piBashHomeEnv({
      runKey: "run/unsafe",
      scratchDir: "/scratch/session",
      isolated: true,
      hostGithubLogin: true,
    }).GH_CONFIG_DIR,
  ).toBe("/scratch/session/automation-home-run_unsafe/.config/gh");
});

test("automation descendants receive an isolated CLI home", () => {
  expect(
    piBashHomeEnv({
      runKey: "run/unsafe",
      scratchDir: "/scratch/session",
      isolated: true,
      hostHome: "/Users/operator",
    }),
  ).toEqual({
    HOME: "/scratch/session/automation-home-run_unsafe",
    XDG_CONFIG_HOME: "/scratch/session/automation-home-run_unsafe/.config",
    AWS_CONFIG_FILE: "/scratch/session/automation-home-run_unsafe/.aws/config",
    AWS_SHARED_CREDENTIALS_FILE:
      "/scratch/session/automation-home-run_unsafe/.aws/credentials",
    GH_CONFIG_DIR: "/scratch/session/automation-home-run_unsafe/.config/gh",
  });
});

describe("makePiBashTool exit-gated completion", () => {
  const env = { PATH: process.env.PATH || "/usr/bin:/bin" };
  const tool = makePiBashTool({
    cwd: tmpdir(),
    env,
    gated: false,
    unattended: false,
  });

  test("enforces automation descendant publication policy before execution", async () => {
    const restricted = makePiBashTool({
      cwd: tmpdir(),
      env,
      gated: true,
      unattended: true,
      publicationPolicy: {
        repo: "tellahq/renderer",
        branch: "main",
        headBranch: "compat/layout",
      },
    });
    await expect(
      (restricted as any).execute(
        "publication-denied",
        { command: "gh pr merge 12 --squash" },
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/cannot merge/);
  });

  test("refuses to publish a configured private term to a public repo", async () => {
    const guarded = makePiBashTool({
      cwd: tmpdir(),
      env,
      gated: false,
      unattended: false,
      privateTermsGuard: { terms: ["intranet.acme.test"] },
    });
    await expect(
      (guarded as any).execute(
        "private-term-denied",
        {
          command: "gh pr create --title t --body 'seen on intranet.acme.test'",
        },
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/private term "intranet\.acme\.test"/);
    const res = await (guarded as any).execute(
      "private-term-read",
      { command: "echo intranet.acme.test" },
      undefined,
      undefined,
    );
    expect(res.content[0].text).toContain("intranet.acme.test");
  });

  test("a background child holding stdout does not wedge the tool", async () => {
    const started = Date.now();
    const res = (await (tool as any).execute(
      "t1",
      { command: "echo hi; sleep 15 & echo bye" },
      undefined,
      undefined,
    )) as { content: Array<{ text: string }> };
    // Old drain-gated flow blocked on the orphan's inherited pipe for the
    // full 15s (forever for a daemon); exit-gated returns after exit+grace.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.content[0]?.text).toContain("hi");
    expect(res.content[0]?.text).toContain("bye");
  });

  test("timeout kills the process group and reports promptly", async () => {
    const started = Date.now();
    await expect(
      (tool as any).execute(
        "t2",
        { command: "sleep 60", timeout: 1 },
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test("abort kills the process group and reports promptly", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const started = Date.now();
    await expect(
      (tool as any).execute(
        "t3",
        { command: "sleep 60" },
        ac.signal,
        undefined,
      ),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test("run cancellation kills bash even when Pi keeps its tool signal live", async () => {
    const runAbort = new AbortController();
    const runBoundTool = makePiBashTool({
      cwd: tmpdir(),
      env,
      gated: false,
      unattended: false,
      runSignal: runAbort.signal,
    });
    setTimeout(() => runAbort.abort(), 200);
    const started = Date.now();
    await expect(
      (runBoundTool as any).execute(
        "run-cancel",
        { command: "sleep 60" },
        undefined,
      ),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test("emits paired, redacted audit events for a successful command", async () => {
    const events: PiBashAuditEvent[] = [];
    const auditedTool = makePiBashTool({
      cwd: tmpdir(),
      env,
      gated: false,
      unattended: false,
      onAudit: (event) => events.push(event),
    });
    const command = "sleep 0.01; printf 'token=top-secret'";
    await (auditedTool as any).execute(
      "audit-ok",
      { command },
      undefined,
      undefined,
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      phase: "start",
      command_kind: "sleep",
      sleep_calls: 1,
      sleep_seconds: 0.01,
      sleep_in_loop: false,
      timeout_s: 120,
    });
    expect(events[1]).toMatchObject({
      phase: "finish",
      outcome: "ok",
      exit_code: 0,
      timed_out: false,
      cancelled: false,
    });
    expect(events[0]?.command_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(events[0]?.command_sha256).toBe(events[1]?.command_sha256);
    expect(events[1]?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toContain("top-secret");
  });

  test("tells a capped poll loop apart from a fixed sleep", async () => {
    const events: PiBashAuditEvent[] = [];
    const auditedTool = makePiBashTool({
      cwd: tmpdir(),
      env,
      gated: false,
      unattended: false,
      onAudit: (event) => events.push(event),
    });
    await (auditedTool as any).execute(
      "audit-poll",
      { command: "n=0; until [ $n -ge 1 ]; do sleep 0.01; n=1; done" },
      undefined,
      undefined,
    );
    expect(events[0]).toMatchObject({
      sleep_calls: 1,
      sleep_in_loop: true,
    });
  });

  test("records timeout and cancellation outcomes", async () => {
    const timeoutEvents: PiBashAuditEvent[] = [];
    const timeoutTool = makePiBashTool({
      cwd: tmpdir(),
      env,
      gated: false,
      unattended: false,
      onAudit: (event) => timeoutEvents.push(event),
    });
    await expect(
      (timeoutTool as any).execute("audit-timeout", {
        command: "sleep 60",
        timeout: 0.1,
      }),
    ).rejects.toThrow(/timed out/);
    expect(timeoutEvents.at(-1)).toMatchObject({
      phase: "finish",
      outcome: "timed_out",
      timed_out: true,
      cancelled: false,
    });

    const cancelEvents: PiBashAuditEvent[] = [];
    const cancelTool = makePiBashTool({
      cwd: tmpdir(),
      env,
      gated: false,
      unattended: false,
      onAudit: (event) => cancelEvents.push(event),
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(
      (cancelTool as any).execute(
        "audit-cancel",
        { command: "sleep 60" },
        ac.signal,
      ),
    ).rejects.toThrow(/aborted/i);
    expect(cancelEvents.at(-1)).toMatchObject({
      phase: "finish",
      outcome: "cancelled",
      timed_out: false,
      cancelled: true,
    });
  });
});

describe("runPiSmokeTurn with the engine disabled", () => {
  test("pure dry run: config-gate error only, no bridge/SDK/store rows", async () => {
    // Force-disable regardless of the instance's real ~/.opensession-pi.json —
    // this test must never execute a live turn (OPENSESSION_PI_CONFIG is the
    // documented test seam and pi-config reads it fresh per call).
    const prev = process.env.OPENSESSION_PI_CONFIG;
    process.env.OPENSESSION_PI_CONFIG = "/nonexistent/opensession-pi-test.json";
    try {
      const res = await runPiSmokeTurn({ timeoutMs: 5_000 });
      expect(res.ok).toBe(false);
      expect(res.enabled).toBe(false);
      expect(res.dryRun).toBe(true);
      expect(res.eventTypes).toEqual(["error"]);
      expect(res.error || "").toContain("not enabled");
      expect(res.error).toContain(process.env.OPENSESSION_PI_CONFIG!);
      expect(res.reason).toContain(process.env.OPENSESSION_PI_CONFIG!);
      expect(res.reason || "").toContain("disabled");
      expect(res.storeRows).toBe(0);
      expect(res.timedOut).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OPENSESSION_PI_CONFIG;
      else process.env.OPENSESSION_PI_CONFIG = prev;
    }
  });
});
