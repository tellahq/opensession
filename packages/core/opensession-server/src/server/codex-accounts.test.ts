import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  __setCodexAccountsPathForTest,
  addCodexAccount,
  clearCodexWedge,
  hrwScore,
  loadCodexAccounts,
  listCodexAccountsPublic,
  markCodexExhausted,
  markCodexWedged,
  setCodexAccountLabel,
} from "./codex-accounts";
import { pickOpenaiAccount } from "./openai-auth";

// PINNED-HASH tests (pattern from meridian PR #615): session→account affinity
// is a pure function of these scores. If any assertion here fails, the change
// reshuffles EVERY session's account assignment and cold-starts their
// provider prompt caches — that must be a deliberate decision, not a drive-by.
describe("hrwScore (rendezvous affinity)", () => {
  test("pinned values are stable across versions", () => {
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

  test("different sessions can land on different accounts (spread exists)", () => {
    // With the two pinned pairs above, session 1 prefers account B and
    // session 2 prefers account A — the whole point of rendezvous hashing.
    const s1 =
      hrwScore(
        "bks-019f7182-a597-7000-96b0-50fdc06f8694",
        "13fde4f9-e1f2-486c-8e04-1d0f322b7636",
      ) >
      hrwScore(
        "bks-019f7182-a597-7000-96b0-50fdc06f8694",
        "eae22618-bd72-45ab-8307-4949b5e409cd",
      );
    const s2 =
      hrwScore("bks-test-session", "eae22618-bd72-45ab-8307-4949b5e409cd") >
      hrwScore("bks-test-session", "13fde4f9-e1f2-486c-8e04-1d0f322b7636");
    expect(s1).toBe(true);
    expect(s2).toBe(true);
  });
});

describe("pickOpenaiAccount pins", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-pins-"));
  const store = join(dir, "accounts.json");
  const chatgptHome = join(dir, "chatgpt-home");
  let previousStore: string;

  beforeAll(async () => {
    previousStore = await __setCodexAccountsPathForTest(store);
    mkdirSync(chatgptHome, { recursive: true });
    const claims = Buffer.from(
      JSON.stringify({ email: "person@example.com" }),
    ).toString("base64url");
    writeFileSync(
      join(chatgptHome, "auth.json"),
      JSON.stringify({ tokens: { id_token: `header.${claims}.signature` } }),
    );
    writeFileSync(
      store,
      JSON.stringify({
        accounts: [
          {
            id: "shared",
            name: "Shared",
            kind: "api_key",
            value: "sk-shared-value",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "mine",
            name: "Mine",
            kind: "api_key",
            value: "sk-mine-value",
            owner: "Alex",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "theirs",
            name: "Theirs",
            kind: "api_key",
            value: "sk-theirs-value",
            owner: "Grant",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "chatgpt",
            name: "Legacy label",
            kind: "home",
            value: chatgptHome,
            owner: "Grant",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    await loadCodexAccounts();
  });

  afterAll(async () => {
    await __setCodexAccountsPathForTest(previousStore);
    rmSync(dir, { recursive: true, force: true });
  });

  test("exposes the ChatGPT email from existing auth files", () => {
    expect(
      listCodexAccountsPublic().find((account) => account.id === "chatgpt")
        ?.email,
    ).toBe("person@example.com");
  });

  test("prefers an eligible conversation pin", () => {
    const reason: { reason?: string } = {};
    const picked = pickOpenaiAccount(
      "gpt-5.5",
      undefined,
      "session",
      reason,
      "Alex",
      "shared",
    );
    expect("error" in picked).toBe(false);
    if (!("error" in picked)) expect(picked.id).toBe("shared");
    expect(reason.reason).toBe("pinned");
  });

  test("falls back from an exhausted soft pin but fails a hard pin", () => {
    markCodexExhausted("mine", "gpt-5.5");
    const soft = pickOpenaiAccount(
      "gpt-5.5",
      undefined,
      "session",
      {},
      "Alex",
      "mine",
    );
    expect("error" in soft).toBe(false);
    if (!("error" in soft)) expect(soft.id).toBe("shared");

    const strict = pickOpenaiAccount(
      "gpt-5.5",
      undefined,
      "session",
      {},
      "Alex",
      "mine",
      true,
    );
    expect(strict).toEqual({
      error:
        "pinned account Mine is not currently usable (hard pin — not falling back to the pool)",
    });
  });

  test("never honors another user's personal pin", () => {
    const picked = pickOpenaiAccount(
      "gpt-5.5",
      undefined,
      "session",
      {},
      "Alex",
      "theirs",
    );
    expect("error" in picked).toBe(false);
    if (!("error" in picked)) expect(picked.id).not.toBe("theirs");
  });

  test("wedge sideline removes the account from picks; clear restores it", () => {
    expect(markCodexWedged("shared")).toBe(true);
    const picked = pickOpenaiAccount(
      "gpt-5.5",
      undefined,
      "session",
      {},
      undefined,
      undefined,
    );
    // "shared" is the only owner-less account, so a user-less pick goes dry.
    expect("error" in picked).toBe(true);
    clearCodexWedge("shared");
    const restored = pickOpenaiAccount(
      "gpt-5.5",
      undefined,
      "session",
      {},
      undefined,
      undefined,
    );
    expect("error" in restored).toBe(false);
    if (!("error" in restored)) expect(restored.id).toBe("shared");
  });

  test("wedge never shortens a usage-limit sideline", () => {
    markCodexExhausted("shared");
    // The hour-long exhaustion outlasts the 5-minute wedge window, so the
    // wedge must refuse (false) and clearCodexWedge — which callers only run
    // after a true — must not be reachable to un-sideline the account.
    expect(markCodexWedged("shared")).toBe(false);
    const picked = pickOpenaiAccount(
      "gpt-5.5",
      undefined,
      "session",
      {},
      undefined,
      undefined,
    );
    expect("error" in picked).toBe(true);
  });

  test("renames an account and clears the name back to its email", async () => {
    expect(await setCodexAccountLabel("chatgpt", "  Work  ")).toMatchObject({
      label: "Work",
      email: "person@example.com",
      owner: "Grant",
    });
    expect(
      listCodexAccountsPublic().find((account) => account.id === "chatgpt")
        ?.label,
    ).toBe("Work");
    expect((await setCodexAccountLabel("chatgpt", " "))?.label).toBeUndefined();
    expect(await setCodexAccountLabel("missing", "Work")).toBeNull();
  });

  test("registers a ChatGPT login by email without a supplied name", async () => {
    const home = join(dir, "new-chatgpt-home");
    mkdirSync(home, { recursive: true });
    const claims = Buffer.from(
      JSON.stringify({ email: "new@example.com" }),
    ).toString("base64url");
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({ tokens: { id_token: `header.${claims}.signature` } }),
    );
    expect(await addCodexAccount("", "home", home)).toMatchObject({
      name: "new@example.com",
      email: "new@example.com",
    });
  });
});

describe("pickOpenaiAccount ultrafast routing", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-ultrafast-"));
  const store = join(dir, "accounts.json");
  let previousStore: string;

  const jwt = (claims: object) =>
    `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  const planClaims = (plan: string) => ({
    "https://api.openai.com/auth": { chatgpt_plan_type: plan },
  });
  const home = (
    id: string,
    tokens: { access?: string; id?: string },
    owner?: string,
  ) => {
    const path = join(dir, id);
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "auth.json"),
      JSON.stringify({
        tokens: { access_token: tokens.access, id_token: tokens.id },
      }),
    );
    return {
      id,
      name: id,
      kind: "home",
      value: path,
      ...(owner ? { owner } : {}),
      createdAt: "2026-01-01T00:00:00Z",
    };
  };

  beforeAll(async () => {
    previousStore = await __setCodexAccountsPathForTest(store);
    writeFileSync(
      store,
      JSON.stringify({
        accounts: [
          home("pro", { access: jwt(planClaims("pro")) }),
          // A refreshed access token outranks a stale ID token.
          home("promax", {
            access: jwt(planClaims("promax")),
            id: jwt(planClaims("pro")),
          }),
          home("alex-pro", { access: jwt(planClaims("pro")) }, "Alex"),
        ],
      }),
    );
    await loadCodexAccounts();
  });

  afterAll(async () => {
    await __setCodexAccountsPathForTest(previousStore);
    rmSync(dir, { recursive: true, force: true });
  });

  const pick = (
    session: string,
    user?: string,
    pinned?: string,
    ultrafast = true,
  ) => {
    const picked = pickOpenaiAccount(
      "gpt-6-astra",
      undefined,
      session,
      undefined,
      user,
      pinned,
      false,
      undefined,
      ultrafast ? "promax" : undefined,
    );
    return "error" in picked ? picked.error : picked.id;
  };

  test("exposes each login's ChatGPT plan", () => {
    const plans = Object.fromEntries(
      listCodexAccountsPublic().map((account) => [account.id, account.plan]),
    );
    expect(plans).toEqual({ pro: "pro", promax: "promax", "alex-pro": "pro" });
  });

  test("routes every session to the Pro $500 account, even over a personal one", () => {
    for (const session of ["s1", "s2", "s3", "s4", "s5"]) {
      expect(pick(session)).toBe("promax");
      expect(pick(session, "Alex")).toBe("promax");
    }
    // Without the preference, Alex keeps using a personal account first.
    expect(pick("s1", "Alex", undefined, false)).toBe("alex-pro");
  });

  test("keeps an explicit pin", () => {
    expect(pick("s1", undefined, "pro")).toBe("pro");
  });

  test("falls back to the ordinary pool when no Pro $500 account is usable", () => {
    markCodexExhausted("promax", "gpt-6-astra");
    expect(pick("s1")).toBe("pro");
    expect(pick("s1", "Alex")).toBe("alex-pro");
  });
});
