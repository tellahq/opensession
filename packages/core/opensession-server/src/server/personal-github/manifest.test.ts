import { describe, expect, test } from "bun:test";
import {
  createManifestTransactions,
  PERSONAL_MANIFEST_OPERATION,
} from "./manifest";

const context = {
  ownerGithubAccountId: 11,
  origin: "https://os.example.test",
  publicPrefix: "",
  browserSessionId: "browser-A",
};
const binding = { ...context, operation: PERSONAL_MANIFEST_OPERATION };

describe("personal manifest transactions", () => {
  test("private User App manifest has no org membership or webhook events", () => {
    const transactions = createManifestTransactions();
    const start = transactions.begin(context);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const manifest = JSON.parse(start.manifest);
    expect(manifest.public).toBe(false);
    expect(manifest.hook_attributes).toEqual({ active: false });
    expect(manifest.default_events).toEqual([]);
    expect(manifest.default_permissions.members).toBeUndefined();
    expect(new URL(start.action).pathname).toBe("/settings/apps/new");
    expect(transactions.consume({ ...binding, state: start.state }).ok).toBe(
      true,
    );
    expect(
      transactions.consume({ ...binding, state: start.state }),
    ).toMatchObject({ ok: false, code: "manifest_replayed" });
  });
  for (const [field, value, code] of [
    ["ownerGithubAccountId", 12, "manifest_owner_mismatch"],
    ["origin", "https://evil.example", "manifest_origin_mismatch"],
    ["browserSessionId", "browser-B", "manifest_session_mismatch"],
    ["operation", "shared-app", "manifest_operation_mismatch"],
  ] as const)
    test(`consumes before rejecting ${field}`, () => {
      const tx = createManifestTransactions();
      const start = tx.begin(context);
      if (!start.ok) throw new Error(start.code);
      expect(
        tx.consume({ ...binding, state: start.state, [field]: value }),
      ).toMatchObject({ ok: false, code });
      expect(tx.consume({ ...binding, state: start.state }).ok).toBe(false);
    });
  test("expiry and bounded pending state", () => {
    let time = 1;
    const tx = createManifestTransactions({
      now: () => time,
      ttlMs: 10,
      maxPending: 2,
      maxPendingPerOwner: 1,
    });
    const first = tx.begin(context);
    if (!first.ok) throw new Error(first.code);
    expect(tx.begin(context)).toMatchObject({ code: "manifest_limit" });
    expect(tx.begin({ ...context, ownerGithubAccountId: 12 }).ok).toBe(true);
    expect(tx.begin({ ...context, ownerGithubAccountId: 13 })).toMatchObject({
      code: "manifest_limit",
    });
    time = 11;
    expect(tx.consume({ ...binding, state: first.state })).toMatchObject({
      code: "manifest_expired",
    });
    expect(tx.pendingCount()).toBe(0);
  });
  for (const owner of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    test(`invalid numeric principal ${owner}`, () => {
      expect(
        createManifestTransactions().begin({
          ...context,
          ownerGithubAccountId: owner,
        }),
      ).toMatchObject({ code: "invalid_principal" });
    });
});
