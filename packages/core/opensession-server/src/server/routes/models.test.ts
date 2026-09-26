import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { handleModelsRoutes } from "./models";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "../session-kernel";
import { catalogDocuments } from "../catalog-documents";
import { __resetWorkspaceProjectionForTest } from "../workspaces";
import * as catalog from "../model-catalog";
import * as providers from "../model-providers";
import * as models from "../models";
import * as pi from "../pi-config";

let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
let configured = new Set(["anthropic", "openai"]);
let orchestrator = true;
let preferred = "pi/orchestrator/fable";
const restores: Array<() => void> = [];
beforeEach(async () => {
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  __resetWorkspaceProjectionForTest();
  configured = new Set(["anthropic", "openai"]);
  orchestrator = true;
  preferred = "pi/orchestrator/fable";
  const mocks = [
    spyOn(pi, "piEngineEnabled").mockReturnValue(true),
    spyOn(catalog, "configuredModelProviders").mockImplementation(
      () => configured,
    ),
    spyOn(providers, "orchestratorEnabled").mockImplementation(
      () => orchestrator,
    ),
    spyOn(models, "interactiveDefaultModel").mockImplementation(
      () => preferred,
    ),
  ];
  restores.push(...mocks.map((mock) => () => mock.mockRestore()));
  await catalogDocuments("workspaces").set("ws-acme", {
    id: "ws-acme",
    name: "Acme",
  });
});
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  __setSessionKernelStoreForTest(previousStore);
  store.close();
  __resetWorkspaceProjectionForTest();
});

async function modelCatalog(workspace = "ws-acme") {
  const url = new URL(
    `http://example.test/api/models${workspace ? `?workspace=${workspace}` : ""}`,
  );
  const response = await handleModelsRoutes({
    req: new Request(url),
    url,
    path: url.pathname,
    publicPrefix: "",
  });
  return (await response!.json()) as {
    models: Array<{ id: string; label: string }>;
    default: string;
  };
}

test("workspace catalogs retain built-ins alongside editable presets and do not rewrite defaults", async () => {
  for (const builtin of [
    "pi/dial/ultra",
    "pi/dial/opus-fable",
    "pi/orchestrator/fable",
  ]) {
    preferred = builtin;
    const result = await modelCatalog();
    const ids = result.models.map((model) => model.id);
    expect(ids).toContain(builtin);
    expect(ids).toContain("pi/workspace-preset/ws-acme/dial-ultra");
    expect(ids).toContain("pi/workspace-preset/ws-acme/orchestrator-fable");
    expect(
      result.models.find((model) => model.id === builtin)?.label,
    ).toContain("(built-in)");
    expect(result.default).toBe(builtin);
    expect(new Set(ids).size).toBe(ids.length);
  }
});

test("empty workspace presets do not remove built-ins and unscoped catalogs stay global", async () => {
  await catalogDocuments("workspaces").set("ws-acme", {
    id: "ws-acme",
    name: "Acme",
    modelSettings: { presets: [] },
  });
  for (const workspace of ["ws-acme", ""]) {
    const result = await modelCatalog(workspace);
    expect(result.models.map((model) => model.id)).toContain(
      "pi/orchestrator/fable",
    );
    expect(
      result.models.some((model) => model.id.includes("workspace-preset")),
    ).toBe(false);
  }
});

test("the union still respects provider availability and the built-in orchestrator opt-in", async () => {
  orchestrator = false;
  let result = await modelCatalog();
  expect(
    result.models.some((model) => model.id.startsWith("pi/orchestrator/")),
  ).toBe(false);
  expect(result.models.map((model) => model.id)).toContain(
    "pi/workspace-preset/ws-acme/orchestrator-fable",
  );
  configured = new Set(["openai"]);
  result = await modelCatalog();
  expect(result.models.some((model) => model.id.startsWith("pi/dial/"))).toBe(
    false,
  );
  expect(result.models.map((model) => model.id)).not.toContain(
    "pi/workspace-preset/ws-acme/orchestrator-fable",
  );
});
