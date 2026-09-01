import { describe, expect, test } from "bun:test";
import { AccountRouter } from "./router";
import { hrwScore, leastRecentlyPicked, rendezvousAffinity } from "./selectors";
import type { AccountAvailability, RoutableAccount } from "./types";

interface TestAccount extends RoutableAccount {
  readonly capacity: "subscription" | "paid";
}

const accounts: TestAccount[] = [
  {
    id: "shared-a",
    name: "Shared A",
    access: { kind: "shared" },
    capacity: "subscription",
  },
  {
    id: "shared-b",
    name: "Shared B",
    access: { kind: "shared" },
    capacity: "paid",
  },
  {
    id: "shared-c",
    name: "Shared C",
    access: { kind: "shared" },
    capacity: "subscription",
  },
  {
    id: "alex",
    name: "Alex",
    access: { kind: "personal", owner: "Alex" },
    capacity: "subscription",
  },
  {
    id: "grant",
    name: "Grant",
    access: { kind: "personal", owner: "Grant" },
    capacity: "subscription",
  },
];

function router(input?: {
  readonly unavailable?: ReadonlySet<string>;
  readonly affinity?: boolean;
}): AccountRouter<TestAccount> {
  let now = 0;
  return new AccountRouter({
    accounts: () => accounts,
    availability: (account, request): AccountAvailability => {
      if (input?.unavailable?.has(account.id)) return { kind: "unavailable" };
      if (account.capacity === "paid" && !request.allowPaidUsage) {
        return { kind: "unavailable" };
      }
      return {
        kind: "available",
        priority: account.capacity === "subscription" ? 0 : 100,
      };
    },
    select: input?.affinity
      ? rendezvousAffinity<TestAccount>()
      : leastRecentlyPicked<TestAccount>(),
    ownerMatches: (principalId, owner) =>
      principalId.toLowerCase() === owner.toLowerCase(),
    clock: () => {
      now += 1;
      return now;
    },
  });
}

function selectedId(
  resolution: ReturnType<AccountRouter<TestAccount>["resolve"]>,
) {
  expect(resolution.kind).toBe("selected");
  return resolution.kind === "selected" ? resolution.account.id : undefined;
}

describe("AccountRouter", () => {
  test("applies the owner gate to pins, designations, and pool picks", () => {
    const subject = router();
    const softPin = subject.resolve({ principalId: "Robin", pinnedId: "alex" });
    expect(selectedId(softPin)).toBe("shared-a");

    expect(
      subject.resolve({
        principalId: "Robin",
        pinnedId: "alex",
        strictPin: true,
      }),
    ).toEqual({
      kind: "refused",
      refusal: {
        kind: "pin-unusable",
        pinnedId: "alex",
        pinName: "Alex",
      },
    });

    expect(
      subject.resolve({ principalId: "Robin", designatedIds: ["alex"] }),
    ).toEqual({
      kind: "refused",
      refusal: { kind: "designated-dry", tried: "Alex" },
    });
    expect(selectedId(subject.resolve({ principalId: "Alex" }))).toBe("alex");
    expect(selectedId(subject.resolve({}))).toBe("shared-c");
  });

  test("honors pin, sticky, and designation order", () => {
    const subject = router();
    expect(selectedId(subject.resolve({ pinnedId: "shared-a" }))).toBe(
      "shared-a",
    );
    expect(selectedId(subject.resolve({ stickyId: "shared-a" }))).toBe(
      "shared-a",
    );
    expect(
      selectedId(
        subject.resolve({
          designatedIds: ["shared-b", "shared-a"],
          allowPaidUsage: true,
        }),
      ),
    ).toBe("shared-b");
    expect(
      subject.resolve({
        pinnedId: "shared-a",
        strictPin: true,
        designatedIds: ["shared-b"],
        allowPaidUsage: true,
      }),
    ).toMatchObject({
      kind: "refused",
      refusal: { kind: "pin-not-designated" },
    });
  });

  test("uses subscription capacity before opted-in paid capacity", () => {
    const subject = router();
    expect(selectedId(subject.resolve({ allowPaidUsage: true }))).toBe(
      "shared-a",
    );
    const withoutSubscription = router({
      unavailable: new Set(["shared-a", "shared-c"]),
    });
    expect(
      selectedId(withoutSubscription.resolve({ allowPaidUsage: true })),
    ).toBe("shared-b");
    expect(withoutSubscription.resolve({})).toMatchObject({
      kind: "refused",
      refusal: { kind: "pool-dry" },
    });
  });

  test("does not consume an LRU turn while peeking", () => {
    const subject = router();
    expect(selectedId(subject.resolve({ allowPaidUsage: true }))).toBe(
      "shared-a",
    );
    const firstPeek = selectedId(
      subject.resolve({ allowPaidUsage: true, recordPick: false }),
    );
    const secondPeek = selectedId(
      subject.resolve({ allowPaidUsage: true, recordPick: false }),
    );
    expect(firstPeek).toBe("shared-c");
    expect(secondPeek).toBe(firstPeek);
  });

  test("keeps rendezvous affinity stable while excluding failed accounts", () => {
    const subject = router({ affinity: true });
    const request = { affinityKey: "bks-test-session", allowPaidUsage: true };
    const first = selectedId(subject.resolve(request));
    const second = selectedId(subject.resolve(request));
    expect(second).toBe(first);
    const fallback = selectedId(
      subject.resolve({ ...request, excludeIds: new Set([first ?? ""]) }),
    );
    expect(fallback).not.toBe(first);
  });
});

describe("hrwScore", () => {
  test("keeps the existing affinity vectors pinned", () => {
    expect(
      hrwScore(
        "bks-019f7182-a597-7000-96b0-50fdc06f8694",
        "eae22618-bd72-45ab-8307-4949b5e409cd",
      ),
    ).toBe(1742935766);
    expect(
      hrwScore(
        "bks-019f7182-a597-7000-96b0-50fdc06f8694",
        "13fde4f9-e1f2-486c-8e04-1d0f322b7636",
      ),
    ).toBe(3956256899);
    expect(
      hrwScore("bks-test-session", "eae22618-bd72-45ab-8307-4949b5e409cd"),
    ).toBe(3693026164);
    expect(
      hrwScore("bks-test-session", "13fde4f9-e1f2-486c-8e04-1d0f322b7636"),
    ).toBe(1275860373);
  });
});
