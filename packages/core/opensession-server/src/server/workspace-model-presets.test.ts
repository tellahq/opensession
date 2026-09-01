import { describe, expect, test } from "bun:test";
import {
  portableWorkspacePresetRun,
  type ResolvedWorkspaceModelPreset,
} from "./workspace-model-presets";

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
