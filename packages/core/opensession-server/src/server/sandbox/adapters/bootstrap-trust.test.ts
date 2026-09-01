import { describe, expect, test } from "bun:test";
import { resolveTrustPolicy } from "./bootstrap";

describe("sandbox trust policy resolution", () => {
  test("an ensure() that states no policy inherits the recorded one", () => {
    expect(
      resolveTrustPolicy(
        {},
        {
          trustProfile: "automation",
          egressAllowlist: ["https://api.plain.com"],
        },
      ),
    ).toEqual({
      trustProfile: "automation",
      egressAllowlist: ["https://api.plain.com"],
    });
  });

  test("an unrecorded sandbox with no stated policy is interactive", () => {
    expect(resolveTrustPolicy({}, null)).toEqual({
      trustProfile: "interactive",
      egressAllowlist: [],
    });
  });

  test("a recorded automation sandbox cannot be reopened as interactive", () => {
    expect(() =>
      resolveTrustPolicy(
        { trustProfile: "interactive" },
        { trustProfile: "automation", egressAllowlist: [] },
      ),
    ).toThrow("cannot");
  });

  test("only a caller that states the profile restates the allowlist", () => {
    // The automation's own ensure() is authoritative over its allowlist.
    expect(
      resolveTrustPolicy(
        {
          trustProfile: "automation",
          egressAllowlist: ["https://api.linear.app"],
        },
        {
          trustProfile: "automation",
          egressAllowlist: ["https://api.plain.com"],
        },
      ).egressAllowlist,
    ).toEqual(["https://api.linear.app"]);
    // A bare allowlist without a profile does not widen the recorded firewall.
    expect(
      resolveTrustPolicy(
        { egressAllowlist: ["https://evil.example"] },
        {
          trustProfile: "automation",
          egressAllowlist: ["https://api.plain.com"],
        },
      ).egressAllowlist,
    ).toEqual(["https://api.plain.com"]);
  });
});
