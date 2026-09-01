import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Point the module at a temp store BEFORE it loads (env is read at import).
const dir = mkdtempSync(join(tmpdir(), "claude-accounts-test-"));
const storePath = join(dir, "accounts.json");
process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = storePath;

const mkAccount = (id: string, owner?: string) => ({
  id,
  name: id,
  token: `sk-ant-oat01-${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...(owner ? { owner } : {}),
});

writeFileSync(
  storePath,
  JSON.stringify({
    accounts: [
      mkAccount("fresh"),
      mkAccount("maxed"),
      mkAccount("personal", "Alex"),
      mkAccount("blind-personal", "Jaap"),
    ],
  }),
);

const usage = (
  fiveHourPct: number,
  extra?: { enabled: boolean; usedCredits: number; monthlyLimit: number },
) => ({
  fetchedAt: new Date().toISOString(),
  fiveHour: { utilization: fiveHourPct, resetsAt: null },
  sevenDay: null,
  extraUsage: extra ?? null,
});

let accounts: typeof import("./claude-accounts");

beforeAll(async () => {
  accounts = await import("./claude-accounts");
});

describe("pickAccount usage-credits policy", () => {
  test("skips a maxed account by default, even with credit headroom", () => {
    accounts.__setUsageCacheForTest("fresh", usage(50));
    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: true, usedCredits: 0, monthlyLimit: 100_000 }),
    );
    expect(accounts.pickAccount(new Set(["fresh"]))?.id).toBeUndefined();
  });

  test("allowExtraUsage picks a maxed account with credit headroom", () => {
    expect(
      accounts.pickAccount(new Set(["fresh"]), undefined, undefined, true)?.id,
    ).toBe("maxed");
  });

  test("prefers subscription capacity over credits when both are available", () => {
    expect(
      accounts.pickAccount(undefined, undefined, undefined, true)?.id,
    ).toBe("fresh");
  });

  test("no headroom when extra usage is off or the monthly cap is spent", () => {
    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: false, usedCredits: 0, monthlyLimit: 100_000 }),
    );
    expect(
      accounts.pickAccount(new Set(["fresh"]), undefined, undefined, true),
    ).toBeUndefined();

    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, {
        enabled: true,
        usedCredits: 100_001,
        monthlyLimit: 100_000,
      }),
    );
    expect(
      accounts.pickAccount(new Set(["fresh"]), undefined, undefined, true),
    ).toBeUndefined();

    // A zero monthly cap fails closed — this gate exists to bound spend.
    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: true, usedCredits: 0, monthlyLimit: 0 }),
    );
    expect(
      accounts.pickAccount(new Set(["fresh"]), undefined, undefined, true),
    ).toBeUndefined();
  });

  test("getUsableAccountById honors allowExtraUsage the same way", () => {
    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: true, usedCredits: 50_000, monthlyLimit: 100_000 }),
    );
    expect(accounts.getUsableAccountById("maxed")).toBeUndefined();
    expect(accounts.getUsableAccountById("maxed", undefined, true)?.id).toBe(
      "maxed",
    );
  });

  test("getAccountById returns records regardless of usability", () => {
    expect(accounts.getAccountById("maxed")?.id).toBe("maxed");
    expect(accounts.getAccountById("nope")).toBeUndefined();
  });

  test("does not preemptively sideline accounts from inferred Meridian usage", () => {
    accounts.__setUsageCacheForTest("fresh", usage(50));
    accounts.__setUsageCacheForTest("maxed", {
      ...usage(100),
      scopedLimits: [{ label: "Fable", utilization: 100, resetsAt: null }],
      source: "meridian",
    });
    expect(
      accounts.pickAccount(new Set(["fresh"]), undefined, "claude-fable-5")?.id,
    ).toBe("maxed");
    accounts.__setUsageCacheForTest("maxed", usage(100));
  });

  test("allows a blind personal account for a singleton Fable requirement", () => {
    expect(
      accounts.pickAccount(undefined, "Jaap", ["claude-fable-5"])?.id,
    ).toBe("blind-personal");
  });

  test("requires capacity for every model in a preset", () => {
    accounts.__setUsageCacheForTest("fresh", {
      ...usage(20),
      scopedLimits: [
        { label: "Opus", utilization: 20, resetsAt: null },
        { label: "Fable", utilization: 100, resetsAt: null },
      ],
    });
    expect(
      accounts.pickAccount(new Set(["maxed"]), undefined, "claude-opus-5")?.id,
    ).toBe("fresh");
    expect(
      accounts.pickAccount(new Set(["maxed"]), undefined, [
        "claude-opus-5",
        "claude-fable-5",
      ]),
    ).toBeUndefined();
    accounts.__setUsageCacheForTest("fresh", usage(20));
    expect(
      accounts.pickAccount(new Set(["maxed"]), undefined, [
        "claude-opus-5",
        "claude-fable-5",
      ]),
    ).toBeUndefined();
    accounts.__setUsageCacheForTest("fresh", usage(50));
  });

  test("personal accounts stay off-limits to userless (automation) picks", () => {
    accounts.__setUsageCacheForTest("personal", usage(0));
    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: false, usedCredits: 0, monthlyLimit: 0 }),
    );
    expect(
      accounts.pickAccount(new Set(["fresh"]), undefined, undefined, true),
    ).toBeUndefined();
  });
});

describe("resolveAccount owner gate", () => {
  // "Robin" owns nothing; the fixture's personal accounts belong to Alex and
  // Jaap. Every account below is left usable on purpose, so a refusal can
  // only come from the owner rule.
  const seedUsable = () => {
    accounts.__setUsageCacheForTest("fresh", usage(50));
    accounts.__setUsageCacheForTest("maxed", usage(60));
    accounts.__setUsageCacheForTest("personal", usage(0));
  };

  test("a pinned foreign personal account is refused in pool mode", () => {
    seedUsable();
    const soft = accounts.resolveAccount({
      user: "Robin",
      pinnedId: "personal",
    });
    expect(soft).not.toHaveProperty("refusal");
    expect((soft as any).account.id).not.toBe("personal");
    expect((soft as any).reason).toBe("pool");
    // A strict pin refuses rather than silently borrowing the subscription.
    const strict = accounts.resolveAccount({
      user: "Robin",
      pinnedId: "personal",
      strictPin: true,
    });
    expect((strict as any).refusal).toEqual({
      kind: "pin-unusable",
      pinnedId: "personal",
      pinName: "personal",
    });
  });

  test("a pinned foreign personal account is refused in designated mode", () => {
    seedUsable();
    const soft = accounts.resolveAccount({
      user: "Robin",
      pinnedId: "personal",
      designatedIds: ["personal", "fresh"],
    });
    expect((soft as any).account.id).toBe("fresh");
    expect((soft as any).reason).toBe("designated");
    const strict = accounts.resolveAccount({
      user: "Robin",
      pinnedId: "personal",
      strictPin: true,
      designatedIds: ["personal", "fresh"],
    });
    expect((strict as any).refusal.kind).toBe("pin-unusable");
  });

  test("a designated personal account serves its owner only", () => {
    seedUsable();
    const other = accounts.resolveAccount({
      user: "Robin",
      designatedIds: ["personal", "fresh"],
    });
    expect((other as any).account.id).toBe("fresh");
    const owner = accounts.resolveAccount({
      user: "Alex",
      designatedIds: ["personal", "fresh"],
    });
    expect((owner as any).account.id).toBe("personal");
    // An automation (no user) never reaches a personal account either — with
    // nothing else designated there is simply nothing to serve on.
    const automation = accounts.resolveAccount({ designatedIds: ["personal"] });
    expect((automation as any).refusal).toEqual({
      kind: "designated-dry",
      tried: "personal",
    });
  });

  test("a foreign sticky account falls through to the pool", () => {
    seedUsable();
    const resolved = accounts.resolveAccount({
      user: "Robin",
      stickyId: "personal",
    });
    expect((resolved as any).account.id).not.toBe("personal");
    expect((resolved as any).reason).toBe("pool");
    const owner = accounts.resolveAccount({
      user: "Alex",
      stickyId: "personal",
    });
    expect((owner as any).account.id).toBe("personal");
    expect((owner as any).reason).toBe("sticky");
  });

  test("reports the reason for the path that produced the account", () => {
    seedUsable();
    expect((accounts.resolveAccount({ pinnedId: "fresh" }) as any).reason).toBe(
      "pinned",
    );
    expect((accounts.resolveAccount({ stickyId: "maxed" }) as any).reason).toBe(
      "sticky",
    );
    expect(
      (accounts.resolveAccount({ designatedIds: ["maxed", "fresh"] }) as any)
        .reason,
    ).toBe("designated");
    expect((accounts.resolveAccount({ user: "Alex" }) as any).reason).toBe(
      "personal",
    );
    expect((accounts.resolveAccount({}) as any).reason).toBe("pool");
  });

  test("peek does not consume the round-robin turn", () => {
    seedUsable();
    // Same utilization bucket: whoever was picked least recently wins, so a
    // peek must leave the next pick's answer unchanged.
    accounts.__setUsageCacheForTest("maxed", usage(50));
    const first = (accounts.resolveAccount({}) as any).account.id;
    const peeked = (accounts.resolveAccount({ recordPick: false }) as any)
      .account.id;
    expect(
      (accounts.resolveAccount({ recordPick: false }) as any).account.id,
    ).toBe(peeked);
    expect(first).not.toBe(peeked);
  });
});

describe("dry-pool backpressure", () => {
  const maxedWindow = (resetsAt: string | null) => ({
    fetchedAt: new Date().toISOString(),
    fiveHour: { utilization: 100, resetsAt },
    sevenDay: null,
    extraUsage: null,
  });

  test("a maxed account whose cached window already reset counts as usable", () => {
    // Window rolled 1 minute ago but the cache still says 100% — the stale
    // cache must not sideline the account until the next hourly poll.
    accounts.__setUsageCacheForTest("fresh", usage(50));
    accounts.__setUsageCacheForTest(
      "maxed",
      maxedWindow(new Date(Date.now() - 60_000).toISOString()),
    );
    expect(accounts.pickAccount(new Set(["fresh"]))?.id).toBe("maxed");
    // A window that resets in the future still sidelines it.
    accounts.__setUsageCacheForTest(
      "maxed",
      maxedWindow(new Date(Date.now() + 60_000).toISOString()),
    );
    expect(accounts.pickAccount(new Set(["fresh"]))).toBeUndefined();
  });

  test("earliestPoolReset reports the sidelined window's reset", () => {
    const resetAt = Date.now() + 5 * 60_000;
    accounts.__setUsageCacheForTest(
      "fresh",
      maxedWindow(new Date(resetAt).toISOString()),
    );
    accounts.__setUsageCacheForTest(
      "maxed",
      maxedWindow(new Date(resetAt + 60_000).toISOString()),
    );
    const earliest = accounts.earliestPoolReset();
    expect(earliest).not.toBeNull();
    expect(Math.abs((earliest as number) - resetAt)).toBeLessThan(1000);
  });

  test("earliestPoolReset is now-ish when something is usable", () => {
    accounts.__setUsageCacheForTest("fresh", usage(10));
    const earliest = accounts.earliestPoolReset();
    expect(earliest).not.toBeNull();
    expect((earliest as number) - Date.now()).toBeLessThan(1000);
  });

  test("earliestPoolReset excludes accounts outside the designated bridge set", () => {
    accounts.__setUsageCacheForTest("fresh", usage(10));
    expect(
      accounts.earliestPoolReset(undefined, undefined, "fresh", false, [
        "maxed",
      ]),
    ).toBeNull();
  });

  test("waitForUsableAccount returns immediately once pick succeeds", async () => {
    accounts.__setUsageCacheForTest("fresh", usage(10));
    const picked = await accounts.waitForUsableAccount({
      pick: () => accounts.pickAccount() ?? null,
      maxWaitMs: 5_000,
      pollMs: 10,
    });
    expect(picked?.id).toBe("fresh");
  });

  test("waitForUsableAccount fails fast when the earliest reset is beyond the budget", async () => {
    const far = new Date(Date.now() + 60 * 60_000).toISOString();
    accounts.__setUsageCacheForTest("fresh", maxedWindow(far));
    accounts.__setUsageCacheForTest("maxed", maxedWindow(far));
    const t0 = Date.now();
    const picked = await accounts.waitForUsableAccount({
      pick: () => accounts.pickAccount() ?? null,
      maxWaitMs: 1_000,
      pollMs: 10,
    });
    expect(picked).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test("waitForUsableAccount picks up an account freed while waiting", async () => {
    const soon = new Date(Date.now() + 150).toISOString();
    accounts.__setUsageCacheForTest("fresh", maxedWindow(soon));
    accounts.__setUsageCacheForTest("maxed", maxedWindow(soon));
    const picked = await accounts.waitForUsableAccount({
      pick: () => accounts.pickAccount() ?? null,
      maxWaitMs: 5_000,
      pollMs: 50,
    });
    expect(picked).not.toBeNull();
  });

  test("waitForUsableAccount stops promptly when its run is cancelled", async () => {
    const soon = new Date(Date.now() + 2_000).toISOString();
    accounts.__setUsageCacheForTest("fresh", maxedWindow(soon));
    accounts.__setUsageCacheForTest("maxed", maxedWindow(soon));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const t0 = Date.now();
    const picked = await accounts.waitForUsableAccount({
      pick: () => accounts.pickAccount() ?? null,
      maxWaitMs: 5_000,
      pollMs: 1_000,
      signal: controller.signal,
    });
    expect(picked).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("pickBridgeAccount renders the owner-gate refusals", () => {
  // The wordings are load-bearing: isPiUsageLimitShape (pi-runner.ts) decides
  // whether the model-fallback walk engages by matching these substrings
  // against the lowercased message, so resolveAccount hands back a structured
  // refusal and each caller keeps its own text.
  const ocConfig = join(dir, "model-providers.json");
  const saved = process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
  let bridge: typeof import("./anthropic-bridge");
  const designate = (ids: string[]) =>
    writeFileSync(
      ocConfig,
      JSON.stringify({ enabled: true, bridge: { accounts: ids } }),
    );

  beforeAll(async () => {
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = ocConfig;
    bridge = await import("./anthropic-bridge");
  });

  afterAll(() => {
    if (saved === undefined)
      delete process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
    else process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = saved;
  });

  test("a designation of only someone else's personal account is dry", () => {
    accounts.__setUsageCacheForTest("personal", usage(0));
    designate(["personal"]);
    const picked = bridge.pickBridgeAccount("claude-sonnet-5", {
      user: "Robin",
    });
    const error = (picked as any).error as string;
    expect(error).toBe(
      "no designated bridge account is currently usable (tried: personal)",
    );
    expect(error.toLowerCase()).toContain("no designated bridge account");
    // Its owner still gets served.
    expect(
      (bridge.pickBridgeAccount("claude-sonnet-5", { user: "Alex" }) as any).id,
    ).toBe("personal");
  });

  test("a strict pin on someone else's personal account is refused in pool mode", () => {
    accounts.__setUsageCacheForTest("personal", usage(0));
    accounts.__setUsageCacheForTest("fresh", usage(50));
    accounts.__setUsageCacheForTest("maxed", usage(90));
    designate([]);
    const picked = bridge.pickBridgeAccount("claude-sonnet-5", {
      user: "Robin",
      accountId: "personal",
      accountStrict: true,
    });
    const error = (picked as any).error as string;
    expect(error).toContain('no usable Claude account (pinned "personal"');
    expect(error.toLowerCase()).toContain("no usable claude account");
    // Non-strict, the same pin falls through to the pool instead.
    const widened = bridge.pickBridgeAccount("claude-sonnet-5", {
      user: "Robin",
      accountId: "personal",
    });
    expect((widened as any).id).toBe("fresh");
  });
});

describe("refreshUsageIfNearLimit", () => {
  const agedUsage = (fiveHourPct: number, ageMs: number) => ({
    fetchedAt: new Date(Date.now() - ageMs).toISOString(),
    fiveHour: { utilization: fiveHourPct, resetsAt: null },
    sevenDay: null,
    extraUsage: null,
  });
  const min = 60_000;
  let refreshed: string[] = [];
  const arm = () => {
    refreshed = [];
    accounts.__setNearLimitRefresherForTest(async (a) => {
      refreshed.push(a.id);
      return null;
    });
  };

  test("leaves low-utilization accounts alone regardless of cache age", async () => {
    arm();
    accounts.__setUsageCacheForTest("fresh", agedUsage(50, 55 * min));
    expect(await accounts.refreshUsageIfNearLimit("fresh")).toBe(false);
    expect(refreshed).toEqual([]);
  });

  test("refreshes a near-limit account with a stale snapshot", async () => {
    arm();
    accounts.__setUsageCacheForTest("fresh", agedUsage(92, 6 * min));
    expect(await accounts.refreshUsageIfNearLimit("fresh")).toBe(true);
    expect(refreshed).toEqual(["fresh"]);
  });

  test("cooldown: no second refresh right after the first", async () => {
    arm();
    accounts.__setUsageCacheForTest("fresh", agedUsage(92, 6 * min));
    expect(await accounts.refreshUsageIfNearLimit("fresh")).toBe(true);
    expect(await accounts.refreshUsageIfNearLimit("fresh")).toBe(false);
    expect(refreshed).toEqual(["fresh"]);
  });

  test("trusts a recent snapshot even when near the limit", async () => {
    arm();
    accounts.__setUsageCacheForTest("fresh", agedUsage(92, 1 * min));
    expect(await accounts.refreshUsageIfNearLimit("fresh")).toBe(false);
    expect(refreshed).toEqual([]);
  });

  test("lower tier: 75%+ refreshes only once the snapshot is older", async () => {
    arm();
    accounts.__setUsageCacheForTest("maxed", agedUsage(78, 10 * min));
    expect(await accounts.refreshUsageIfNearLimit("maxed")).toBe(false);
    accounts.__setUsageCacheForTest("maxed", agedUsage(78, 25 * min));
    expect(await accounts.refreshUsageIfNearLimit("maxed")).toBe(true);
    expect(refreshed).toEqual(["maxed"]);
  });

  test("unknown account or empty cache refreshes nothing", async () => {
    arm();
    expect(await accounts.refreshUsageIfNearLimit("nope")).toBe(false);
    expect(refreshed).toEqual([]);
  });
});

describe("sidelines survive a restart", () => {
  // Both accounts are usageScope "missing" with no credentials file, so
  // markExhausted's background usage refresh returns before any network call.
  const blind = (id: string) => ({
    ...mkAccount(id),
    usageScope: "missing" as const,
  });
  const originalStore = readFileSync(storePath, "utf-8");

  beforeAll(() => {
    const parsed = JSON.parse(originalStore);
    writeFileSync(
      storePath,
      JSON.stringify({
        accounts: [
          ...parsed.accounts,
          blind("reboot"),
          blind("reboot-model"),
          blind("reboot-opus"),
        ],
      }),
    );
    const fableSpent = {
      ...usage(10),
      scopedLimits: [{ label: "Fable", utilization: 100, resetsAt: null }],
    };
    accounts.__setUsageCacheForTest("reboot", fableSpent);
    accounts.__setUsageCacheForTest("reboot-model", fableSpent);
    accounts.__setUsageCacheForTest("reboot-opus", usage(10));
    accounts.markExhausted("reboot");
    accounts.markExhausted("reboot-model", "claude-fable-5");
    accounts.markExhausted(
      "reboot-opus",
      "claude-opus-5",
      Date.now() + 2 * 60 * 60 * 1000,
    );
    // What a `systemctl restart opensession` does to the in-memory map.
    accounts.__reloadSidelinesForTest();
  });

  afterAll(() => writeFileSync(storePath, originalStore));

  test("an account-level sideline is still in force after a reload", () => {
    const publics = accounts.listAccountsPublic();
    const rebooted = publics.find((a) => a.id === "reboot");
    expect(rebooted?.exhaustedUntil).not.toBeNull();
    expect(rebooted?.usable).toBe(false);
    expect(
      accounts.pickAccount(
        new Set(["fresh", "maxed", "reboot-model", "reboot-opus"]),
      ),
    ).toBeUndefined();
  });

  test("a model-scoped sideline survives, and only for that model", () => {
    const rebooted = accounts
      .listAccountsPublic()
      .find((a) => a.id === "reboot-model");
    expect(rebooted?.exhaustedUntil).toBeNull();
    const fable = accounts.earliestPoolReset(
      undefined,
      "claude-fable-5",
      "reboot-model",
    );
    expect(fable).not.toBeNull();
    expect((fable as number) - Date.now()).toBeGreaterThan(1000);
    const sonnet = accounts.earliestPoolReset(
      undefined,
      "claude-sonnet-5",
      "reboot-model",
    );
    expect((sonnet as number) - Date.now()).toBeLessThan(1000);

    const opus = accounts.earliestPoolReset(
      undefined,
      "claude-opus-5",
      "reboot-opus",
    );
    expect((opus as number) - Date.now()).toBeGreaterThan(60 * 60 * 1000);
    const otherModel = accounts.earliestPoolReset(
      undefined,
      "claude-sonnet-5",
      "reboot-opus",
    );
    expect((otherModel as number) - Date.now()).toBeLessThan(1000);
  });
});
