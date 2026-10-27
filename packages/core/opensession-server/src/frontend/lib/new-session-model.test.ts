import { describe, expect, test } from "bun:test";
import {
  preferredNewSessionEffort,
  preferredNewSessionModel,
} from "./new-session-model";

const models = [
  { id: "pi/anthropic/claude-fable-5-1", efforts: ["low", "high", "max"] },
  { id: "pi/openai/gpt-6.1-sol", efforts: ["none", "high", "xhigh"] },
];
const base = {
  models,
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
        modelPref: "pi/openai/gpt-6.1-sol",
      }),
    ).toBe("pi/openai/gpt-6.1-sol");
  });
  test("reads a retired preset preference as the model it ran on", () => {
    expect(
      preferredNewSessionModel({ ...base, modelPref: "pi/dial/high" }),
    ).toBe("pi/openai/gpt-6.1-sol");
  });
  test("ignores a model the catalog does not offer", () => {
    expect(
      preferredNewSessionModel({ ...base, modelPref: "pi/acme/unknown" }),
    ).toBe("");
  });
});

describe("preferredNewSessionEffort", () => {
  test("applies a preference the starting model offers", () => {
    expect(
      preferredNewSessionEffort({
        models,
        model: "pi/openai/gpt-6.1-sol",
        effortPref: "xhigh",
      }),
    ).toBe("xhigh");
  });
  test("skips a preference the starting model does not offer", () => {
    expect(
      preferredNewSessionEffort({
        models,
        model: "pi/anthropic/claude-fable-5-1",
        effortPref: "xhigh",
      }),
    ).toBeUndefined();
  });
  test("has nothing to apply without a preference", () => {
    expect(
      preferredNewSessionEffort({
        models,
        model: "pi/openai/gpt-6.1-sol",
        effortPref: "",
      }),
    ).toBeUndefined();
  });
});
