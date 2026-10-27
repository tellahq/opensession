import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { handleModelsRoutes } from "./models";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "../session-kernel";
import { catalogDocuments } from "../catalog-documents";
import { __resetWorkspaceProjectionForTest } from "../workspaces";
import * as catalog from "../model-catalog";
import * as models from "../models";
import * as pi from "../pi-config";

let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
let configured = new Set(["anthropic", "openai"]);
let preferred = "pi/anthropic/claude-opus-5-5";
const restores: Array<() => void> = [];
beforeEach(async () => {
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  __resetWorkspaceProjectionForTest();
  configured = new Set(["anthropic", "openai"]);
  preferred = "pi/anthropic/claude-opus-5-5";
  const mocks = [
    spyOn(pi, "piEngineEnabled").mockReturnValue(true),
    spyOn(catalog, "configuredModelProviders").mockImplementation(
      () => configured,
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

async function modelCatalog() {
  const url = new URL("http://example.test/api/models");
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

test("the catalog lists plain models only and keeps the default", async () => {
  preferred = "pi/anthropic/claude-opus-5-5";
  const result = await modelCatalog();
  const ids = result.models.map((model) => model.id);
  expect(ids).toContain("pi/anthropic/claude-opus-5-5");
  expect(ids.every((id) => /^pi\/[^/]+\/.+/.test(id))).toBe(true);
  expect(
    ids.some((id) => /^pi\/(?:dial|orchestrator|workspace-preset)\//.test(id)),
  ).toBe(false);
  expect(result.default).toBe("pi/anthropic/claude-opus-5-5");
  expect(new Set(ids).size).toBe(ids.length);
});

test("a retired preset default resolves to the model it led", async () => {
  preferred = "pi/dial/ultra";
  const result = await modelCatalog();
  expect(result.default).toBe("pi/anthropic/claude-fable-5-1");
});

test("the catalog respects provider availability", async () => {
  configured = new Set(["openai"]);
  const result = await modelCatalog();
  expect(
    result.models.every((model) => model.id.startsWith("pi/openai/")),
  ).toBe(true);
});
