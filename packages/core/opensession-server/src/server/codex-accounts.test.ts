import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  __setCodexAccountsPathForTest,
  addCodexAccount,
  clearCodexWedge,
  hrwScore,
  listCodexAccountsPublic,
  markCodexExhausted,
  markCodexWedged,
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

  beforeAll(() => {
    previousStore = __setCodexAccountsPathForTest(store);
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
  });

  afterAll(() => {
    __setCodexAccountsPathForTest(previousStore);
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

  test("registers a ChatGPT login by email without a supplied name", () => {
    const home = join(dir, "new-chatgpt-home");
    mkdirSync(home, { recursive: true });
    const claims = Buffer.from(
      JSON.stringify({ email: "new@example.com" }),
    ).toString("base64url");
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({ tokens: { id_token: `header.${claims}.signature` } }),
    );
    expect(addCodexAccount("", "home", home)).toMatchObject({
      name: "new@example.com",
      email: "new@example.com",
    });
  });
});
