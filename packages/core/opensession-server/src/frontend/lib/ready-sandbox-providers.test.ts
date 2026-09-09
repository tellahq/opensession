import { describe, expect, test } from "bun:test";
import {
  readySandboxProviders,
  sandboxProviderLabel,
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
    expect(sandboxProviderLabel("box")).toBe("Box");
    expect(sandboxProviderLabel("daytona")).toBe("Daytona");
    expect(sandboxProviderLabel("orb")).toBe("orb");
  });
});
