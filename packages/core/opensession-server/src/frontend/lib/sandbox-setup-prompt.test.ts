import { describe, expect, test } from "bun:test";
import {
  buildSandboxCachingPrompt,
  projectSandboxOverrides,
} from "./sandbox-setup-prompt";

describe("projectSandboxOverrides", () => {
  test("returns only repos explicitly overriding the workspace default, sorted by label", () => {
    const overrides = projectSandboxOverrides(
      {
        workspace: "box",
        personal: "workspace",
        effective: "box",
        repos: {
          "acme-web": "workspace",
          "acme-ios": "tart",
          "acme-api": "none",
          "acme-gpu": "modal:T4",
        },
      },
      [
        { id: "acme-web", label: "Web" },
        { id: "acme-ios", label: "iOS App" },
        { id: "acme-api", label: "API" },
      ],
    );
    expect(overrides).toEqual([
      { repoId: "acme-gpu", label: "acme-gpu", provider: "modal:T4" },
      { repoId: "acme-api", label: "API", provider: "none" },
      { repoId: "acme-ios", label: "iOS App", provider: "tart" },
    ]);
  });

  test("returns empty list when no repo overrides exist", () => {
    expect(projectSandboxOverrides(undefined, [])).toEqual([]);
  });
});

describe("buildSandboxCachingPrompt", () => {
  test("mentions repo label and .agents/setup idempotent caching steps", () => {
    const prompt = buildSandboxCachingPrompt("Acme Web");
    expect(prompt).toContain("Acme Web");
    expect(prompt).toContain(".agents/setup");
    expect(prompt).toContain(".agents/resume");
    expect(prompt).toContain("bash -n");
  });
});
