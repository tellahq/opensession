import { describe, expect, test } from "bun:test";
import { requiresAllowedUsers } from "./connections";

describe("first-party MCP connection policy", () => {
  test("requires the credentialed Apple release server to be user-scoped", () => {
    expect(requiresAllowedUsers("apple-release")).toBe(true);
    expect(requiresAllowedUsers("APPLE-RELEASE")).toBe(true);
  });

  test("keeps credential-free build tools available for ordinary setup", () => {
    expect(requiresAllowedUsers("apple-build")).toBe(false);
  });
});
