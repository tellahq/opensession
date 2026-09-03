import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  __setXaiAccountsPathForTest,
  addXaiAccount,
  buildXaiRemoteUpload,
  ensureFreshXaiAccount,
  listXaiAccountsPublic,
  markXaiExhausted,
  mergeXaiCatalog,
  pickXaiAccount,
  removeXaiAccount,
  setXaiAccountOwner,
  XAI_FALLBACK_MODELS,
  XAI_REMOTE_SEED_REFRESH,
  xaiProviderRegistration,
  xaiSubscriptionModelEfforts,
} from "./xai-accounts";

const FAR = Date.now() + 60 * 60 * 1000;

describe("xai account pool", () => {
  const dir = mkdtempSync(join(tmpdir(), "xai-accounts-"));
  const store = join(dir, "accounts.json");
  let previousStore: string;

  beforeAll(() => {
    previousStore = __setXaiAccountsPathForTest(store);
    writeFileSync(
      store,
      JSON.stringify({
        accounts: [
          {
            id: "shared",
            name: "shared@example.com",
            email: "shared@example.com",
            createdAt: "2026-01-01T00:00:00Z",
            access: "a",
            refresh: "r-shared",
            expires: FAR,
          },
          {
            id: "mine",
            name: "alex@example.com",
            email: "alex@example.com",
            owner: "Alex",
            createdAt: "2026-01-01T00:00:00Z",
            access: "a",
            refresh: "r-mine",
            expires: FAR,
          },
          {
            id: "theirs",
            name: "grant@example.com",
            email: "grant@example.com",
            owner: "Grant",
            createdAt: "2026-01-01T00:00:00Z",
            access: "a",
            refresh: "r-theirs",
            expires: FAR,
          },
        ],
      }),
    );
  });

  afterAll(() => {
    __setXaiAccountsPathForTest(previousStore);
    rmSync(dir, { recursive: true, force: true });
  });

  test("public listing never carries tokens", () => {
    const listed = listXaiAccountsPublic();
    expect(listed.map((a) => a.id).sort()).toEqual([
      "mine",
      "shared",
      "theirs",
    ]);
    for (const account of listed) {
      expect(account).not.toHaveProperty("access");
      expect(account).not.toHaveProperty("refresh");
      expect(account.kind).toBe("oauth");
    }
    expect(listed.find((a) => a.id === "mine")?.mode).toBe("personal");
  });

  test("a person's own account wins, other people's are never eligible", () => {
    const out: { reason?: string } = {};
    const mine = pickXaiAccount({ user: "Alex", sessionKey: "s", out });
    expect("error" in mine ? mine.error : mine.id).toBe("mine");
    expect(out.reason).toBe("personal-hrw");
    const shared = pickXaiAccount({ user: "Nobody", sessionKey: "s" });
    expect("error" in shared ? shared.error : shared.id).toBe("shared");
    const anonymous = pickXaiAccount({ sessionKey: "s" });
    expect("error" in anonymous ? anonymous.error : anonymous.id).toBe(
      "shared",
    );
  });

  test("pins: eligible pin wins, a foreign pin falls back, a strict pin refuses", () => {
    const pinned = pickXaiAccount({ user: "Alex", pinnedId: "mine" });
    expect("error" in pinned ? pinned.error : pinned.id).toBe("mine");
    const foreign = pickXaiAccount({ user: "Alex", pinnedId: "theirs" });
    expect("error" in foreign ? foreign.error : foreign.id).toBe("mine");
    const strict = pickXaiAccount({
      user: "Alex",
      pinnedId: "theirs",
      strict: true,
    });
    expect("error" in strict && strict.error).toContain("hard pin");
  });

  test("sideline and exclusion take an account out of rotation", () => {
    markXaiExhausted("shared", "grok-4.6");
    const forModel = pickXaiAccount({ model: "grok-4.6", sessionKey: "s" });
    expect("error" in forModel && forModel.error).toContain("no usable");
    const otherModel = pickXaiAccount({ model: "grok-4.5", sessionKey: "s" });
    expect("error" in otherModel ? otherModel.error : otherModel.id).toBe(
      "shared",
    );
    expect(
      listXaiAccountsPublic().find((a) => a.id === "shared")?.exhaustedUntil,
    ).toBeNull();
    const excluded = pickXaiAccount({
      user: "Alex",
      exclude: new Set(["mine"]),
    });
    expect("error" in excluded ? excluded.error : excluded.id).toBe("shared");
  });

  test("add, re-own and remove round-trip through the store", () => {
    const added = addXaiAccount({
      tokens: { access: "x", refresh: "r-new", expires: FAR },
      email: "new@example.com",
      owner: " Sam ",
    });
    expect("error" in added ? added.error : added.owner).toBe("Sam");
    const dupe = addXaiAccount({
      tokens: { access: "x", refresh: "r-new", expires: FAR },
      email: "other@example.com",
    });
    expect("error" in dupe && dupe.error).toContain("already registered");
    const id = "error" in added ? "" : added.id;
    expect(setXaiAccountOwner(id, "")?.mode).toBe("shared");
    expect(JSON.parse(readFileSync(store, "utf-8")).accounts).toHaveLength(4);
    expect(removeXaiAccount(id)).toBe(true);
    expect(removeXaiAccount(id)).toBe(false);
  });

  test("a designated list is walked in order and fences the pin", () => {
    const first = pickXaiAccount({
      user: "Alex",
      restrictIds: ["shared", "mine"],
    });
    expect("error" in first ? first.error : first.id).toBe("shared");
    const skipsMissing = pickXaiAccount({
      user: "Alex",
      restrictIds: ["gone", "mine"],
    });
    expect("error" in skipsMissing ? skipsMissing.error : skipsMissing.id).toBe(
      "mine",
    );
    const foreign = pickXaiAccount({
      user: "Kent",
      restrictIds: ["mine"],
    });
    expect("error" in foreign && foreign.error).toContain("no designated");
    const undesignatedPin = pickXaiAccount({
      user: "Alex",
      pinnedId: "mine",
      strict: true,
      restrictIds: ["shared"],
    });
    expect("error" in undesignatedPin && undesignatedPin.error).toContain(
      "hard pin",
    );
  });

  test("nameless login without an email is refused", () => {
    expect(
      addXaiAccount({ tokens: { access: "x", refresh: "r-x", expires: FAR } }),
    ).toMatchObject({ error: expect.stringContaining("email") });
  });
});

