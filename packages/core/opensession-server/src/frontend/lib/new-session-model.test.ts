import { describe, expect, test } from "bun:test";
import { preferredNewSessionModel } from "./new-session-model";

const base = {
  models: [
    { id: "pi/anthropic/claude-fable-5-1" },
    { id: "pi/workspace-preset/ws-1/opus-fable" },
  ],
  default: "pi/anthropic/claude-fable-5-1",
  modelPref: "",
};

describe("preferredNewSessionModel", () => {
  test("leaves the choice to the server without a preference", () => {
    expect(preferredNewSessionModel(base)).toBe("");
  });
  test("preselects a valid personal model", () => {
    expect(
      preferredNewSessionModel({
        ...base,
        modelPref: "pi/anthropic/claude-fable-5-1",
      }),
    ).toBe("pi/anthropic/claude-fable-5-1");
  });
  test("retains a workspace preset default", () => {
    expect(
      preferredNewSessionModel({
        ...base,
        default: "pi/workspace-preset/ws-1/opus-fable",
      }),
    ).toBe("pi/workspace-preset/ws-1/opus-fable");
  });
});
