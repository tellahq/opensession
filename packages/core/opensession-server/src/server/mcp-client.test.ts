import { describe, expect, test } from "bun:test";
import { selectMcpAuthorization } from "./mcp-client";

describe("server-side MCP authorization", () => {
  test("requires the named user's personal grant without fallback", () => {
    expect(
      selectMcpAuthorization({
        personal: "Bearer personal",
        standard: "Bearer shared",
        staticAuthorization: "Bearer static",
        requireUserGrant: true,
      }),
    ).toBe("Bearer personal");

    expect(() =>
      selectMcpAuthorization({
        standard: "Bearer shared",
        staticAuthorization: "Bearer static",
        requireUserGrant: true,
      }),
    ).toThrow("personal OAuth grant is required");
  });

  test("keeps normal server-side calls on the standard fallback chain", () => {
    expect(
      selectMcpAuthorization({
        standard: "Bearer shared",
        staticAuthorization: "Bearer static",
        requireUserGrant: false,
      }),
    ).toBe("Bearer shared");
  });
});
