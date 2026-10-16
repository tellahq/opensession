/**
 * Fixed-subscription policy: a session opted in at creation keeps exactly its
 * pinned account for every turn and for the sessions created from it, and
 * fails closed instead of finding other funding. Unmanaged sessions keep the
 * soft pin.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Point the Claude store at a temp file BEFORE it loads (env is read at import).
const dir = mkdtempSync(join(tmpdir(), "fixed-subscription-test-"));
const claudeStore = join(dir, "claude-accounts.json");
const codexStore = join(dir, "codex-accounts.json");
process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = claudeStore;

const mkClaude = (id: string, owner?: string) => ({
  id,
  name: id,
  token: `sk-ant-oat01-${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...(owner ? { owner } : {}),
});

writeFileSync(
  claudeStore,
  JSON.stringify({
    accounts: [mkClaude("team"), mkClaude("spare"), mkClaude("owned", "Alex")],
  }),
);
writeFileSync(
  codexStore,
  JSON.stringify({
    accounts: [
      {
        id: "openai-team",
        name: "OpenAI team",
        kind: "api_key",
        value: "sk-example-value",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  }),
);

const CLAUDE_MODEL = "pi/anthropic/claude-opus-5";
const OPENAI_MODEL = "pi/openai/gpt-6.1-sol";

let policy: typeof import("./fixed-subscription");
let accounts: typeof import("./claude-accounts");
let runInputs: typeof import("./session-run-inputs");
let previousCodexStore: string;

beforeAll(async () => {
  const codex = await import("./codex-accounts");
  previousCodexStore = codex.__setCodexAccountsPathForTest(codexStore);
  policy = await import("./fixed-subscription");
  accounts = await import("./claude-accounts");
  runInputs = await import("./session-run-inputs");
});

afterAll(async () => {
  const codex = await import("./codex-accounts");
  codex.__setCodexAccountsPathForTest(previousCodexStore);
});

const usage = (fiveHourPct: number) => ({
  fetchedAt: new Date().toISOString(),
  fiveHour: { utilization: fiveHourPct, resetsAt: null },
  sevenDay: null,
  extraUsage: null,
});

describe("resolveCreateSubscriptionPolicy", () => {
  test("off by default: a soft pin passes through with no policy", () => {
    expect(
      policy.resolveCreateSubscriptionPolicy({
        sources: [null, undefined],
        model: CLAUDE_MODEL,
        requestedAccountId: "team",
        pinnedAccountId: "team",
      }),
    ).toEqual({ accountId: "team" });
  });

  test("opting in needs a usable pin", () => {
    expect(() =>
      policy.resolveCreateSubscriptionPolicy({
        fixed: true,
        sources: [],
        model: CLAUDE_MODEL,
        // A foreign or unknown id was already dropped by resolvePinnedAccountId.
        requestedAccountId: "owned",
        pinnedAccountId: undefined,
      }),
    ).toThrow(/needs an accountId/);
    expect(
      policy.resolveCreateSubscriptionPolicy({
        fixed: true,
        sources: [],
        model: CLAUDE_MODEL,
        requestedAccountId: "team",
        pinnedAccountId: "team",
      }),
    ).toEqual({ accountId: "team", subscriptionPolicy: "fixed" });
  });

  test("opting in refuses a model the account's provider cannot serve", () => {
    expect(() =>
      policy.resolveCreateSubscriptionPolicy({
        fixed: true,
        sources: [],
        model: OPENAI_MODEL,
        requestedAccountId: "team",
        pinnedAccountId: "team",
      }),
    ).toThrow(/Claude account/);
  });

  test("a child of a fixed session inherits its account and policy", () => {
    const parent = {
      id: "bks-parent",
      subscriptionPolicy: "fixed" as const,
      accountId: "team",
    };
    expect(
      policy.resolveCreateSubscriptionPolicy({
        sources: [undefined, parent],
        model: CLAUDE_MODEL,
        requestedAccountId: undefined,
        pinnedAccountId: undefined,
      }),
    ).toEqual({ accountId: "team", subscriptionPolicy: "fixed" });
  });

  test("a child cannot pick another account or provider", () => {
    const parent = {
      id: "bks-parent",
      subscriptionPolicy: "fixed" as const,
      accountId: "team",
    };
    expect(() =>
      policy.resolveCreateSubscriptionPolicy({
        sources: [parent],
        model: CLAUDE_MODEL,
        requestedAccountId: "spare",
        pinnedAccountId: "spare",
      }),
    ).toThrow(/bks-parent has a fixed subscription/);
    expect(() =>
      policy.resolveCreateSubscriptionPolicy({
        sources: [parent],
        model: OPENAI_MODEL,
        requestedAccountId: undefined,
        pinnedAccountId: undefined,
      }),
    ).toThrow(/cannot run/);
  });

  // Source order as session-control-wiring passes it: fork source, parent,
  // then the trusted invoking session. The first two come from tool args.
  const fixedTo = (id: string, accountId: string) => ({
    id,
    subscriptionPolicy: "fixed" as const,
    accountId,
  });

  test("a fork fixed to another account cannot replace the caller's", () => {
    expect(() =>
      policy.resolveCreateSubscriptionPolicy({
        sources: [
          fixedTo("bks-fork", "spare"),
          null,
          fixedTo("bks-caller", "team"),
        ],
        model: CLAUDE_MODEL,
        requestedAccountId: undefined,
        pinnedAccountId: "spare",
      }),
    ).toThrow(/different accounts/);
  });

  test("an unfixed parent does not widen a fixed caller", () => {
    expect(
      policy.resolveCreateSubscriptionPolicy({
        sources: [
          undefined,
          { id: "bks-parent", accountId: "spare" },
          fixedTo("bks-caller", "team"),
        ],
        model: CLAUDE_MODEL,
        requestedAccountId: undefined,
        pinnedAccountId: undefined,
      }),
    ).toEqual({ accountId: "team", subscriptionPolicy: "fixed" });
  });

  test("a fixed parent binds the child of an unfixed caller", () => {
    expect(
      policy.resolveCreateSubscriptionPolicy({
        sources: [
          undefined,
          fixedTo("bks-parent", "team"),
          { id: "bks-caller", accountId: "spare" },
        ],
        model: CLAUDE_MODEL,
        requestedAccountId: undefined,
        pinnedAccountId: undefined,
      }),
    ).toEqual({ accountId: "team", subscriptionPolicy: "fixed" });
  });

  test("any two fixed sources on different accounts are rejected", () => {
    expect(() =>
      policy.resolveCreateSubscriptionPolicy({
        sources: [fixedTo("bks-a", "team"), fixedTo("bks-b", "spare")],
        model: CLAUDE_MODEL,
        requestedAccountId: undefined,
        pinnedAccountId: undefined,
      }),
    ).toThrow(/different accounts/);
    // Agreeing fixed sources are fine.
    expect(
      policy.resolveCreateSubscriptionPolicy({
        sources: [fixedTo("bks-a", "team"), fixedTo("bks-b", "team")],
        model: CLAUDE_MODEL,
        requestedAccountId: undefined,
        pinnedAccountId: undefined,
      }),
    ).toEqual({ accountId: "team", subscriptionPolicy: "fixed" });
  });

  test("an unmanaged parent does not make its child fixed", () => {
    expect(
      policy.resolveCreateSubscriptionPolicy({
        sources: [{ id: "bks-parent", accountId: "team" }],
        model: CLAUDE_MODEL,
        requestedAccountId: "spare",
        pinnedAccountId: "spare",
      }),
    ).toEqual({ accountId: "spare" });
  });
});

describe("fixedSubscriptionTurnError", () => {
  test("unmanaged sessions are never refused", () => {
    expect(
      policy.fixedSubscriptionTurnError({ accountId: "gone", model: "x" }),
    ).toBeUndefined();
  });

  test("a matching provider account may run", () => {
    expect(
      policy.fixedSubscriptionTurnError({
        subscriptionPolicy: "fixed",
        accountId: "team",
        model: CLAUDE_MODEL,
      }),
    ).toBeUndefined();
    expect(
      policy.fixedSubscriptionTurnError({
        subscriptionPolicy: "fixed",
        accountId: "openai-team",
        model: OPENAI_MODEL,
      }),
    ).toBeUndefined();
  });

  test("a disconnected account stops the turn", () => {
    expect(
      policy.fixedSubscriptionTurnError({
        subscriptionPolicy: "fixed",
        accountId: "removed-account",
        model: CLAUDE_MODEL,
      }),
    ).toMatch(/no longer connected/);
  });

  test("a model on another provider stops the turn", () => {
    expect(
      policy.fixedSubscriptionTurnError({
        subscriptionPolicy: "fixed",
        accountId: "team",
        model: OPENAI_MODEL,
      }),
    ).toMatch(/cannot run/);
  });

  test("a preset that routes to other models stops the turn", () => {
    expect(
      policy.fixedSubscriptionTurnError({
        subscriptionPolicy: "fixed",
        accountId: "team",
        model: "workspace-preset/ws1/preset1",
      }),
    ).toMatch(/model preset/);
  });

  test("a fixed session without an account stops the turn", () => {
    expect(
      policy.fixedSubscriptionTurnError({
        subscriptionPolicy: "fixed",
        model: CLAUDE_MODEL,
      }),
    ).toMatch(/no funding account/);
  });
});

describe("runAccountSpec under a fixed subscription", () => {
  test("an unmanaged session keeps its soft pin", () => {
    expect(
      runInputs.runAccountSpec(
        { accountId: "team" },
        { isAutomationSession: false },
      ),
    ).toEqual({
      accountId: "team",
      accountStrict: undefined,
      usageCredits: undefined,
    });
  });

  test("a fixed session is a hard pin with no usage credits", () => {
    expect(
      runInputs.runAccountSpec(
        { accountId: "team", subscriptionPolicy: "fixed" },
        { isAutomationSession: false, accountUser: "Robin" },
      ),
    ).toEqual({ accountId: "team", accountStrict: true, usageCredits: false });
  });

  test("no turn shape or automation pin widens a fixed session", () => {
    const session = { accountId: "team", subscriptionPolicy: "fixed" as const };
    expect(
      runInputs.runAccountSpec(session, {
        isAutomationSession: true,
        accountUser: "Robin",
      }),
    ).toEqual({ accountId: "team", accountStrict: true, usageCredits: false });
    expect(
      runInputs.runAccountSpec(
        session,
        { isAutomationSession: true },
        { accountId: "spare", usageCredits: true },
      ),
    ).toEqual({ accountId: "team", accountStrict: true, usageCredits: false });
  });

  test("the resulting pin refuses instead of falling back to the pool", () => {
    accounts.__setUsageCacheForTest("team", usage(100));
    accounts.__setUsageCacheForTest("spare", usage(0));
    const spec = runInputs.runAccountSpec(
      { accountId: "team", subscriptionPolicy: "fixed" },
      { isAutomationSession: false },
    );
    const resolved = accounts.resolveAccount({
      pinnedId: spec.accountId,
      strictPin: spec.accountStrict,
      allowExtraUsage: spec.usageCredits,
    });
    expect(resolved).toEqual({
      refusal: { kind: "pin-unusable", pinnedId: "team", pinName: "team" },
    });
  });
});
