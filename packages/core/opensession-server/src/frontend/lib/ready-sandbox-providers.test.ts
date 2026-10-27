import { describe, expect, test } from "bun:test";
import {
  readySandboxProviders,
  sandboxMachineChoices,
  sandboxProviderLabel,
  sandboxProviderNote,
  splitSandboxChoice,
} from "./ready-sandbox-providers";

describe("readySandboxProviders", () => {
  test("prefers Ready connections and ignores the rest", () => {
    expect(
      readySandboxProviders({
        connections: [
          { provider: "daytona", state: "ready" },
          { provider: "box", state: "needs_repair" },
        ],
        providers: [{ id: "box", configured: true, certified: true }],
      }),
    ).toEqual(["daytona"]);
  });

  test("falls back to configured, certified providers without connections", () => {
    expect(
      readySandboxProviders({
        connections: [],
        providers: [
          { id: "daytona", configured: true, certified: false },
          { id: "box", configured: true, certified: true },
        ],
      }),
    ).toEqual(["box"]);
  });

  test("no status means no providers", () => {
    expect(readySandboxProviders(null)).toEqual([]);
  });
});

describe("sandboxProviderLabel", () => {
  test("names the known providers and passes unknown ids through", () => {
    expect(sandboxProviderLabel("box")).toBe("Boat");
    expect(sandboxProviderLabel("daytona")).toBe("Daytona");
    expect(sandboxProviderLabel("orb")).toBe("orb");
  });
});

describe("sandboxProviderNote", () => {
  test("says whether the machine is this server, a Mac, or Linux", () => {
    expect(sandboxProviderNote("")).toBe("A worktree on this server.");
    expect(sandboxProviderNote("usecomputer")).toStartWith("Attached Mac");
    expect(sandboxProviderNote("box")).toStartWith("Attached Linux");
  });
});

describe("GPU machine choices", () => {
  test("Modal gets one entry per GPU after the plain one", () => {
    expect(sandboxMachineChoices(["box", "modal"])).toEqual([
      "box",
      "modal",
      "modal:T4",
      "modal:L4",
    ]);
  });

  test("an entry splits into the provider and GPU the create request names", () => {
    expect(splitSandboxChoice("modal:L4")).toEqual({
      provider: "modal",
      gpu: "L4",
    });
    expect(splitSandboxChoice("box")).toEqual({ provider: "box" });
    expect(splitSandboxChoice("")).toEqual({ provider: "" });
  });

  test("labels and notes name the GPU", () => {
    expect(sandboxProviderLabel("modal")).toBe("Modal");
    expect(sandboxProviderLabel("modal:T4")).toBe("Modal · T4 GPU");
    expect(sandboxProviderNote("modal:L4")).toContain("NVIDIA L4 GPU (24 GB)");
  });
});
