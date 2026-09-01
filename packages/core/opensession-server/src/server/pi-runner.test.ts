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
  isPiSessionBusy,
  isPiUsageLimitShape,
  makeGuardedGrepExecute,
  makeGuardedToolOps,
  makePiBashTool,
  parsePiModel,
  piBashHomeEnv,
  piAssistantTranscriptEntries,
  PI_STATE_DIR,
  PI_STEER_TOOL_SKIP,
  piDialOracleAgent,
  piGateReason,
  piStreamEventBlocksAccountRotation,
  piSteeringBoundaryTools,
  piToolNames,
  resolvePiPresetWiring,
  resolvePiRoutedModel,
  resolvePiDialModel,
  retractPendingSteer,
  runPi,
  runPiSmokeTurn,
} from "./pi-runner";
import type { PiBashAuditEvent } from "./pi-runner";
import { __setCodexAccountsPathForTest } from "./codex-accounts";
import type { ResolvedWorkspaceModelPreset } from "./workspace-model-presets";

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
    expect(parsePiModel("pi/anthropic/claude-opus-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-5",
    });
  });

  test("model id may itself contain slashes", () => {
    expect(parsePiModel("pi/openrouter/meta/llama-3")).toEqual({
      providerID: "openrouter",
      modelID: "meta/llama-3",
    });
  });

  test("rejects non-pi ids and malformed remainders", () => {
    expect(parsePiModel("anthropic/claude-opus-5")).toBeNull();
    expect(parsePiModel("claude-opus-5")).toBeNull();
    expect(parsePiModel("pi/anthropic")).toBeNull();
    expect(parsePiModel("pi/anthropic/")).toBeNull();
    expect(parsePiModel("pi//claude-opus-5")).toBeNull();
  });
});

describe("resolvePiRoutedModel", () => {
  test("routes plain models and both preset families to their concrete Pi model", () => {
    expect(resolvePiRoutedModel("pi/anthropic/claude-opus-5")).toMatchObject({
      providerID: "anthropic",
      modelID: "claude-opus-5",
    });
    expect(resolvePiRoutedModel("pi/dial/opus-fable")).toMatchObject({
      providerID: "anthropic",
      modelID: "claude-opus-5",
      dial: { id: "dial/opus-fable" },
    });
    expect(resolvePiRoutedModel("pi/orchestrator/sol")).toMatchObject({
      providerID: "openai",
      modelID: "gpt-5.6-sol",
      orchestrator: { id: "orchestrator/sol" },
    });
  });

  test("rejects unknown preset ids", () => {
    expect(resolvePiRoutedModel("pi/dial/nope")).toBeNull();
    expect(resolvePiRoutedModel("pi/orchestrator/nope")).toBeNull();
    // A workspace preset id with no live workspace behind it resolves to
    // nothing rather than minting a bogus "workspace-preset" provider.
    expect(
      resolvePiRoutedModel("pi/workspace-preset/ws-not-a-workspace/nope"),
    ).toBeNull();
  });

  test("preset wiring on the STORED id survives dispatch of the concrete lead", () => {
    // agent-runner dispatches presets as their concrete model; the stored
    // session id is where the preset (and its oracle/effort) still lives.
    expect(
      resolvePiRoutedModel("pi/anthropic/claude-fable-5-1", "dial/ultra"),
    ).toMatchObject({
      providerID: "anthropic",
      modelID: "claude-fable-5-1",
      dial: { id: "dial/ultra" },
      effort: "high",
    });
    expect(
      resolvePiRoutedModel("pi/openai/gpt-5.6-sol", "pi/orchestrator/sol"),
    ).toMatchObject({
      providerID: "openai",
      modelID: "gpt-5.6-sol",
      orchestrator: { id: "orchestrator/sol" },
      effort: "xhigh",
    });
    // A non-preset stored id attaches nothing.
    const plain = resolvePiRoutedModel(
      "pi/anthropic/claude-opus-5",
      "pi/anthropic/claude-opus-5",
    );
    expect(plain?.dial).toBeUndefined();
    expect(plain?.orchestrator).toBeUndefined();
    expect(plain?.effort).toBeUndefined();
  });
});

