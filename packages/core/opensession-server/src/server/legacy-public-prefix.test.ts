import { describe, expect, test } from "bun:test";
import { shouldRedirectLegacyPublicPath } from "./legacy-public-prefix";

describe("historical public prefixes", () => {
  test("serves the worker in place so an old registration can update", () => {
    expect(shouldRedirectLegacyPublicPath("GET", null, "/sw.js")).toBe(false);
    expect(shouldRedirectLegacyPublicPath("HEAD", null, "/sw.js")).toBe(false);
  });

  test("keeps ordinary page loads canonical", () => {
    expect(shouldRedirectLegacyPublicPath("GET", null, "/")).toBe(true);
    expect(shouldRedirectLegacyPublicPath("GET", null, "/session/os-1")).toBe(
      true,
    );
  });

  test("does not redirect APIs, mutations, or upgrades", () => {
    expect(shouldRedirectLegacyPublicPath("GET", null, "/api/sessions")).toBe(
      false,
    );
    expect(shouldRedirectLegacyPublicPath("POST", null, "/prompt")).toBe(false);
    expect(shouldRedirectLegacyPublicPath("GET", "websocket", "/ws")).toBe(
      false,
    );
  });
});
