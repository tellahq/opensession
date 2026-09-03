/**
 * Unit tests for the sandbox provider-status surface (GET /api/sandbox/status
 * serves sandboxCapabilityStatus() verbatim — the route itself is a one-liner,
 * so this IS the endpoint's behavior) and for resolveRequestedSandbox, the
 * create-path validator behind the per-session provider picker.
 *
 * Config is pointed at a scratch file via OPENSESSION_SANDBOX_CONFIG (read fresh
 * per call), saved/restored so the rest of the suite never sees it. The
 * kill-switch file lives under OPENSESSION_SESSIONS_DIR; expectations read the live
 * sandboxesEnabled() instead of assuming it, so a dev box with the switch on
 * still passes.
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
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SANDBOX_MODEL_FAMILIES,
  SANDBOX_PROVIDER_CERTIFICATIONS,
  resolveRequestedSandbox,
  sandboxableModelFamily,
  sandboxConfig,
  sandboxCapabilityStatus,
  sandboxModelFamilyFor,
  sandboxProviderConfigured,
  sandboxProviderUsability,
  sandboxesEnabled,
  setWorkspaceSandboxDefault,
} from "./config";
import { resolveInteractiveSandbox } from "./defaults";
import {
  connectSandboxProvider,
  setSandboxConnectionQualification,
} from "./connections";

let scratch: string;
let prevEnvConfig: string | undefined;
let prevE2bKey: string | undefined;
let prevSecretsStore: string | undefined;
let prevInstanceConfig: string | undefined;
const cfgPath = () => join(scratch, "sandbox.json");
const instanceCfgPath = () => join(scratch, "config.json");

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "bks-sandbox-status-"));
  prevEnvConfig = process.env.OPENSESSION_SANDBOX_CONFIG;
  prevE2bKey = process.env.E2B_API_KEY;
  prevSecretsStore = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  prevInstanceConfig = process.env.OPENSESSION_CONFIG;
  process.env.OPENSESSION_SANDBOX_CONFIG = cfgPath();
  process.env.OPENSESSION_CONFIG = instanceCfgPath();
  delete process.env.E2B_API_KEY;
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(
    scratch,
    "secrets.json",
  );
});

afterEach(() => {
  for (const path of [cfgPath(), instanceCfgPath()]) {
    try {
      unlinkSync(path);
    } catch {}
  }
});

afterAll(() => {
  if (prevEnvConfig === undefined)
    delete process.env.OPENSESSION_SANDBOX_CONFIG;
  else process.env.OPENSESSION_SANDBOX_CONFIG = prevEnvConfig;
  if (prevE2bKey !== undefined) process.env.E2B_API_KEY = prevE2bKey;
  if (prevSecretsStore !== undefined)
    process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = prevSecretsStore;
  else delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  if (prevInstanceConfig !== undefined)
    process.env.OPENSESSION_CONFIG = prevInstanceConfig;
  else delete process.env.OPENSESSION_CONFIG;
  rmSync(scratch, { recursive: true, force: true });
});

const write = (cfg: object) => writeFileSync(cfgPath(), JSON.stringify(cfg));
const writeIngress = (publicBaseUrl: string) =>
  writeFileSync(
    instanceCfgPath(),
    JSON.stringify({ ingress: { publicBaseUrl, exposure: "custom" } }),
  );
const ready = (provider: "docker" | "daytona" | "box" | "modal") => {
  connectSandboxProvider(
    provider,
    provider === "daytona" || provider === "box"
      ? { secret: `test-${provider}-key` }
      : provider === "modal"
        ? { tokenId: "test-modal-id", tokenSecret: "test-modal-secret" }
        : {},
  );
  setSandboxConnectionQualification(provider, { status: "ready" });
};

describe("sandboxCapabilityStatus (the /api/sandbox/status payload)", () => {
  test("certification requires both behavioral and warm-restore evidence", () => {
    for (const certification of Object.values(
      SANDBOX_PROVIDER_CERTIFICATIONS,
    )) {
      if (!certification.certified) continue;
      expect(certification.behavioralPassedAt).toBeTruthy();
      expect(certification.warmRestorePassedAt).toBeTruthy();
    }
  });

  test("workspace default persists without replacing provider configuration", () => {
    write({ provider: "docker", image: "runner:test", nested: { keep: true } });
    ready("docker");
    expect(setWorkspaceSandboxDefault("docker")).toBe("docker");
    const stored = JSON.parse(readFileSync(cfgPath(), "utf-8"));
    expect(stored).toMatchObject({
      provider: "docker",
      image: "runner:test",
      nested: { keep: true },
      sessionDefault: "docker",
    });
    expect(sandboxConfig().sessionDefault).toBe("docker");
  });

  test("no config file: disabled, everything unconfigured, default local", () => {
    const s = sandboxCapabilityStatus();
    expect(s.enabled).toBe(false);
    expect(s.defaultProvider).toBe("local");
    expect(s.providers.map((p) => p.id)).toEqual([
      "docker",
      "daytona",
      "e2b",
      "box",
      "modal",
      "lambda-microvm",
    ]);
    expect(s.providers.every((p) => !p.configured)).toBe(true);
    expect(s.providers.filter((p) => p.certified).map((p) => p.id)).toEqual([
      "docker",
      "daytona",
      "box",
      "modal",
    ]);
    expect(s.killSwitch).toBe(!sandboxesEnabled());
  });

  test("a raw Docker block is not a usable workspace connection", () => {
    write({ provider: "docker", image: "opensession-runner:latest" });
    const s = sandboxCapabilityStatus();
    expect(s.enabled).toBe(true);
    expect(s.defaultProvider).toBe("local");
    expect(s.providers.find((p) => p.id === "docker")?.configured).toBe(false);
    expect(s.providers.find((p) => p.id === "docker")?.usability).toBe(
      "not_configured",
    );
    expect(sandboxProviderUsability("docker")).toEqual({
      state: "not_configured",
      configured: false,
      usable: false,
    });
    expect(s.providers.find((p) => p.id === "daytona")?.configured).toBe(false);
    expect(s.providers.find((p) => p.id === "daytona")?.note).toBeUndefined();
    expect(s.providers.find((p) => p.id === "e2b")?.configured).toBe(false);
  });

  test("remote provider without a dial-back URL carries a pointed note", () => {
    write({ provider: "docker", e2b: { apiKey: "e2b_x" } });
    ready("daytona");
    const s = sandboxCapabilityStatus();
    const d = s.providers.find((p) => p.id === "daytona")!;
    expect(d.configured).toBe(true);
    expect(d.note).toContain("no public ingress configured");
    const e = s.providers.find((p) => p.id === "e2b")!;
    expect(e.configured).toBe(true);
    expect(e.note).toContain("no public ingress configured");
  });

  test("healthy remote provider (public ingress configured) carries no note", () => {
    write({ provider: "docker" });
    writeIngress("https://example.ts.net");
    ready("daytona");
    const d = sandboxCapabilityStatus().providers.find(
      (p) => p.id === "daytona",
    )!;
    expect(d.configured).toBe(true);
    expect(d.note).toBeUndefined();
  });

  test("Modal requires both normalized workspace token credentials", () => {
    write({ provider: "modal" });
    expect(() =>
      connectSandboxProvider("modal", { tokenId: "ak-one-sided" }),
    ).toThrow();
    write({
      provider: "modal",
      callbackBaseUrl: "wss://os.example.ts.net",
    });
    ready("modal");
    const modal = sandboxCapabilityStatus().providers.find(
      (p) => p.id === "modal",
    )!;
    expect(modal.configured).toBe(true);
    expect(modal.note).toBeUndefined();
  });

  test("lambda microvm requires an image identifier", () => {
    write({ provider: "lambda-microvm", awsLambdaMicrovm: {} });
    expect(sandboxProviderConfigured("lambda-microvm")).toBe(false);
    write({
      provider: "lambda-microvm",
      awsLambdaMicrovm: {
        imageIdentifier: "arn:aws:lambda:us-east-1:123:microvm-image/test",
      },
      callbackBaseUrl: "wss://os.example.ts.net",
    });
    expect(sandboxProviderConfigured("lambda-microvm")).toBe(true);
    expect(
      sandboxCapabilityStatus().providers.find((p) => p.id === "lambda-microvm")
        ?.note,
    ).toContain("not available for new sessions");
  });

  test("lambda microvm lifecycle values are bounded", () => {
    write({
      provider: "lambda-microvm",
      awsLambdaMicrovm: {
        imageIdentifier: "arn:aws:lambda:us-east-1:123:microvm-image:test",
        maximumDurationSeconds: 99_999,
        idleSuspendSeconds: 45,
        suspendedDurationSeconds: 90.8,
      },
    });
    expect(sandboxConfig().awsLambdaMicrovm).toMatchObject({
      maximumDurationSeconds: 28_800,
      idleSuspendSeconds: undefined,
      suspendedDurationSeconds: 90,
    });
  });

  test("an explicit callbackBaseUrl also counts as dial-back configured", () => {
    write({
      provider: "docker",
      e2b: { apiKey: "e2b_x" },
      callbackBaseUrl: "wss://os.example.ts.net",
    });
    const e = sandboxCapabilityStatus().providers.find((p) => p.id === "e2b")!;
    expect(e.configured).toBe(true);
    expect(e.certified).toBe(false);
    expect(e.note).toContain("not available for new sessions");
  });

  test("a disabled publicIngress block does not count as dial-back configured", () => {
    write({
      provider: "docker",
      publicIngress: { enabled: false, publicBaseUrl: "wss://example.ts.net" },
    });
    ready("daytona");
    const d = sandboxCapabilityStatus().providers.find(
      (p) => p.id === "daytona",
    )!;
    expect(d.note).toContain("no public ingress configured");
  });

  test("garbage config = no config", () => {
    writeFileSync(cfgPath(), "{nope");
    expect(sandboxCapabilityStatus().enabled).toBe(false);
    expect(sandboxProviderConfigured("docker")).toBe(false);
  });

  test("status carries model-family sandboxability verbatim (UI's source of truth)", () => {
    expect(sandboxCapabilityStatus().modelFamilies).toBe(
      SANDBOX_MODEL_FAMILIES,
    );
  });

  test("sandbox automations require a qualified Daytona provider and dial-back URL", () => {
    write({
      provider: "daytona",
      callbackBaseUrl: "wss://sessions.example.com",
    });
    expect(sandboxCapabilityStatus().automation).toMatchObject({
      provider: "daytona",
      available: false,
    });

    ready("daytona");
    expect(sandboxCapabilityStatus().automation).toEqual({
      provider: "daytona",
      available: true,
    });
  });
});

describe("provider-independent model-family sandboxability", () => {
  test("family derivation follows the resolved engine provider", () => {
    expect(sandboxModelFamilyFor("claude-fable-5-1").id).toBe("pi");
    expect(sandboxModelFamilyFor("gpt-5.5").id).toBe("pi");
    expect(sandboxModelFamilyFor("codex").id).toBe("pi"); // alias resolves
    expect(sandboxModelFamilyFor("pi/openai/gpt-5.4-mini").id).toBe("pi");
    expect(sandboxModelFamilyFor("pi/anthropic/claude-sonnet-5").id).toBe("pi");
    expect(sandboxModelFamilyFor("pi/google/gemini-3").id).toBe("pi");
    expect(sandboxModelFamilyFor("pi/anthropic/claude-sonnet-5").id).toBe("pi");
    expect(sandboxModelFamilyFor("pi/openai/gpt-5.5").id).toBe("pi");
  });

  test("Claude, Pi, and every Pi provider are sandboxable", () => {
    for (const model of [
      "claude-fable-5-1",
      "pi/anthropic/claude-sonnet-5",
      "pi/openai/gpt-5.5",
      "pi/openai/gpt-5.6-sol",
      "pi/anthropic/claude-sonnet-5",
      "pi/google/gemini-3",
      "pi/xai/grok-4.5",
    ]) {
      expect(sandboxableModelFamily(model)).toEqual({ ok: true });
    }
  });
});

describe("resolveRequestedSandbox (create-path validation)", () => {
  test("omitted interactive choice uses defaults; explicit Host still wins", () => {
    write({ provider: "docker", sessionDefault: "docker" });
    ready("docker");
    expect(
      resolveInteractiveSandbox(
        undefined,
        "sandbox-default-test-user",
        undefined,
        "claude-fable-5-1",
      ),
    ).toEqual({ ok: true, provider: "docker" });
    expect(
      resolveInteractiveSandbox(
        "local",
        "sandbox-default-test-user",
        undefined,
        "claude-fable-5-1",
      ),
    ).toEqual({ ok: true, provider: null });
  });

  test("falsy = no sandbox", () => {
    expect(resolveRequestedSandbox(undefined)).toEqual({
      ok: true,
      provider: null,
    });
    expect(resolveRequestedSandbox(false)).toEqual({
      ok: true,
      provider: null,
    });
    expect(resolveRequestedSandbox("")).toEqual({ ok: true, provider: null });
  });

  test("true = config default provider (today's boolean behavior)", () => {
    write({ provider: "docker" });
    ready("docker");
    const r = resolveRequestedSandbox(true);
    expect(r.ok).toBe(true);
    // Kill-switch-aware like effectiveSandboxProvider — on a switched-off box
    // this resolves to local, matching the boolean path's existing semantics.
    if (r.ok) expect(r.provider).toBe(sandboxesEnabled() ? "docker" : "local");
  });

  test("explicit configured and certified provider is accepted", () => {
    write({
      provider: "docker",
      awsLambdaMicrovm: {
        imageIdentifier: "arn:aws:lambda:us-east-1:123:microvm-image/test",
      },
    });
    ready("docker");
    ready("daytona");
    ready("modal");
    expect(sandboxProviderUsability("docker")).toEqual({
      state: "usable",
      configured: true,
      usable: true,
    });
    expect(resolveRequestedSandbox("docker")).toEqual({
      ok: true,
      provider: "docker",
    });
    expect(resolveRequestedSandbox("daytona")).toEqual({
      ok: true,
      provider: "daytona",
    });
    expect(resolveRequestedSandbox("modal")).toEqual({
      ok: true,
      provider: "modal",
    });
    const lambda = resolveRequestedSandbox("lambda-microvm");
    expect(lambda.ok).toBe(false);
    if (!lambda.ok) expect(lambda.error).toContain("not live-certified");
    expect(resolveRequestedSandbox("DOCKER")).toEqual({
      ok: true,
      provider: "docker",
    });
  });

  test("configured adapters without a live certification are cut from new sessions", () => {
    write({
      provider: "e2b",
      e2b: { apiKey: "e2b_x" },
      awsLambdaMicrovm: { imageIdentifier: "image-x" },
    });
    ready("box");
    expect(sandboxCapabilityStatus().defaultProvider).toBe("local");
    for (const provider of ["e2b", "lambda-microvm"] as const) {
      const status = sandboxCapabilityStatus().providers.find(
        (p) => p.id === provider,
      )!;
      expect(status.configured).toBe(true);
      expect(status.usability).toBe("unavailable");
      expect(sandboxProviderUsability(provider).state).toBe("unavailable");
      expect(status.certified).toBe(false);
      expect(status.note).toContain("not available for new sessions");
      const resolved = resolveRequestedSandbox(provider);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) expect(resolved.error).toContain("not live-certified");
    }
    const defaultResolved = resolveRequestedSandbox(true);
    expect(defaultResolved.ok).toBe(false);
    if (!defaultResolved.ok)
      expect(defaultResolved.error).toContain("not live-certified");
  });

  test("explicit unconfigured provider fails with a pointed error", () => {
    write({ provider: "docker" }); // no daytona/e2b keys
    const r = resolveRequestedSandbox("daytona");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("daytona");
    const e = resolveRequestedSandbox("e2b");
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error).toContain("e2b");
  });

  test("failed qualification stays configured but cannot be selected by either create path", () => {
    write({ provider: "docker" });
    connectSandboxProvider("docker", {});
    setSandboxConnectionQualification("docker", {
      status: "failed",
      failureCode: "DOCKER_DAEMON_UNAVAILABLE",
      failureSummary: "Start Docker.",
    });

    expect(sandboxProviderConfigured("docker")).toBe(true);
    expect(sandboxProviderUsability("docker")).toEqual({
      state: "unqualified",
      configured: true,
      usable: false,
    });
    const status = sandboxCapabilityStatus().providers.find(
      (provider) => provider.id === "docker",
    )!;
    expect(status.configured).toBe(true);
    expect(status.usability).toBe("unqualified");

    for (const requested of ["docker", true] as const) {
      const resolved = resolveRequestedSandbox(requested);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok)
        expect(resolved.error).toContain(
          "has not passed workspace qualification",
        );
    }
    expect(() => setWorkspaceSandboxDefault("docker")).toThrow(
      "not currently available",
    );
  });

  test("docker without any config file fails", () => {
    const r = resolveRequestedSandbox("docker");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not configured");
  });

  test("unknown provider string fails; 'local' means host", () => {
    write({ provider: "docker" });
    const r = resolveRequestedSandbox("fly");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Unknown sandbox provider");
    expect(resolveRequestedSandbox("local")).toEqual({
      ok: true,
      provider: null,
    });
  });

  test("model-family sandboxability is enforced at create, not just in the UI", () => {
    write({ provider: "docker" });
    ready("docker");
    ready("daytona");
    // Supported combos pass through.
    expect(
      resolveRequestedSandbox("daytona", undefined, "claude-fable-5-1"),
    ).toEqual({
      ok: true,
      provider: "daytona",
    });
    expect(
      resolveRequestedSandbox("daytona", undefined, "pi/openai/gpt-5.4-mini"),
    ).toEqual({ ok: true, provider: "daytona" });
    // Bare OpenAI ids normalize to Pi and pass the same sandbox gate.
    expect(resolveRequestedSandbox("docker", undefined, "gpt-5.5")).toEqual({
      ok: true,
      provider: "docker",
    });
    const viaDefault = resolveRequestedSandbox(true, undefined, "gpt-5.5");
    if (sandboxesEnabled()) expect(viaDefault.ok).toBe(true);
    // Host is always fine, whatever the model.
    expect(resolveRequestedSandbox("local", undefined, "gpt-5.5")).toEqual({
      ok: true,
      provider: null,
    });
  });

  test("pi models pass the create-gate on configured providers", () => {
    write({ provider: "docker" });
    ready("docker");
    ready("daytona");
    expect(
      resolveRequestedSandbox(
        "daytona",
        undefined,
        "pi/anthropic/claude-sonnet-5",
      ),
    ).toEqual({ ok: true, provider: "daytona" });
    expect(
      resolveRequestedSandbox(
        "docker",
        undefined,
        "pi/anthropic/claude-sonnet-5",
      ),
    ).toEqual({ ok: true, provider: "docker" });
    // The boolean default-provider path vets the model the same way.
    const viaDefault = resolveRequestedSandbox(
      true,
      undefined,
      "pi/openai/gpt-5.5",
    );
    expect(viaDefault.ok).toBe(true);
  });
});
