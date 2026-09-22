import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  portableWorkspacePresetRun,
  resolveWorkspaceModelPreset,
  type ResolvedWorkspaceModelPreset,
} from "./workspace-model-presets";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import { catalogDocuments } from "./catalog-documents";
import {
  DEFAULT_WORKSPACE_MODEL_SETTINGS,
  __resetWorkspaceProjectionForTest,
  peekWorkspace,
} from "./workspaces";
import { resolvePiRoutedModel, runPi } from "./pi-runner";
import * as piConfig from "./pi-config";

function preset(
  overrides: Partial<ResolvedWorkspaceModelPreset> = {},
): ResolvedWorkspaceModelPreset {
  return {
    id: "pi/workspace-preset/ws-test/lead",
    label: "Lead preset",
    model: "pi/anthropic/claude-opus-5",
    note: "Lead this task.",
    ...overrides,
  };
}

describe("portableWorkspacePresetRun", () => {
  test("carries matching built-in preset wiring across a detached boundary", () => {
    expect(
      portableWorkspacePresetRun(
        preset({ enginePresetId: "dial/opus-fable", effort: "xhigh" }),
      ),
    ).toEqual({
      model: "pi/dial/opus-fable",
      selectedModel: "pi/workspace-preset/ws-test/lead",
      effort: "xhigh",
    });
  });

  test("uses the concrete lead when the preset has no built-in wiring", () => {
    expect(portableWorkspacePresetRun(preset())).toEqual({
      model: "pi/anthropic/claude-opus-5",
      selectedModel: "pi/workspace-preset/ws-test/lead",
    });
  });
});

describe("workspace preset catalog resolution", () => {
  let store: SessionKernelStore;
  let previousStore: SessionKernelStore | undefined;
  beforeEach(() => {
    store = new SessionKernelStore(":memory:");
    previousStore = __setSessionKernelStoreForTest(store);
    __resetWorkspaceProjectionForTest();
  });
  afterEach(() => {
    __setSessionKernelStoreForTest(previousStore);
    store.close();
    __resetWorkspaceProjectionForTest();
  });

  test("resolves saved and inherited presets without warming the projection", async () => {
    for (const modelSettings of [undefined, DEFAULT_WORKSPACE_MODEL_SETTINGS]) {
      await catalogDocuments("workspaces").set("ws-acme", {
        id: "ws-acme",
        name: "Acme",
        createdAt: "2026-01-01T00:00:00Z",
        modelSettings,
      });
      for (const preset of DEFAULT_WORKSPACE_MODEL_SETTINGS.presets!) {
        __resetWorkspaceProjectionForTest();
        expect(peekWorkspace("ws-acme")).toBeNull();
        const selected = `pi/workspace-preset/ws-acme/${preset.id}`;
        const resolved = await resolveWorkspaceModelPreset(selected);
        expect(resolved).toMatchObject({
          id: selected,
          model: preset.lead.model,
          effort: preset.lead.effort,
        });
      }
    }
  });

  test("reads custom edits from the catalog even after a projection is warm", async () => {
    const id = "pi/workspace-preset/ws-acme/custom";
    const workspace = {
      id: "ws-acme",
      name: "Acme",
      modelSettings: {
        presets: [
          {
            id: "custom",
            label: "Acme lead",
            lead: { model: "pi/openai/gpt-6-sol", effort: "high" },
          },
        ],
      },
    };
    await catalogDocuments("workspaces").set(workspace.id, workspace);
    expect(await resolveWorkspaceModelPreset(id)).toMatchObject({
      model: "pi/openai/gpt-6-sol",
    });
    workspace.modelSettings.presets[0].lead.model =
      "pi/anthropic/claude-fable-5-1";
    await catalogDocuments("workspaces").set(workspace.id, workspace);
    expect(await resolveWorkspaceModelPreset(id)).toMatchObject({
      model: "pi/anthropic/claude-fable-5-1",
    });
    expect(await resolveWorkspaceModelPreset(id, "ws-other")).toBeUndefined();
    expect(
      await resolveWorkspaceModelPreset("pi/workspace-preset/ws-acme/missing"),
    ).toBeUndefined();
    expect(
      await resolveWorkspaceModelPreset(
        "pi/workspace-preset/ws-missing/custom",
      ),
    ).toBeUndefined();
  });

  test("Pi dispatch resolves a cold workspace and retains stored preset wiring", async () => {
    await catalogDocuments("workspaces").set("ws-acme", {
      id: "ws-acme",
      name: "Acme",
    });
    const id = "pi/workspace-preset/ws-acme/opus-fable";
    for (const model of [id, "pi/anthropic/claude-opus-5-5"]) {
      __resetWorkspaceProjectionForTest();
      expect(peekWorkspace("ws-acme")).toBeNull();
      expect(await resolvePiRoutedModel(model, id)).toMatchObject({
        providerID: "anthropic",
        modelID: "claude-opus-5-5",
        effort: "xhigh",
        workspacePreset: { id },
        dial: { id: "dial/opus-fable" },
      });
    }
  });

  test("catalog failures propagate instead of falling back to a cached projection", async () => {
    await catalogDocuments("workspaces").set("ws-acme", {
      id: "ws-acme",
      name: "Acme",
    });
    const id = "pi/workspace-preset/ws-acme/dial-high";
    expect(await resolveWorkspaceModelPreset(id)).toBeDefined();
    const read = spyOn(store, "catalogDocumentGet").mockImplementation(() => {
      throw new Error("catalog unavailable");
    });
    try {
      await expect(resolveWorkspaceModelPreset(id)).rejects.toThrow(
        "catalog unavailable",
      );
    } finally {
      read.mockRestore();
    }
  });

  test("a missing workspace emits a resolution error before any provider work", async () => {
    const enabled = spyOn(piConfig, "piEngineEnabled").mockReturnValue(true);
    const model = "pi/workspace-preset/ws-missing/custom";
    try {
      const events = [];
      for await (const event of runPi(
        {
          prompt: "Acme question",
          cwd: ".",
          model,
          mcpServers: [],
          journal: { kind: "prompt" },
        },
        model,
      ))
        events.push(event);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", model });
      expect(events[0].content).toContain(
        "Cannot resolve workspace model preset",
      );
      expect(events[0].content).not.toContain("Not a pi model id");
    } finally {
      enabled.mockRestore();
    }
  });
});
