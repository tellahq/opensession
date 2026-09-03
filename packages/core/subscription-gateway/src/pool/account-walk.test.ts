import { describe, expect, test } from "bun:test";
import { walkAccounts } from "./account-walk";
import type { AccountResolution, RoutableAccount } from "./types";

const shared = (index: number): RoutableAccount => ({
  id: `account-${index}`,
  name: `Account ${index}`,
  access: { kind: "shared" },
});

describe("walkAccounts", () => {
  test("walks every account without a fixed retry limit", async () => {
    const accounts = Array.from({ length: 25 }, (_, index) => shared(index));
    const attempted: string[] = [];
    const result = await walkAccounts({
      acquire: (excluded): AccountResolution<RoutableAccount> => {
        const account = accounts.find(
          (candidate) => !excluded.has(candidate.id),
        );
        return account
          ? { kind: "selected", account, reason: "pool" }
          : { kind: "refused", refusal: { kind: "pool-dry" } };
      },
      attempt: ({ account }) => {
        attempted.push(account.id);
        return account.id === "account-24"
          ? { kind: "succeeded", value: "done" }
          : { kind: "retry-account", error: new Error("limited") };
      },
      onEvent: () => undefined,
    });

    expect(result).toMatchObject({
      kind: "succeeded",
      account: { id: "account-24" },
      value: "done",
    });
    expect(attempted).toHaveLength(25);
  });

  test("retries after replay-safe events", async () => {
    const events: string[] = [];
    const attempts: string[] = [];
    const result = await walkAccounts({
      acquire: (excluded): AccountResolution<RoutableAccount> => {
        const account = [shared(0), shared(1)].find(
          (candidate) => !excluded.has(candidate.id),
        );
        return account
          ? { kind: "selected", account, reason: "pool" }
          : { kind: "refused", refusal: { kind: "pool-dry" } };
      },
      attempt: ({ account, emit }) => {
        attempts.push(account.id);
        emit({ kind: "replay-safe", value: `usage:${account.id}` });
        return account.id === "account-0"
          ? { kind: "retry-account", error: new Error("limited") }
          : { kind: "succeeded", value: "done" };
      },
      onEvent: (event: string) => events.push(event),
    });
    expect(result.kind).toBe("succeeded");
    expect(attempts).toEqual(["account-0", "account-1"]);
    expect(events).toEqual(["usage:account-0", "usage:account-1"]);
  });

  test("never replays after client-visible output", async () => {
    const attempts: string[] = [];
    const result = await walkAccounts({
      acquire: (excluded): AccountResolution<RoutableAccount> => {
        const account = [shared(0), shared(1)].find(
          (candidate) => !excluded.has(candidate.id),
        );
        return account
          ? { kind: "selected", account, reason: "pool" }
          : { kind: "refused", refusal: { kind: "pool-dry" } };
      },
      attempt: ({ account, emit }) => {
        attempts.push(account.id);
        emit({ kind: "client-visible", value: "partial answer" });
        return { kind: "retry-account", error: new Error("limited") };
      },
      onEvent: () => undefined,
    });
    expect(result).toMatchObject({
      kind: "failed",
      account: { id: "account-0" },
      replayBlocked: true,
    });
    expect(attempts).toEqual(["account-0"]);
  });

  test("a strict pin refuses rather than widening", async () => {
    const pinned = shared(0);
    const fallback = shared(1);
    const result = await walkAccounts({
      acquire: (excluded): AccountResolution<RoutableAccount> => {
        if (excluded.has(pinned.id)) {
          return {
            kind: "refused",
            refusal: {
              kind: "pin-unusable",
              pinnedId: pinned.id,
              pinName: pinned.name,
            },
          };
        }
        return { kind: "selected", account: pinned, reason: "pinned" };
      },
      attempt: () => ({
        kind: "retry-account",
        error: new Error(`do not use ${fallback.id}`),
      }),
      onEvent: () => undefined,
    });
    expect(result).toMatchObject({
      kind: "refused",
      refusal: { kind: "pin-unusable", pinnedId: "account-0" },
    });
  });
});