// Workspace ("Custom") preset fixtures — the store read is the one impure
// step in resolvePiRoutedModel, so like claude-direct-policy.test.ts these
// exercise the pure wiring half on already-resolved presets.
const WS_PRESETS: Record<string, ResolvedWorkspaceModelPreset> = {
  opus: {
    id: "pi/workspace-preset/ws-test/opus",
    label: "Opus, my way",
    model: "pi/anthropic/claude-opus-5",
    effort: "xhigh",
    note: "## Workspace model preset · Opus, my way",
  },
  opusFable: {
    id: "pi/workspace-preset/ws-test/opus-fable",
    label: "Opus + Fable oracle",
    model: "pi/anthropic/claude-opus-5",
    effort: "xhigh",
    enginePresetId: "dial/opus-fable",
    note: "## Workspace model preset · Opus + Fable oracle",
  },
  lead: {
    id: "pi/workspace-preset/ws-test/lead",
    label: "Fable leads",
    model: "pi/anthropic/claude-fable-5-1",
    effort: "high",
    enginePresetId: "orchestrator/fable",
    note: "## Workspace model preset · Fable leads",
  },
};

describe("resolvePiPresetWiring (workspace presets)", () => {
  test("a routed workspace preset id resolves to its lead with the preset attached", () => {
    const out = resolvePiPresetWiring(
      "pi/workspace-preset/ws-test/opus",
      WS_PRESETS.opus,
    );
    expect(out).toMatchObject({
      providerID: "anthropic",
      modelID: "claude-opus-5",
      workspacePreset: { id: "pi/workspace-preset/ws-test/opus" },
      effort: "xhigh",
    });
    expect(out?.dial).toBeUndefined();
  });

  test("follows enginePresetId so a restated built-in keeps its oracle", () => {
    const out = resolvePiPresetWiring(
      "pi/workspace-preset/ws-test/opus-fable",
      WS_PRESETS.opusFable,
    );
    expect(out).toMatchObject({
      modelID: "claude-opus-5",
      dial: { id: "dial/opus-fable", oracleAgent: "oracle-fable" },
      // The workspace preset's own pin outranks the built-in tier's.
      effort: "xhigh",
    });
  });

  test("follows enginePresetId on the orchestrator side too", () => {
    const out = resolvePiPresetWiring(
      "pi/workspace-preset/ws-test/lead",
      WS_PRESETS.lead,
    );
    expect(out).toMatchObject({
      modelID: "claude-fable-5-1",
      orchestrator: { id: "orchestrator/fable" },
      effort: "high",
    });
  });

  test("wiring rides the stored id while the routed id is the concrete lead", () => {
    // The agent-runner path: dispatch got the lead, opts.model kept the preset.
    const out = resolvePiPresetWiring(
      "pi/anthropic/claude-opus-5",
      WS_PRESETS.opusFable,
      ["pi/anthropic/claude-opus-5", WS_PRESETS.opusFable.id],
    );
    expect(out).toMatchObject({
      modelID: "claude-opus-5",
      dial: { id: "dial/opus-fable" },
      effort: "xhigh",
    });
  });

  test("an unknown enginePresetId is ignored rather than faked", () => {
    const out = resolvePiPresetWiring("pi/workspace-preset/ws-test/opus", {
      ...WS_PRESETS.opus,
      enginePresetId: "dial/not-real",
    });
    expect(out?.dial).toBeUndefined();
    expect(out?.modelID).toBe("claude-opus-5");
  });
});

