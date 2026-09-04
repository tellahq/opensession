/**
 * Unit tests for the sandbox provider-status surface (GET /api/sandbox/status
 * serves sandboxCapabilityStatus() verbatim — the route itself is a one-liner,
 * so this IS the endpoint's behavior) and for resolveRequestedSandbox, the
 * create-path validator behind the per-session Sandbox choice.
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
  anySandboxProvider,
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
let prevSecretsStore: string | undefined;
let prevInstanceConfig: string | undefined;
const cfgPath = () => join(scratch, "sandbox.json");
const instanceCfgPath = () => join(scratch, "config.json");

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "bks-sandbox-status-"));
  prevEnvConfig = process.env.OPENSESSION_SANDBOX_CONFIG;
  prevSecretsStore = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  prevInstanceConfig = process.env.OPENSESSION_CONFIG;
  process.env.OPENSESSION_SANDBOX_CONFIG = cfgPath();
  process.env.OPENSESSION_CONFIG = instanceCfgPath();
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
const ready = (provider: "daytona" | "box") => {
  connectSandboxProvider(provider, { secret: `test-${provider}-key` });
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
    write({ provider: "daytona", nested: { keep: true } });
    ready("daytona");
    expect(setWorkspaceSandboxDefault("daytona")).toBe("daytona");
    const stored = JSON.parse(readFileSync(cfgPath(), "utf-8"));
    expect(stored).toMatchObject({
      provider: "daytona",
      nested: { keep: true },
      sessionDefault: "daytona",
    });
    expect(sandboxConfig().sessionDefault).toBe("daytona");
  });

  test("no config file: disabled, everything unconfigured, default local", () => {
    const s = sandboxCapabilityStatus();
    expect(s.enabled).toBe(false);
    expect(s.defaultProvider).toBe("local");
    expect(s.providers.map((p) => p.id)).toEqual(["daytona", "box"]);
    expect(s.providers.every((p) => !p.configured)).toBe(true);
    expect(s.providers.filter((p) => p.certified).map((p) => p.id)).toEqual([
      "daytona",
      "box",
    ]);
    expect(s.killSwitch).toBe(!sandboxesEnabled());
  });

  test("a bare provider key is not a usable workspace connection", () => {
    write({ provider: "daytona" });
    const s = sandboxCapabilityStatus();
    expect(s.enabled).toBe(true);
    expect(s.defaultProvider).toBe("local");
    expect(s.providers.find((p) => p.id === "daytona")?.configured).toBe(false);
    expect(s.providers.find((p) => p.id === "daytona")?.usability).toBe(
      "not_configured",
    );
    expect(sandboxProviderUsability("daytona")).toEqual({
      state: "not_configured",
      configured: false,
      usable: false,
    });
    expect(s.providers.find((p) => p.id === "daytona")?.note).toBeUndefined();
  });

  test("a provider without a dial-back URL carries a pointed note", () => {
    write({ provider: "daytona" });
    ready("daytona");
    const s = sandboxCapabilityStatus();
    const d = s.providers.find((p) => p.id === "daytona")!;
    expect(d.configured).toBe(true);
    expect(d.note).toContain("no public ingress configured");
  });

  test("healthy provider (public ingress configured) carries no note", () => {
    write({ provider: "daytona" });
    writeIngress("https://example.ts.net");
    ready("daytona");
    const d = sandboxCapabilityStatus().providers.find(
      (p) => p.id === "daytona",
    )!;
    expect(d.configured).toBe(true);
    expect(d.note).toBeUndefined();
  });

  test("an explicit callbackBaseUrl also counts as dial-back configured", () => {
    write({ provider: "box", callbackBaseUrl: "wss://os.example.ts.net" });
    ready("box");
    const b = sandboxCapabilityStatus().providers.find((p) => p.id === "box")!;
    expect(b.configured).toBe(true);
    expect(b.certified).toBe(true);
    expect(b.note).toBeUndefined();
  });

  test("a disabled publicIngress block does not count as dial-back configured", () => {
    write({
      provider: "daytona",
      publicIngress: { enabled: false, publicBaseUrl: "wss://example.ts.net" },
    });
    ready("daytona");
    const d = sandboxCapabilityStatus().providers.find(
      (p) => p.id === "daytona",
    )!;
    expect(d.note).toContain("no public ingress configured");
  });

  test("retired provider ids in the file resolve to local", () => {
    write({ provider: "docker", sessionDefault: "modal" });
    expect(sandboxConfig().provider).toBe("local");
    expect(sandboxConfig().sessionDefault).toBeUndefined();
  });

  test("garbage config = no config", () => {
    writeFileSync(cfgPath(), "{nope");
    expect(sandboxCapabilityStatus().enabled).toBe(false);
    expect(sandboxProviderConfigured("daytona")).toBe(false);
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
    expect(sandboxModelFamilyFor("pi/openai/gpt-5.5").id).toBe("pi");
  });

  test("Claude, Pi, and every Pi provider are sandboxable", () => {
    for (const model of [
      "claude-fable-5-1",
      "pi/anthropic/claude-sonnet-5",
      "pi/openai/gpt-5.5",
      "pi/openai/gpt-5.6-sol",
      "pi/google/gemini-3",
      "pi/xai/grok-4.5",
    ]) {
      expect(sandboxableModelFamily(model)).toEqual({ ok: true });
    }
  });
});

describe("resolveRequestedSandbox (create-path validation)", () => {
  test("omitted interactive choice uses defaults; explicit Host still wins", () => {
    write({ provider: "daytona", sessionDefault: "daytona" });
    ready("daytona");
    expect(
      resolveInteractiveSandbox(
        undefined,
        "sandbox-default-test-user",
        undefined,
        "claude-fable-5-1",
      ),
    ).toEqual({ ok: true, provider: "daytona" });
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

  test("true = the workspace's Sandbox: its default, else the one ready provider", () => {
    write({});
    ready("box");
    expect(anySandboxProvider()).toBe(sandboxesEnabled() ? "box" : null);
    const r = resolveRequestedSandbox(true);
    if (sandboxesEnabled()) expect(r).toEqual({ ok: true, provider: "box" });
    else expect(r.ok).toBe(false);

    write({ sessionDefault: "daytona" });
    ready("daytona");
    ready("box");
    expect(anySandboxProvider()).toBe(sandboxesEnabled() ? "daytona" : null);
  });

  test("a connection whose qualification predates the current adapter is not usable", () => {
    write({});
    ready("daytona");
    ready("box");
    const cfg = JSON.parse(readFileSync(cfgPath(), "utf8"));
    for (const connection of cfg.connections)
      if (connection.provider === "daytona")
        connection.qualification.adapterSignature = "daytona:connection-v1:x";
    write(cfg);
    expect(sandboxProviderUsability("daytona").state).toBe(
      sandboxesEnabled() ? "unqualified" : "unavailable",
    );
    expect(anySandboxProvider()).toBe(sandboxesEnabled() ? "box" : null);
    const r = resolveRequestedSandbox("daytona");
    expect(r.ok).toBe(false);
    if (!r.ok && sandboxesEnabled())
      expect(r.error).toContain("needs attention in Workspace > Sandboxes");
  });

  test("true with no ready provider fails with a pointed error", () => {
    write({ provider: "daytona" });
    const r = resolveRequestedSandbox(true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("No Sandbox provider is ready");
  });

  test("explicit configured and certified provider is accepted", () => {
    write({ provider: "daytona" });
    ready("daytona");
    ready("box");
    expect(sandboxProviderUsability("daytona")).toEqual({
      state: "usable",
      configured: true,
      usable: true,
    });
    expect(resolveRequestedSandbox("daytona")).toEqual({
      ok: true,
      provider: "daytona",
    });
    expect(resolveRequestedSandbox("box")).toEqual({
      ok: true,
      provider: "box",
    });
    expect(resolveRequestedSandbox("BOX")).toEqual({
      ok: true,
      provider: "box",
    });
  });

  test("retired provider ids fail with a retirement error", () => {
    write({ provider: "daytona" });
    ready("daytona");
    for (const retired of ["docker", "modal", "e2b", "lambda-microvm"]) {
      const r = resolveRequestedSandbox(retired);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("retired");
    }
  });

  test("explicit unconfigured provider fails with a pointed error", () => {
    write({ provider: "daytona" }); // no connections
    const r = resolveRequestedSandbox("daytona");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Daytona");
    const b = resolveRequestedSandbox("box");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toContain("Box");
  });

  test("failed qualification stays configured but cannot be selected by either create path", () => {
    write({ provider: "daytona" });
    connectSandboxProvider("daytona", { secret: "test-daytona-key" });
    setSandboxConnectionQualification("daytona", {
      status: "failed",
      failureCode: "CREDENTIAL_REJECTED",
      failureSummary: "Replace the key.",
    });

    expect(sandboxProviderConfigured("daytona")).toBe(true);
    expect(sandboxProviderUsability("daytona")).toEqual({
      state: "unqualified",
      configured: true,
      usable: false,
    });
    const status = sandboxCapabilityStatus().providers.find(
      (provider) => provider.id === "daytona",
    )!;
    expect(status.configured).toBe(true);
    expect(status.usability).toBe("unqualified");

    const resolved = resolveRequestedSandbox("daytona");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok)
      expect(resolved.error).toContain(
        "needs attention in Workspace > Sandboxes",
      );
    const viaDefault = resolveRequestedSandbox(true);
    expect(viaDefault.ok).toBe(false);
    expect(() => setWorkspaceSandboxDefault("daytona")).toThrow(
      "not currently available",
    );
  });

  test("a provider without any config file fails", () => {
    const r = resolveRequestedSandbox("daytona");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not configured");
  });

  test("unknown provider string fails; 'local' means host", () => {
    write({ provider: "daytona" });
    const r = resolveRequestedSandbox("fly");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Unknown sandbox provider");
    expect(resolveRequestedSandbox("local")).toEqual({
      ok: true,
      provider: null,
    });
  });

  test("model-family sandboxability is enforced at create, not just in the UI", () => {
    write({ provider: "daytona" });
    ready("daytona");
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
    expect(resolveRequestedSandbox("daytona", undefined, "gpt-5.5")).toEqual({
      ok: true,
      provider: "daytona",
    });
    const viaDefault = resolveRequestedSandbox(true, undefined, "gpt-5.5");
    if (sandboxesEnabled()) expect(viaDefault.ok).toBe(true);
    // Host is always fine, whatever the model.
    expect(resolveRequestedSandbox("local", undefined, "gpt-5.5")).toEqual({
      ok: true,
      provider: null,
    });
  });
});
