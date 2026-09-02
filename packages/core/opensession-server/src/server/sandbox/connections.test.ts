import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  connectSandboxProvider,
  disconnectSandboxProvider,
  getSandboxConnection,
  safeSandboxConnections,
  sandboxConnectionReady,
  sandboxProviderCredential,
  setSandboxConnectionQualification,
} from "./connections";

let scratch = "";
let oldConfig: string | undefined;
let oldSecrets: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "opensession-sandbox-connections-"));
  oldConfig = process.env.OPENSESSION_SANDBOX_CONFIG;
  oldSecrets = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  process.env.OPENSESSION_SANDBOX_CONFIG = join(scratch, "sandbox.json");
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(
    scratch,
    "secrets.json",
  );
});

afterEach(() => {
  if (oldConfig === undefined) delete process.env.OPENSESSION_SANDBOX_CONFIG;
  else process.env.OPENSESSION_SANDBOX_CONFIG = oldConfig;
  if (oldSecrets === undefined)
    delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  else process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = oldSecrets;
  rmSync(scratch, { recursive: true, force: true });
});

describe("workspace sandbox connections", () => {
  test("stores Daytona credentials behind an opaque reference and never returns it", () => {
    connectSandboxProvider("daytona", {
      secret: "daytona-secret-value",
      settings: {
        apiUrl: "https://daytona.example.test",
        snapshot: "team-large",
      },
    });

    const configText = readFileSync(
      process.env.OPENSESSION_SANDBOX_CONFIG!,
      "utf-8",
    );
    expect(configText).not.toContain("daytona-secret-value");
    expect(configText).toContain("wssec-");
    expect(sandboxProviderCredential("daytona")).toEqual({
      apiKey: "daytona-secret-value",
    });

    const safe = safeSandboxConnections().find(
      (value) => value.provider === "daytona",
    )!;
    expect(safe.hasCredentials).toBe(true);
    expect(safe.state).toBe("checking");
    expect(safe).not.toHaveProperty("credentialRef");
    expect(JSON.stringify(safe)).not.toContain("daytona-secret-value");
  });

  test("stores Box credentials behind an opaque reference and exposes only readiness", () => {
    connectSandboxProvider("box", {
      secret: "box-secret-value",
      settings: { apiUrl: "https://box.example.test/v1" },
    });
    const configText = readFileSync(
      process.env.OPENSESSION_SANDBOX_CONFIG!,
      "utf-8",
    );
    expect(configText).not.toContain("box-secret-value");
    expect(sandboxProviderCredential("box")).toEqual({
      apiKey: "box-secret-value",
    });
    expect(
      safeSandboxConnections().find((value) => value.provider === "box"),
    ).toMatchObject({
      hasCredentials: true,
      state: "checking",
      settings: { apiUrl: "https://box.example.test/v1" },
    });
  });

  test("rotates Modal credentials in place and disconnect deletes the secret", () => {
    const first = connectSandboxProvider("modal", {
      tokenId: "modal-id-one",
      tokenSecret: "modal-secret-one",
    });
    const ref = first.credentialRef;
    const second = connectSandboxProvider("modal", {
      tokenId: "modal-id-two",
      tokenSecret: "modal-secret-two",
    });
    expect(second.id).toBe(first.id);
    expect(second.credentialRef).toBe(ref);
    expect(sandboxProviderCredential("modal")).toEqual({
      tokenId: "modal-id-two",
      tokenSecret: "modal-secret-two",
    });

    expect(disconnectSandboxProvider("modal")).toBe(true);
    expect(getSandboxConnection("modal")).toBeUndefined();
    expect(sandboxProviderCredential("modal")).toBeUndefined();
  });

  test("only enabled, successfully qualified connections become Ready", () => {
    connectSandboxProvider("docker", { settings: { cpu: 4, memoryMb: 8192 } });
    expect(sandboxConnectionReady("docker")).toBe(false);
    setSandboxConnectionQualification("docker", {
      status: "ready",
      checkedAt: "2026-08-11T00:00:00.000Z",
    });
    expect(sandboxConnectionReady("docker")).toBe(true);
    expect(
      safeSandboxConnections().find((value) => value.provider === "docker")
        ?.state,
    ).toBe("ready");
  });

  test("a runner pin change does not invalidate provider qualification", () => {
    connectSandboxProvider("daytona", { secret: "daytona-secret" });
    setSandboxConnectionQualification("daytona", {
      status: "ready",
      checkedAt: "2026-08-11T00:00:00.000Z",
    });
    const path = process.env.OPENSESSION_SANDBOX_CONFIG!;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.connections[0].qualification.adapterSignature =
      "daytona:connection-v2:old-runner-pin+node@24.18.1+workspace-runtime-v7";
    writeFileSync(path, JSON.stringify(raw));

    expect(sandboxConnectionReady("daytona")).toBe(true);
    expect(
      safeSandboxConnections().find((value) => value.provider === "daytona")
        ?.state,
    ).toBe("ready");
  });

  test("an adapter signature change makes a previous qualification stale", () => {
    connectSandboxProvider("docker", {});
    setSandboxConnectionQualification("docker", {
      status: "ready",
      checkedAt: "2026-08-11T00:00:00.000Z",
    });
    const path = process.env.OPENSESSION_SANDBOX_CONFIG!;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.connections[0].qualification.adapterSignature = "docker:old-adapter";
    writeFileSync(path, JSON.stringify(raw));

    expect(sandboxConnectionReady("docker")).toBe(false);
    expect(
      safeSandboxConnections().find((value) => value.provider === "docker")
        ?.state,
    ).toBe("needs_attention");
  });
});