describe("xai sandbox copies", () => {
  const dir = mkdtempSync(join(tmpdir(), "xai-remote-"));
  const store = join(dir, "accounts.json");
  let previousStore: string;
  const base = {
    createdAt: "2026-01-01T00:00:00Z",
    lastRefreshAt: "2026-01-01T00:30:00Z",
    hostOnlyFuture: "drop-me",
  };

  beforeAll(() => {
    previousStore = __setXaiAccountsPathForTest(store);
    writeFileSync(
      store,
      JSON.stringify({
        accounts: [
          {
            ...base,
            id: "shared",
            name: "shared@example.com",
            email: "shared@example.com",
            access: "a-shared",
            refresh: "r-shared",
            expires: FAR,
          },
          {
            ...base,
            id: "mine",
            name: "alex@example.com",
            owner: "Alex",
            access: "a-mine",
            refresh: "r-mine",
            expires: FAR,
          },
          {
            ...base,
            id: "theirs",
            name: "kent@example.com",
            owner: "Kent",
            access: "a-theirs",
            refresh: "r-theirs",
            expires: FAR,
          },
          {
            ...base,
            id: "seeded-dead",
            name: "seed@example.com",
            access: "a-old",
            refresh: XAI_REMOTE_SEED_REFRESH,
            expires: Date.now() - 1000,
          },
        ],
      }),
    );
  });

  afterAll(() => {
    __setXaiAccountsPathForTest(previousStore);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a guest projection is scoped, rebuilt field by field and cannot refresh", async () => {
    const upload = await buildXaiRemoteUpload({ user: "Alex" });
    expect(upload.accounts.map((a) => a.id)).toEqual(["shared", "mine"]);
    expect(upload.accounts[0]).toEqual({
      id: "shared",
      name: "shared@example.com",
      email: "shared@example.com",
      createdAt: "2026-01-01T00:00:00Z",
      access: "a-shared",
      refresh: XAI_REMOTE_SEED_REFRESH,
      expires: FAR,
    });
    expect(upload.accounts[1].owner).toBe("Alex");
    expect(upload.skipped.map((s) => s.account.id)).toEqual(["seeded-dead"]);
    expect(upload.skipped[0].reason).toContain("cannot be refreshed");
  });

  test("a pin narrows the upload to one account, a foreign pin never widens", async () => {
    const own = await buildXaiRemoteUpload({ user: "Alex", accountId: "mine" });
    expect(own.accounts.map((a) => a.id)).toEqual(["mine"]);
    const foreign = await buildXaiRemoteUpload({
      user: "Kent",
      accountId: "mine",
    });
    expect(foreign.accounts.map((a) => a.id)).toEqual(["shared", "theirs"]);
    const designated = await buildXaiRemoteUpload({
      user: "Alex",
      restrictIds: ["mine"],
    });
    expect(designated.accounts.map((a) => a.id)).toEqual(["mine"]);
    const userless = await buildXaiRemoteUpload({});
    expect(userless.accounts.map((a) => a.id)).toEqual(["shared"]);
  });

  test("a read-only store refuses to rotate the host's grant", async () => {
    const before = readFileSync(store, "utf-8");
    const stale = {
      ...base,
      id: "stale",
      name: "stale@example.com",
      access: "a-stale",
      refresh: "r-stale",
      expires: Date.now() - 1000,
    };
    writeFileSync(
      store,
      JSON.stringify({ accounts: [...JSON.parse(before).accounts, stale] }),
    );
    chmodSync(store, 0o400);
    try {
      await expect(ensureFreshXaiAccount(stale)).rejects.toThrow(
        /cannot be refreshed: the account store is read-only/,
      );
    } finally {
      chmodSync(store, 0o600);
      writeFileSync(store, before);
    }
  });
});

