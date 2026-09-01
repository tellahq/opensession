import { describe, expect, test } from "bun:test";
import { effectiveSandboxDefault } from "./defaults";

describe("sandbox default precedence", () => {
  test("workspace and personal omissions resolve to None", () => {
    expect(effectiveSandboxDefault("none", "workspace")).toBe("none");
  });

  test("workspace applies until a person overrides it", () => {
    expect(effectiveSandboxDefault("docker", "workspace")).toBe("docker");
    expect(effectiveSandboxDefault("docker", "none")).toBe("none");
    expect(effectiveSandboxDefault("docker", "modal")).toBe("modal");
  });
});
