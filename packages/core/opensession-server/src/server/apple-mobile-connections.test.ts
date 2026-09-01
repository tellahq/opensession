import { describe, expect, test } from "bun:test";
import {
  appleReleaseApprover,
  buildAppleMobileUpdates,
} from "./apple-mobile-connections";

const releaseInput = {
  buildEnabled: true,
  releaseEnabled: true,
  teamId: "TEAM123456",
  keyId: "KEY1234567",
  issuerId: "00000000-0000-0000-0000-000000000000",
  privateKeyPath: "/protected/apple/AuthKey_KEY1234567.p8",
  allowedUsers: ["Jaap", "Jaap", " Alice "],
};

describe("Apple mobile connection setup", () => {
  test("keeps build credentials separate from user-restricted release tools", () => {
    const checked: string[] = [];
    const updates = buildAppleMobileUpdates(
      releaseInput,
      {},
      {
        releaseCapable: true,
        validatePrivateKey: (path) => checked.push(path),
      },
    );

    expect(updates["apple-build"]).toEqual({
      command: "opensession",
      args: ["apple-mobile-mcp", "--mode", "build"],
      env: {},
    });
    expect(updates["apple-release"]?.allowedUsers).toEqual(["Jaap", "Alice"]);
    expect(updates["apple-release"]?.env).toMatchObject({
      APPLE_ASC_KEY_ID: "KEY1234567",
      APPLE_ASC_PRIVATE_KEY_PATH: "/protected/apple/AuthKey_KEY1234567.p8",
    });
    expect(checked).toEqual(["/protected/apple/AuthKey_KEY1234567.p8"]);
  });

  test("refuses release without an allowed user", () => {
    expect(() =>
      buildAppleMobileUpdates(
        { ...releaseInput, allowedUsers: [] },
        {},
        { releaseCapable: true, validatePrivateKey: () => {} },
      ),
    ).toThrow("Choose at least one person allowed to release");
  });

  test("refuses release on a host without Xcode", () => {
    expect(() =>
      buildAppleMobileUpdates(
        releaseInput,
        {},
        {
          releaseCapable: false,
          validatePrivateKey: () => {},
        },
      ),
    ).toThrow("Release tools require Xcode on this Mac");
  });

  test("approves only an authenticated identity on the release allowlist", () => {
    expect(appleReleaseApprover({ login: "alice" }, ["Alice", "Bob"])).toBe(
      "alice",
    );
    expect(
      appleReleaseApprover({ login: "mallory" }, ["Alice"]),
    ).toBeUndefined();
    expect(appleReleaseApprover(null, ["Alice"])).toBeUndefined();
  });

  test("can install credential-free build tools by themselves", () => {
    const updates = buildAppleMobileUpdates({
      buildEnabled: true,
      releaseEnabled: false,
    });
    expect(updates["apple-build"]).toBeDefined();
    expect(updates["apple-release"]).toBeUndefined();
  });
});