describe("xai catalog", () => {
  test("live entries enrich the fallback and unknown ids get safe defaults", () => {
    const merged = mergeXaiCatalog(XAI_FALLBACK_MODELS, [
      { id: "grok-4.6", contextWindow: 640_000, name: "Grok 4.6 (live)" },
      { id: "grok-5-preview", supportsReasoningEffort: true },
    ]);
    expect(merged[0]).toMatchObject({
      id: "grok-4.6",
      name: "Grok 4.6 (live)",
      contextWindow: 640_000,
      effortCapable: true,
    });
    expect(merged[1]).toMatchObject({
      id: "grok-5-preview",
      reasoning: true,
      effortCapable: true,
      cost: { input: 0, output: 0 },
    });
    expect(merged.map((m) => m.id)).toContain("grok-build");
  });

  test("efforts follow the model's reasoning dial", () => {
    expect(xaiSubscriptionModelEfforts("grok-4.6")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(xaiSubscriptionModelEfforts("grok-build")).toEqual([]);
  });

  test("registration routes every model through the CLI proxy", () => {
    const plan = xaiProviderRegistration("grok-9-unknown", "session-1");
    expect(plan.api).toBe("openai-responses");
    expect(plan.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(plan.headers["x-grok-conv-id"]).toBe("session-1");
    const unknown = plan.models.find((m) => m.id === "grok-9-unknown");
    expect(unknown?.headers["x-grok-model-override"]).toBe("grok-9-unknown");
    const capable = plan.models.find((m) => m.id === "grok-4.6");
    expect(capable?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      xhigh: "xhigh",
    });
    const plain = plan.models.find((m) => m.id === "grok-build");
    expect(plain?.thinkingLevelMap).toEqual({ off: null });
  });
});