describe("piDialOracleAgent (same-bridge semantics)", () => {
  test("keeps the preset's oracle when the account family matches", () => {
    expect(piDialOracleAgent("oracle-fable", "anthropic")).toBe("oracle-fable");
    expect(piDialOracleAgent("oracle-sol", "openai")).toBe("oracle-sol");
  });

  test("substitutes the same-bridge alternate across families", () => {
    // dial/ultra on a pi/anthropic run: Sol → Opus, like every other engine.
    expect(piDialOracleAgent("oracle-sol", "anthropic")).toBe("oracle-opus");
    // dial/high on a pi/openai run: Fable → Terra.
    expect(piDialOracleAgent("oracle-fable", "openai")).toBe("oracle-terra");
  });

  test("third-party providers keep the preset's own choice", () => {
    expect(piDialOracleAgent("oracle-sol", "wafer")).toBe("oracle-sol");
    expect(piDialOracleAgent("oracle-fable", "cerebras")).toBe("oracle-fable");
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
    const models = plan.config.models as Array<Record<string, unknown>>;
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
    const models = plan.config.models as Array<Record<string, unknown>>;
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

describe("resolvePiDialModel", () => {
  test("keeps regular Pi models unchanged", () => {
    expect(resolvePiDialModel("pi/anthropic/claude-opus-5")).toMatchObject({
      providerID: "anthropic",
      modelID: "claude-opus-5",
    });
  });

  test("routes a Pi Dial preset to its main model while retaining the preset", () => {
    const resolved = resolvePiDialModel("pi/dial/ultra");
    expect(resolved).toMatchObject({
      providerID: "anthropic",
      modelID: "claude-fable-5-1",
      dial: { id: "dial/ultra", effort: "high", oracleAgent: "oracle-sol" },
    });
  });

  test("rejects unknown Pi preset ids", () => {
    expect(resolvePiDialModel("pi/dial/not-real")).toBeNull();
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
});

describe("pi/openai in-band account rotation gate", () => {
  test("zero-token usage bookkeeping does not strand the rest of the account pool", () => {
    // Pi emits init → usage_snapshot(0) → stopReason:error for a provider
    // usage limit. The terminal is handled after the queue drains, so the
    // snapshot must not masquerade as assistant output and block rotation.
    expect(piStreamEventBlocksAccountRotation({ type: "init" })).toBe(false);
    expect(piStreamEventBlocksAccountRotation({ type: "usage_snapshot" })).toBe(
      false,
    );

    // Real output and durable operational notices still make replay unsafe.
    expect(piStreamEventBlocksAccountRotation({ type: "text_chunk" })).toBe(
      true,
    );
    expect(piStreamEventBlocksAccountRotation({ type: "tool_use" })).toBe(true);
    expect(piStreamEventBlocksAccountRotation({ type: "tool_result" })).toBe(
      true,
    );
    expect(piStreamEventBlocksAccountRotation({ type: "runner_notice" })).toBe(
      true,
    );
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
    const events = await collect("pi/openai/gpt-5.6-sol");
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
          getActiveToolNames: () => [],
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
      const events = await collect("pi/openai/gpt-5.6-sol", {
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
    const events = await collect("pi/openai/gpt-5.6-sol");
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
    const events = await collect("pi/openai/gpt-5.6-sol", {
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

  test("an in-band zero-usage limit rotates before model fallback", async () => {
    const servingHomeAccount = (id: string, providerAccountId: string) => {
      const home = join(dir, `codex-home-${id}`);
      mkdirSync(home, { recursive: true });
      const payload = Buffer.from(
        JSON.stringify({ exp: Math.floor((Date.now() + 60 * 60_000) / 1000) }),
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

    writeFileSync(
      storePath,
      JSON.stringify({
        accounts: [
          servingHomeAccount("live-a", "provider-a"),
          {
            id: "live-b",
            name: "live-b",
            kind: "api_key",
            value: "sk-provider-b",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );

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
        create: () => ({}),
        open: () => ({}),
      },
      createAgentSession: async ({ modelRuntime }: any) => {
        const providerAccountId = String(modelRuntime.providerAccountId);
        usedProviderAccounts.push(providerAccountId);
        const limited = providerAccountId === "provider-a";
        let listener: (event: any) => void = () => {};
        const session = {
          sessionId: `fake-${providerAccountId}`,
          pendingMessageCount: 0,
          agent: { continue: async () => {} },
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
          dispose: () => {},
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
      const events = await collect("pi/openai/gpt-5.6-sol", {
        accountId: "live-a",
        sessionId: sessionKey,
        disableLocalWorkspaceTools: true,
      });
      expect(usedProviderAccounts).toEqual(["provider-a", "provider-b"]);
      // Subscription traffic skips the experimental ChatGPT WebSocket, whose
      // mid-stream 1006 failures otherwise force a visible whole-step retry.
      // The API-key rotation still uses Pi's ordinary provider defaults.
      expect(transportSettings).toEqual([{ transport: "sse" }, {}]);
      expect(events.filter((event) => event.type === "init")).toHaveLength(2);
      expect(events.filter((event) => event.type === "error")).toHaveLength(0);
      expect(events.find((event) => event.type === "done")).toMatchObject({
        model: "pi/openai/gpt-5.6-sol",
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
  });

  test("a strict pin refuses instead of rotating off the pinned account", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        accounts: [expiringHomeAccount("pin-a"), expiringHomeAccount("pin-b")],
      }),
    );
    const events = await collect("pi/openai/gpt-5.6-sol", {
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
      "pi/openai/gpt-5.6-sol",
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
      "pi/openai/gpt-5.6-sol",
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
      expect(res.reason || "").toContain("disabled");
      expect(res.storeRows).toBe(0);
      expect(res.timedOut).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OPENSESSION_PI_CONFIG;
      else process.env.OPENSESSION_PI_CONFIG = prev;
    }
  });
});
