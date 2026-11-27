import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeVertexCredential,
  vertexCredentialLabel,
  vertexFallbackModel,
  vertexPiCredential,
  vertexProject,
} from "./vertex-provider";

const serviceAccount = {
  type: "service_account",
  project_id: "acme-project",
  private_key_id: "abc123",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nMIIEv gIBADANBg\n-----END PRIVATE KEY-----\n",
  client_email: "agent@acme-project.iam.gserviceaccount.com",
};
const pasted = JSON.stringify(serviceAccount, null, 2);

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

describe("normalizeVertexCredential", () => {
  test("keeps a service account's private key intact and stores it compact", () => {
    const stored = normalizeVertexCredential(`\n${pasted}\n`);
    expect(stored).toBe(JSON.stringify(serviceAccount));
    expect(JSON.parse(stored).private_key).toBe(serviceAccount.private_key);
  });

  test("strips line wraps from an API key", () => {
    expect(normalizeVertexCredential(" AQ.abc\ndef ")).toBe("AQ.abcdef");
  });

  test("rejects JSON that is not a service account key", () => {
    expect(() => normalizeVertexCredential("{not json")).toThrow(
      "not valid JSON",
    );
    expect(() =>
      normalizeVertexCredential(JSON.stringify({ type: "authorized_user" })),
    ).toThrow("service account key file");
  });
});

describe("vertex credential display", () => {
  test("shows the service account email, never the key", () => {
    expect(vertexCredentialLabel(pasted)).toBe(
      "Service account agent@acme-project.iam.gserviceaccount.com",
    );
    expect(vertexCredentialLabel("AQ.abcdef")).toBeUndefined();
  });

  test("bills the configured project, else the key's own", () => {
    expect(vertexProject({ apiKey: pasted })).toBe("acme-project");
    expect(vertexProject({ apiKey: pasted, project: "other" })).toBe("other");
    expect(vertexProject({ apiKey: "AQ.abcdef" })).toBeUndefined();
  });
});

describe("vertexPiCredential", () => {
  test("writes the key file 0600 and returns Pi's ADC credential", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vertex-"));
    dirs.push(dir);
    const keyDir = join(dir, "google-vertex");
    const credential = await vertexPiCredential(
      { apiKey: JSON.stringify(serviceAccount), location: "us-central1" },
      keyDir,
    );
    expect(credential?.env.GOOGLE_CLOUD_PROJECT).toBe("acme-project");
    expect(credential?.env.GOOGLE_CLOUD_LOCATION).toBe("us-central1");
    const path = credential!.env.GOOGLE_APPLICATION_CREDENTIALS;
    expect(path.startsWith(keyDir)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf-8"))).toEqual(serviceAccount);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const again = await vertexPiCredential(
      { apiKey: JSON.stringify(serviceAccount) },
      keyDir,
    );
    expect(again?.env.GOOGLE_APPLICATION_CREDENTIALS).toBe(path);
    expect(again?.env.GOOGLE_CLOUD_LOCATION).toBe("global");
  });

  test("leaves an API key to Pi and needs a project for a service account", async () => {
    expect(await vertexPiCredential({ apiKey: "AQ.abcdef" }, "/unused")).toBe(
      undefined,
    );
    const { project_id: _project, ...noProject } = serviceAccount;
    await expect(
      vertexPiCredential({ apiKey: JSON.stringify(noProject) }, "/unused"),
    ).rejects.toThrow("needs a Google Cloud project");
  });
});

test("unknown Gemini ids run with Gemini limits and the model's own thinking", () => {
  expect(vertexFallbackModel("gemini-4-example")).toMatchObject({
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  });
});

describe("google-vertex provider config", () => {
  test("stores, reads and clears project and location, masking the key", async () => {
    const { mkdtempSync, readFileSync } = await import("fs");
    const {
      maskProviderKey,
      modelProviders,
      loadModelProviders,
      setModelProvider,
    } = await import("./model-providers");
    const dir = mkdtempSync(join(tmpdir(), "os-model-providers-"));
    dirs.push(dir);
    const path = join(dir, "model-providers.json");
    const prev = process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = path;
    try {
      const stored = normalizeVertexCredential(pasted);
      await setModelProvider("google-vertex", {
        apiKey: stored,
        project: "billing-project",
        location: "us-central1",
      });
      await loadModelProviders();
      expect(modelProviders()["google-vertex"]).toMatchObject({
        apiKey: stored,
        project: "billing-project",
        location: "us-central1",
      });
      expect(maskProviderKey(stored)).toBe(
        "Service account agent@acme-project.iam.gserviceaccount.com",
      );
      await setModelProvider("google-vertex", { project: "", location: "" });
      expect(
        JSON.parse(readFileSync(path, "utf-8")).providers["google-vertex"],
      ).toEqual({ apiKey: stored });
    } finally {
      if (prev === undefined)
        delete process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
      else process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = prev;
    }
  });

  test("a model newer than Pi's Vertex catalog gets the Gemini row", async () => {
    const { buildPiThirdPartyProviderPlan } = await import("./pi-runner");
    const plan = buildPiThirdPartyProviderPlan({
      providerID: "google-vertex",
      modelID: "gemini-4-example",
      apiKey: "k",
      builtinModelIds: ["gemini-3.8-flash"],
    });
    expect("config" in plan && plan.config.models).toEqual([
      vertexFallbackModel("gemini-4-example"),
    ]);
    const known = buildPiThirdPartyProviderPlan({
      providerID: "google-vertex",
      modelID: "gemini-3.8-flash",
      apiKey: "k",
      builtinModelIds: ["gemini-3.8-flash"],
    });
    expect("config" in known && known.config.models).toBeUndefined();
  });
});
