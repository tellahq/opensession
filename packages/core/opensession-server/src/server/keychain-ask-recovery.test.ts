/**
 * A keychain ask must stay recoverable when the agent's request_credential
 * call gives up before the owner answers: the approval still mints a grant the
 * session can list, a repeat request re-surfaces the pending ask instead of
 * refusing, and the session can withdraw its own ask.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Never the real stores: both are resolved from these before any import.
const scratch = mkdtempSync(join(tmpdir(), "kc-ask-recovery-"));
const STORE = join(scratch, "kc.json");
process.env.OPENSESSION_KEYCHAIN_STORE = STORE;
process.env.OPENSESSION_SESSIONS_DIR = join(scratch, "sessions");

const realMappings = await import("./shared/user-mappings");
mock.module("./shared/user-mappings", () => ({
  ...realMappings,
  resolveTeammate: (ref?: string | null) =>
    ref?.trim().toLowerCase() === "alex"
      ? { name: "Alex", slackId: "UALEX0001" }
      : ref?.trim().toLowerCase() === "bea"
        ? { name: "Bea", slackId: "UBEA00001" }
        : null,
}));

// Slack transport: record what the owner would see instead of calling Slack.
const slackPosts: Array<{ channel: string; text: string; threadTs?: string }> =
  [];
/** Runs while a threaded reply is in flight, e.g. the owner answering. */
let duringReply: (() => void) | null = null;
let nextTs = 1;
const realSlack = await import("../agents/slack/slack-api");
mock.module("../agents/slack/slack-api", () => ({
  ...realSlack,
  openDirectMessage: async () => "DALEX",
  postSlackBlocks: async (channel: string, text: string) => {
    slackPosts.push({ channel, text });
    return { ok: true, ts: `100.${nextTs++}` };
  },
  sendSlackMessage: async (
    channel: string,
    text: string,
    threadTs?: string,
  ) => {
    slackPosts.push({ channel, text, threadTs });
    const hook = duringReply;
    duringReply = null;
    await Promise.resolve();
    hook?.();
    return { ok: true };
  },
  updateSlackBlocks: async () => ({ ok: true }),
}));

// One web session driven by the credential's owner; every other id is unknown.
const DRIVEN = "os-driven-by-owner";
const realCache = await import("./session-cache");
mock.module("./session-cache", () => ({
  ...realCache,
  findSession: (id: string) =>
    id === DRIVEN
      ? { id, source: "opensession", startedBy: "Alex" }
      : undefined,
}));

// Session question cards: keep the answer callback instead of broadcasting.
const cards: Array<{
  sessionId: string;
  answer: (answers: Record<string, string> | null) => void;
}> = [];
const realAsks = await import("./asks");
mock.module("./asks", () => ({
  ...realAsks,
  offerAskCard: async (
    sessionId: string,
    _questions: unknown,
    answer: (answers: Record<string, string> | null) => void,
  ) => {
    cards.push({ sessionId, answer });
    return { close: async () => {} };
  },
}));

// Session frames: record them instead of reaching any socket.
const frames: Array<{ sessionId: string; msg: any }> = [];
const realHub = await import("./ws-hub");
mock.module("./ws-hub", () => ({
  ...realHub,
  broadcastToSession: (sessionId: string, msg: object) => {
    frames.push({ sessionId, msg });
  },
}));

// Delivery normally runs as a durable session-kernel effect; deliver inline.
const realKernel = await import("./session-kernel");
mock.module("./session-kernel", () => ({
  ...realKernel,
  sessionKernel: () => ({ enqueueEffect: async () => {} }),
}));

const humanAsks = await import("./human-asks");
const runRpc = await import("./run-rpc");
const kc = await import("./keychain");
const { createKeychainMcpServer } =
  await import("../agents/slack/keychain-tools");
const { handleKeychainRoutes } = await import("./routes/keychain");

function route(
  path: string,
  authUser: { login: string; name: string; automation?: boolean } | null,
  body?: unknown,
) {
  const url = new URL(path, "https://os.example.test");
  return handleKeychainRoutes({
    path: url.pathname,
    url,
    publicPrefix: "",
    authUser,
    req: new Request(
      url,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    ),
  }) as Promise<Response>;
}

const SESSION = "os-test-session";

function resetKeychain(): void {
  if (existsSync(STORE)) rmSync(STORE);
  const g = globalThis as any;
  g.__keychainCredentials?.clear();
  g.__keychainGrants?.clear();
  g.__keychainAsks?.clear();
}

beforeEach(() => {
  process.env.OPENSESSION_KEYCHAIN_STORE = STORE;
  resetKeychain();
  slackPosts.length = 0;
  duringReply = null;
  cards.length = 0;
  frames.length = 0;
  kc.addCredential({
    owner: "Alex",
    service: "acme-prod",
    host: "api.example.test",
    secret: "sk-test-secret",
  });
});

afterEach(() => resetKeychain());

async function connect() {
  const server = createKeychainMcpServer({ sessionId: SESSION, user: "Alex" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function textOf(result: any): string {
  return (result.content as Array<{ text: string }>)
    .map((c) => c.text)
    .join("\n");
}

/** Call request_credential the way an agent does, with a client timeout far
 *  shorter than the owner takes to answer. */
async function requestThatTimesOut(client: Client) {
  const call = client.callTool(
    {
      name: "request_credential",
      arguments: {
        credential: "acme-prod",
        purpose: "read the latest invoice",
        mode: "standing",
      },
    },
    undefined,
    { timeout: 50 },
  );
  await expect(call).rejects.toThrow(/timed out/i);
}

function pendingAsk() {
  const pending = kc
    .listKeychainAsks({ sessionId: SESSION })
    .filter((a) => a.status === "pending");
  expect(pending).toHaveLength(1);
  return pending[0]!;
}

async function deliver(humanAskId: string) {
  expect(await humanAsks.deliverAsk(humanAskId)).toBe(true);
}

describe("a request_credential call that timed out on the client", () => {
  test("the owner's later approval still mints a grant the session can list", async () => {
    const client = await connect();
    await requestThatTimesOut(client);
    const ask = pendingAsk();
    await deliver(ask.humanAskId!);

    expect(humanAsks.resolveByOption(ask.humanAskId!, "Approve standing")).toBe(
      true,
    );

    const grants = kc.listGrants({ sessionId: SESSION });
    expect(grants).toHaveLength(1);
    expect(grants[0]!.status).toBe("active");
    expect(grants[0]!.mode).toBe("standing");
    const listed = textOf(
      await client.callTool({ name: "list_grants", arguments: {} }),
    );
    expect(listed).toContain(grants[0]!.id);
    expect(listed).not.toContain("Pending asks");
  });

  test("the abandoned wait lets go, so a late answer reaches the session", async () => {
    const client = await connect();
    await requestThatTimesOut(client);
    const ask = pendingAsk();
    await deliver(ask.humanAskId!);
    // The client's cancellation reached the tool: nobody holds the answer.
    expect(humanAsks.getAsk(ask.humanAskId!)?.mode).toBe("async");
  });

  test("asking again re-surfaces the pending ask instead of refusing", async () => {
    const client = await connect();
    await requestThatTimesOut(client);
    const ask = pendingAsk();
    await deliver(ask.humanAskId!);
    const before = slackPosts.length;

    const again = client.callTool({
      name: "request_credential",
      arguments: {
        credential: "acme-prod",
        purpose: "read the latest invoice",
        mode: "standing",
      },
    });
    // Let the tool re-notify and start waiting, then the owner approves.
    await Bun.sleep(20);
    expect(pendingAsk().id).toBe(ask.id);
    const reminder = slackPosts.slice(before);
    expect(reminder).toHaveLength(1);
    expect(reminder[0]!.threadTs).toBe(
      humanAsks.getAsk(ask.humanAskId!)?.slack?.rootTs,
    );
    expect(reminder[0]!.text).toContain("<@UALEX0001>");

    humanAsks.resolveByOption(ask.humanAskId!, "Approve standing");
    const answer = textOf(await again);
    expect(answer).not.toContain("already pending");
    const grant = kc.listGrants({ sessionId: SESSION })[0]!;
    expect(answer).toContain(grant.id);
  });

  test("asking again after approval hands back the live grant", async () => {
    const client = await connect();
    await requestThatTimesOut(client);
    const ask = pendingAsk();
    await deliver(ask.humanAskId!);
    humanAsks.resolveByOption(ask.humanAskId!, "Approve standing");
    const grant = kc.listGrants({ sessionId: SESSION })[0]!;

    const again = textOf(
      await client.callTool({
        name: "request_credential",
        arguments: {
          credential: "acme-prod",
          purpose: "Read the latest invoice ",
        },
      }),
    );
    expect(again).toContain(grant.id);
    expect(kc.listKeychainAsks({ sessionId: SESSION })).toHaveLength(1);
  });

  test("a grant for another purpose is not handed back; the owner is asked", async () => {
    const client = await connect();
    await requestThatTimesOut(client);
    const ask = pendingAsk();
    await deliver(ask.humanAskId!);
    humanAsks.resolveByOption(ask.humanAskId!, "Approve standing");

    const result = kc.requestCredential({
      credential: "acme-prod",
      sessionId: SESSION,
      requestedBy: "Alex",
      purpose: "issue refunds",
    });
    if (!("ask" in result)) throw new Error("expected a new ask");
    expect(result.resurfaced).toBeUndefined();
    expect(result.ask.purpose).toBe("issue refunds");
  });

  test("a pending ask for another purpose is not re-surfaced as this one", async () => {
    const client = await connect();
    await requestThatTimesOut(client);
    const ask = pendingAsk();

    const result = kc.requestCredential({
      credential: "acme-prod",
      sessionId: SESSION,
      requestedBy: "Alex",
      purpose: "issue refunds",
    });
    expect("error" in result && result.error).toContain(ask.id);
    expect("error" in result && result.error).toContain(
      "cancel_credential_ask",
    );
    expect(pendingAsk().id).toBe(ask.id);
  });

  test("an approval that lands during the reminder still reaches the call", async () => {
    const client = await connect();
    await requestThatTimesOut(client);
    const ask = pendingAsk();
    await deliver(ask.humanAskId!);
    duringReply = () =>
      humanAsks.resolveByOption(ask.humanAskId!, "Approve standing");

    const answer = textOf(
      await client.callTool(
        {
          name: "request_credential",
          arguments: {
            credential: "acme-prod",
            purpose: "read the latest invoice",
            mode: "standing",
          },
        },
        undefined,
        { timeout: 1_000 },
      ),
    );
    const grant = kc.listGrants({ sessionId: SESSION })[0]!;
    expect(answer).toContain(grant.id);
  });

  test("the session can withdraw its pending ask and ask afresh", async () => {
    const client = await connect();
    await requestThatTimesOut(client);
    const ask = pendingAsk();
    await deliver(ask.humanAskId!);

    const cancelled = textOf(
      await client.callTool({
        name: "cancel_credential_ask",
        arguments: { askId: ask.id },
      }),
    );
    expect(cancelled).toContain("Withdrew");
    expect(
      kc.listKeychainAsks({ sessionId: SESSION }).find((a) => a.id === ask.id)
        ?.status,
    ).toBe("cancelled");
    expect(humanAsks.getAsk(ask.humanAskId!)?.state).toBe("cancelled");
    // The owner's stale button no longer approves anything.
    expect(humanAsks.resolveByOption(ask.humanAskId!, "Approve standing")).toBe(
      false,
    );
    expect(kc.listGrants({ sessionId: SESSION })).toHaveLength(0);

    await requestThatTimesOut(client);
    expect(pendingAsk().id).not.toBe(ask.id);
  });

  test("another session cannot withdraw the ask", () => {
    const result = kc.requestCredential({
      credential: "acme-prod",
      sessionId: SESSION,
      requestedBy: "Alex",
      purpose: "read the latest invoice",
    });
    if (!("ask" in result)) throw new Error("expected an ask");
    expect(kc.cancelCredentialAsk(result.ask.id, "os-other")).toEqual({
      error: "no pending ask with that id in this session",
    });
    expect(pendingAsk().id).toBe(result.ask.id);
  });

  test("an ask whose owner message was cancelled elsewhere does not block a new one", async () => {
    const client = await connect();
    await requestThatTimesOut(client);
    const ask = pendingAsk();
    humanAsks.cancelAsk(ask.humanAskId!);

    await requestThatTimesOut(client);
    const fresh = pendingAsk();
    expect(fresh.id).not.toBe(ask.id);
    expect(
      kc.listKeychainAsks({ sessionId: SESSION }).find((a) => a.id === ask.id)
        ?.status,
    ).toBe("cancelled");
  });
});

describe("an ask to the owner who is driving the session", () => {
  test("never goes up as a session card: only the owner can answer it", async () => {
    // Anyone watching the session, or another agent through session control,
    // could answer a card, so a teammate prompting in the owner's session
    // could approve their own request.
    const server = createKeychainMcpServer({ sessionId: DRIVEN, user: "Alex" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);

    const call = client.callTool({
      name: "request_credential",
      arguments: {
        credential: "acme-prod",
        purpose: "read the latest invoice",
      },
    });
    for (let i = 0; i < 100 && !kc.listKeychainAsks().length; i++)
      await Bun.sleep(5);
    const ask = kc.listKeychainAsks({ sessionId: DRIVEN })[0]!;
    expect(humanAsks.getAsk(ask.humanAskId!)?.uiFirst).toBeUndefined();
    await deliver(ask.humanAskId!);
    await Bun.sleep(10);
    expect(cards).toHaveLength(0);
    expect(slackPosts).toHaveLength(1);

    // A button click from anyone but the person asked is refused.
    expect(
      humanAsks.resolveByOption(ask.humanAskId!, "Approve standing", "UBOB"),
    ).toBe(false);
    expect(kc.listGrants()).toHaveLength(0);

    expect(
      humanAsks.resolveByOption(ask.humanAskId!, "Approve once", "UALEX0001"),
    ).toBe(true);
    const answer = textOf(await call);
    const grant = kc.listGrants({ sessionId: DRIVEN })[0]!;
    expect(grant.mode).toBe("once");
    expect(answer).toContain(grant.id);
  });
});

describe("the owner answering from Settings", () => {
  test("only the owner can answer, and it works before any DM goes out", async () => {
    const client = await connect();
    const call = client.callTool({
      name: "request_credential",
      arguments: { credential: "acme-prod", purpose: "read the invoices" },
    });
    for (let i = 0; i < 100 && !kc.listKeychainAsks().length; i++)
      await Bun.sleep(5);
    const ask = pendingAsk();
    // Not delivered: no Slack, or the owner has no Slack account.
    expect(humanAsks.getAsk(ask.humanAskId!)?.state).toBe("scheduled");

    expect(kc.answerKeychainAsk(ask.id, "standing", "Bob")).toEqual({
      error: "Only the credential's owner can answer this request",
    });
    expect(kc.answerKeychainAsk(ask.id, "standing", "")).toHaveProperty(
      "error",
    );
    expect(kc.listGrants()).toHaveLength(0);

    expect(kc.answerKeychainAsk(ask.id, "standing", "alex")).toEqual({
      ok: true,
      status: "approved",
    });
    const grant = kc.listGrants({ sessionId: SESSION })[0]!;
    expect(grant.mode).toBe("standing");
    expect(textOf(await call)).toContain(grant.id);
    // Settled: a second answer, or the delayed DM, changes nothing.
    expect(kc.answerKeychainAsk(ask.id, "decline", "Alex")).toHaveProperty(
      "error",
    );
    expect(await humanAsks.deliverAsk(ask.humanAskId!)).toBe(false);
  });

  test("a decline mints nothing and tells the session", async () => {
    const client = await connect();
    const call = client.callTool({
      name: "request_credential",
      arguments: { credential: "acme-prod", purpose: "read the invoices" },
    });
    for (let i = 0; i < 100 && !kc.listKeychainAsks().length; i++)
      await Bun.sleep(5);
    const ask = pendingAsk();
    expect(kc.answerKeychainAsk(ask.id, "decline", "Alex")).toEqual({
      ok: true,
      status: "declined",
    });
    expect(textOf(await call)).toContain("declined");
    expect(kc.listGrants()).toHaveLength(0);
  });
});

describe("the keychain routes", () => {
  test("answering needs the owner's own verified sign-in", async () => {
    const client = await connect();
    const call = client.callTool({
      name: "request_credential",
      arguments: { credential: "acme-prod", purpose: "read the invoices" },
    });
    for (let i = 0; i < 100 && !kc.listKeychainAsks().length; i++)
      await Bun.sleep(5);
    const ask = pendingAsk();
    const path = `/api/keychain/asks/${ask.id}/answer`;
    const alex = { login: "alex-gh", name: "Alex Example" };
    const body = { decision: "standing", user: "Alex" };

    // Signed out (a claimed name only) or an automation token: refused.
    expect((await route(path, null, body)).status).toBe(401);
    expect(
      (await route(path, { ...alex, automation: true }, body)).status,
    ).toBe(401);
    expect(
      (await route(path, { login: "bob-gh", name: "Bob Example" }, body))
        .status,
    ).toBe(403);
    expect((await route(path, alex, { decision: "maybe" })).status).toBe(400);
    expect(kc.listGrants()).toHaveLength(0);

    // Everyone sees what exists; only the people involved see the request.
    const bob = await (
      await route("/api/keychain", { login: "bob-gh", name: "Bob Example" })
    ).json();
    expect(bob.credentials).toHaveLength(1);
    expect(bob.asks).toHaveLength(0);
    const mine = await (await route("/api/keychain", alex)).json();
    expect(mine.asks[0].canAnswer).toBe(true);

    expect((await route(path, alex, body)).status).toBe(200);
    expect(textOf(await call)).toContain(kc.listGrants()[0]!.id);
  });
});

describe("the keychain card in the asking session", () => {
  const alex = { login: "alex-gh", name: "Alex Example" };
  const bob = { login: "bob-gh", name: "Bob Example" };
  const list = async (
    authUser: { login: string; name: string; automation?: boolean } | null,
    sessionId = SESSION,
  ) =>
    (
      await (
        await route(`/api/keychain/asks?sessionId=${sessionId}`, authUser)
      ).json()
    ).asks;

  test("shows the ask only to the credential's verified owner", async () => {
    const client = await connect();
    const call = client.callTool({
      name: "request_credential",
      arguments: { credential: "acme-prod", purpose: "read the invoices" },
    });
    for (let i = 0; i < 100 && !kc.listKeychainAsks().length; i++)
      await Bun.sleep(5);
    const ask = pendingAsk();

    // The frame every viewer gets says only that something changed.
    expect(frames).toEqual([
      {
        sessionId: SESSION,
        msg: { type: "keychain_asks_changed", sessionId: SESSION },
      },
    ]);

    // Another teammate, a claimed name, or an automation sees nothing.
    expect(await list(bob)).toEqual([]);
    expect(await list(null)).toEqual([]);
    expect(await list({ ...alex, automation: true })).toEqual([]);
    expect(await list(alex, "os-other-session")).toEqual([]);

    const [card] = await list(alex);
    expect(card).toMatchObject({
      id: ask.id,
      requestedBy: "Alex",
      purpose: "read the invoices",
      requestedMode: "once",
      credentials: [{ service: "acme-prod", host: "api.example.test" }],
    });

    // The card answers through the owner-checked route.
    const path = `/api/keychain/asks/${card.id}/answer`;
    expect((await route(path, bob, { decision: "standing" })).status).toBe(403);
    expect((await route(path, alex, { decision: "standing" })).status).toBe(
      200,
    );
    expect(textOf(await call)).toContain(kc.listGrants()[0]!.id);
    expect(frames).toHaveLength(2);
    expect(await list(alex)).toEqual([]);
  });

  test("a withdrawn ask leaves the card too", async () => {
    const client = await connect();
    void client
      .callTool({
        name: "request_credential",
        arguments: { credential: "acme-prod", purpose: "read the invoices" },
      })
      .catch(() => {});
    for (let i = 0; i < 100 && !kc.listKeychainAsks().length; i++)
      await Bun.sleep(5);
    const ask = pendingAsk();
    expect(await list(alex)).toHaveLength(1);
    kc.cancelCredentialAsk(ask.id, SESSION);
    expect(frames.at(-1)?.msg.type).toBe("keychain_asks_changed");
    expect(await list(alex)).toEqual([]);
  });
});

describe("a scripted-run ask", () => {
  const RUN = { command: "bun scripts/sync.ts" };

  async function askForRun(client: Client) {
    const call = client.callTool({
      name: "request_credential",
      arguments: {
        credential: "acme-prod",
        purpose: "page through every customer to backfill plans",
        run: RUN,
      },
    });
    for (let i = 0; i < 100 && !kc.listKeychainAsks().length; i++)
      await Bun.sleep(5);
    return { call, ask: pendingAsk() };
  }

  test("tells the owner it is a scripted run, with the command and no call cap", async () => {
    const client = await connect();
    const { call, ask } = await askForRun(client);
    expect(ask.requestedMode).toBe("run");
    await deliver(ask.humanAskId!);

    const transport = humanAsks.getAsk(ask.humanAskId!)!;
    expect(transport.options).toEqual(["Approve run", "Decline"]);
    const dm = slackPosts.map((p) => p.text).join("\n");
    expect(dm).toContain("scripted run");
    expect(dm).toContain(RUN.command);
    expect(dm).not.toContain("refused beyond");
    expect(dm).not.toMatch(/up to [\d,]+ (API )?calls/);

    // A once/standing answer from Settings cannot approve a run.
    expect(kc.answerKeychainAsk(ask.id, "once", "Alex")).toHaveProperty(
      "error",
    );
    expect(kc.answerKeychainAsk(ask.id, "run", "Alex")).toEqual({
      ok: true,
      status: "approved",
    });
    const grant = kc.listGrants({ sessionId: SESSION })[0]!;
    expect(grant.mode).toBe("run");
    expect(grant.run).toEqual(RUN);
    const answer = textOf(await call);
    expect(answer).toContain("run_with_credential");
    expect(answer).toContain("KEYCHAIN_PROXY_URL");
  });

  test("a maxCalls an older agent still passes is ignored", async () => {
    const client = await connect();
    const call = client.callTool({
      name: "request_credential",
      arguments: {
        credential: "acme-prod",
        purpose: "page through every customer to backfill plans",
        run: { ...RUN, maxCalls: 13000 },
      },
    });
    for (let i = 0; i < 100 && !kc.listKeychainAsks().length; i++)
      await Bun.sleep(5);
    const ask = pendingAsk();
    expect(ask.run).toEqual(RUN);
    kc.answerKeychainAsk(ask.id, "run", "Alex");
    expect(textOf(await call)).not.toContain("calls, grant");
    expect(kc.listGrants({ sessionId: SESSION })[0]!.run).toEqual(RUN);
  });

  test("an ordinary ask can never be approved as a run", async () => {
    const client = await connect();
    const call = client.callTool({
      name: "request_credential",
      arguments: { credential: "acme-prod", purpose: "read the invoices" },
    });
    for (let i = 0; i < 100 && !kc.listKeychainAsks().length; i++)
      await Bun.sleep(5);
    const ask = pendingAsk();
    expect(kc.answerKeychainAsk(ask.id, "run", "Alex")).toHaveProperty("error");
    expect(kc.parseOwnerAnswer("Approve run", "once")).toEqual({
      approve: true,
      mode: "once",
    });
    kc.answerKeychainAsk(ask.id, "decline", "Alex");
    await call;
    expect(kc.listGrants()).toHaveLength(0);
  });

  test("a run grant is not usable through call_credential", async () => {
    const client = await connect();
    const { call, ask } = await askForRun(client);
    kc.answerKeychainAsk(ask.id, "run", "Alex");
    await call;
    const result = textOf(
      await client.callTool({
        name: "call_credential",
        arguments: { credential: "acme-prod", method: "GET", path: "/v1/x" },
      }),
    );
    expect(result).toContain("no live grant");
  });
});

describe("a scripted run with several credentials", () => {
  const COMMAND = "bun scripts/billing-sync.ts";
  const CREDS = ["payments-prod", "billing-prod"];

  function addPair(billingOwner = "Bea") {
    kc.addCredential({
      owner: "Alex",
      service: "payments-prod",
      host: "api.payments.example.test",
      secret: "sk-payments",
    });
    kc.addCredential({
      owner: billingOwner,
      service: "billing-prod",
      host: "api.billing.example.test",
      secret: "sk-billing",
    });
  }

  async function askForRun(client: Client, owners: number) {
    const call = client.callTool({
      name: "request_credential",
      arguments: {
        credentials: CREDS,
        purpose: "sync every subscription into billing",
        run: { command: COMMAND },
      },
    });
    const pending = () =>
      kc
        .listKeychainAsks({ sessionId: SESSION })
        .filter((a) => a.status === "pending");
    for (let i = 0; i < 100 && !pending().length; i++) await Bun.sleep(5);
    const asks = pending();
    const transports = [...new Set(asks.map((a) => a.humanAskId!))];
    expect(transports).toHaveLength(owners);
    for (const id of transports) await deliver(id);
    const ask = (service: string) =>
      asks.find((a) => kc.findCredential(a.credentialId)?.service === service)!;
    return { call, asks, ask };
  }

  test("each owner approves their part, and the run is ready only once both did", async () => {
    addPair();
    const client = await connect();
    const { call, asks, ask } = await askForRun(client, 2);
    expect(asks).toHaveLength(2);

    // Each owner's message lists every credential in the run, its owner and
    // the exact command, with no call cap.
    expect(slackPosts.map((p) => p.channel)).toEqual(["DALEX", "DALEX"]);
    for (const post of slackPosts) {
      expect(post.text).toContain(COMMAND);
      expect(post.text).toContain("payments-prod");
      expect(post.text).toContain("billing-prod");
      expect(post.text).not.toContain("beyond its cap");
    }
    expect(humanAsks.getAsk(ask("billing-prod").humanAskId!)?.person.name).toBe(
      "Bea",
    );
    expect(humanAsks.getAsk(ask("payments-prod").humanAskId!)?.options).toEqual(
      ["Approve run", "Decline"],
    );

    // Only each credential's own owner can answer for it.
    expect(
      kc.answerKeychainAsk(ask("billing-prod").id, "run", "Alex"),
    ).toHaveProperty("error");
    expect(
      kc.answerKeychainAsk(ask("payments-prod").id, "run", "Alex"),
    ).toEqual({
      ok: true,
      status: "approved",
    });
    expect(
      kc.runGroupAnswer(SESSION, ask("payments-prod").run!.group!.id),
    ).toContain("still waiting on Bea for billing-prod");
    // Alex's approval waits for Bea's rather than lapsing within the hour.
    const hoursLeft = () =>
      kc
        .listGrants({ sessionId: SESSION })
        .map((g) =>
          Math.round((Date.parse(g.expiresAt) - Date.now()) / 3_600_000),
        );
    expect(hoursLeft()).toEqual([24]);

    expect(kc.answerKeychainAsk(ask("billing-prod").id, "run", "Bea")).toEqual({
      ok: true,
      status: "approved",
    });
    // Once both approved, the run must start within the hour.
    expect(hoursLeft()).toEqual([1, 1]);
    const answer = textOf(await call);
    expect(answer).toContain("Every owner approved");
    expect(answer).toContain(
      `run_with_credential({ credentials: ${JSON.stringify(CREDS)}`,
    );
    expect(answer).toContain("KEYCHAIN_PROXY_URL_PAYMENTS_PROD");
    expect(answer).toContain("KEYCHAIN_PROXY_URL_BILLING_PROD");

    const grants = kc.listGrants({ sessionId: SESSION });
    expect(grants.map((g) => [g.owner, g.run?.command]).sort()).toEqual([
      ["Alex", COMMAND],
      ["Bea", COMMAND],
    ]);
    expect(new Set(grants.map((g) => g.run?.group?.id)).size).toBe(1);

    // Asking again hands back the same approvals instead of asking twice.
    const again = textOf(
      await client.callTool({
        name: "request_credential",
        arguments: {
          credentials: CREDS,
          purpose: "sync every subscription into billing",
          run: { command: COMMAND },
        },
      }),
    );
    expect(again).toContain("already holds this run's approvals");
    expect(kc.listKeychainAsks()).toHaveLength(2);
  });

  test("one owner declining withdraws the other's ask and mints nothing", async () => {
    addPair();
    const client = await connect();
    const { call, ask } = await askForRun(client, 2);
    expect(
      kc.answerKeychainAsk(ask("billing-prod").id, "decline", "Bea"),
    ).toEqual({ ok: true, status: "declined" });
    const answer = textOf(await call);
    expect(answer).toContain("Bea declined the scripted run");
    expect(
      kc
        .listKeychainAsks()
        .map((a) => a.status)
        .sort(),
    ).toEqual(["cancelled", "declined"]);
    expect(
      kc.answerKeychainAsk(ask("payments-prod").id, "run", "Alex"),
    ).toHaveProperty("error");
    expect(kc.listGrants()).toHaveLength(0);
  });

  test("asking again after an earlier approval lapsed starts a fresh request", async () => {
    addPair();
    const client = await connect();
    const { call, ask } = await askForRun(client, 2);
    kc.answerKeychainAsk(ask("payments-prod").id, "run", "Alex");
    const alexGrant = kc.listGrants({ sessionId: SESSION })[0]!;
    expect(kc.revokeGrant(alexGrant.id, "Alex")).toEqual({ ok: true });

    slackPosts.length = 0;
    const again = client.callTool({
      name: "request_credential",
      arguments: {
        credentials: CREDS,
        purpose: "sync every subscription into billing",
        run: { command: COMMAND },
      },
    });
    const fresh = () =>
      kc
        .listKeychainAsks({ sessionId: SESSION })
        .filter(
          (a) =>
            a.status === "pending" &&
            a.run?.group?.id !== ask("payments-prod").run!.group!.id,
        );
    for (let i = 0; i < 100 && fresh().length < 2; i++) await Bun.sleep(5);
    // Both owners are asked afresh; Bea's stale ask is withdrawn.
    expect(fresh()).toHaveLength(2);
    expect(
      kc.listKeychainAsks().find((a) => a.id === ask("billing-prod").id)
        ?.status,
    ).toBe("cancelled");
    await call;
    for (const a of fresh()) kc.cancelCredentialAsk(a.id, SESSION);
    await again;
  });

  test("an owner of both credentials gets one message and approves both at once", async () => {
    addPair("Alex");
    const client = await connect();
    const { call, ask } = await askForRun(client, 1);
    expect(slackPosts).toHaveLength(1);
    kc.answerKeychainAsk(ask("billing-prod").id, "run", "Alex");
    expect(textOf(await call)).toContain("Every owner approved");
    expect(kc.listGrants({ sessionId: SESSION })).toHaveLength(2);
  });

  test("a single credential's run ask is unchanged by a pending multi-credential one", async () => {
    addPair();
    const result = kc.requestCredential({
      credential: "payments-prod",
      sessionId: SESSION,
      requestedBy: "Alex",
      purpose: "sync every subscription into billing",
      run: { command: COMMAND },
    });
    expect(result).toHaveProperty("ask");
    const multi = kc.requestCredentialRun({
      credentials: CREDS,
      sessionId: SESSION,
      requestedBy: "Alex",
      purpose: "sync every subscription into billing",
      run: { command: COMMAND },
    });
    expect("error" in multi && multi.error).toContain("already pending");
  });

  test("after a restart cuts a run off, asking again tells the owners how far it got", async () => {
    addPair();
    const group = {
      id: "krg-test",
      members: [
        {
          service: "payments-prod",
          host: "api.payments.example.test",
          owner: "Alex",
        },
        {
          service: "billing-prod",
          host: "api.billing.example.test",
          owner: "Bea",
        },
      ],
    };
    for (const service of CREDS)
      kc.__mintGrantForTest({
        credentialId: kc.findCredential(service)!.id,
        sessionId: SESSION,
        requestedBy: "Alex",
        mode: "run",
        run: { command: COMMAND, group },
      });
    const claim = await kc.claimRunGrants({
      sessionId: SESSION,
      credentials: CREDS,
      command: COMMAND,
      runId: "kr-cut",
      deadline: Date.now() + 3_600_000,
    });
    if ("error" in claim) throw new Error(claim.error);
    await kc.saveRunProgress(
      "kr-cut",
      claim.claims.map(({ grant }, i) => ({
        grantId: grant.id,
        calls: 6000 + i,
      })),
    );

    // The server restarts: the store is loaded afresh.
    const restarted = join(scratch, "kc-restarted.json");
    copyFileSync(STORE, restarted);
    process.env.OPENSESSION_KEYCHAIN_STORE = restarted;
    const g = globalThis as any;
    g.__keychainCredentials.clear();
    g.__keychainGrants.clear();
    g.__keychainAsks.clear();
    await kc.ensureKeychainLoaded();
    // Boot finds no live script run for it, so the run was cut off.
    await kc.settleOrphanRunGrants(() => false);
    expect(
      kc
        .listGrants({ sessionId: SESSION })
        .map((gr) => [gr.status, gr.interrupted]),
    ).toEqual([
      ["used", true],
      ["used", true],
    ]);

    const client = await connect();
    const { call } = await askForRun(client, 2);
    for (const post of slackPosts) {
      expect(post.text).toContain("that run was cut off before it finished");
      expect(post.text).toContain("6,000 calls with payments-prod");
      expect(post.text).toContain("6,001 calls with billing-prod");
    }
    for (const a of kc.listKeychainAsks({ sessionId: SESSION }))
      if (a.status === "pending") kc.cancelCredentialAsk(a.id, SESSION);
    await call;
    rmSync(restarted, { force: true });
  });
});

describe("a login", () => {
  const PASSWORD = " correct horse battery staple ";

  function addLogin() {
    kc.addCredential({
      owner: "Alex",
      service: "acme-staging",
      kind: "login",
      loginUrl: "https://app.example.test/login#top",
      username: "qa@example.test",
      secret: PASSWORD,
    });
  }

  /** use_login writes into a temp dir, standing in for the session's
   *  workspace, through the same Sandbox-shaped exec a remote session uses. */
  async function connectWithWorkspace() {
    const written: Array<{ path: string; password: string }> = [];
    const removed: string[] = [];
    const exec = Object.assign(
      async (cmd: string[], opts?: { env?: Record<string, string> }) => {
        if (cmd[0] === "rm") removed.push(cmd[2]!);
        else
          written.push({
            path: opts!.env!.KEYCHAIN_LOGIN_FILE!,
            password: opts!.env!.KEYCHAIN_LOGIN_PASSWORD!,
          });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      { sandboxed: true, remote: true } as const,
    );
    const server = createKeychainMcpServer({
      sessionId: SESSION,
      user: "Alex",
      loginTarget: async () => ({ kind: "sandbox", exec }),
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, written, removed };
  }

  async function askForLogin(client: Client) {
    const call = client.callTool({
      name: "request_credential",
      arguments: {
        credential: "acme-staging",
        purpose: "sign in to check the editor on staging",
      },
    });
    for (let i = 0; i < 100 && !kc.listKeychainAsks().length; i++)
      await Bun.sleep(5);
    return { call, ask: pendingAsk() };
  }

  test("stores the sign-in page and username as metadata, never the password", () => {
    addLogin();
    const meta = kc.findCredential("acme-staging")!;
    expect(meta).toMatchObject({
      kind: "login",
      host: "app.example.test",
      loginUrl: "https://app.example.test/login",
      username: "qa@example.test",
    });
    expect(JSON.stringify(kc.listCredentials())).not.toContain("horse");
    expect(() =>
      kc.addCredential({
        owner: "Alex",
        service: "plain-http",
        kind: "login",
        loginUrl: "http://app.example.test/login",
        username: "qa",
        secret: "pw",
      }),
    ).toThrow(/https/);
    expect(() =>
      kc.addCredential({
        owner: "Alex",
        service: "with-limits",
        kind: "login",
        loginUrl: "https://app.example.test/login",
        username: "qa",
        secret: "pw",
        allowedMethods: ["GET"],
      }),
    ).toThrow(/sign-in page/);
    expect(() =>
      kc.addCredential({
        owner: "Alex",
        service: "no-user",
        kind: "login",
        loginUrl: "https://app.example.test/login",
        secret: "pw",
      }),
    ).toThrow(/username/);
  });

  test("tells the owner the agent will see the password, and offers only release or decline", async () => {
    addLogin();
    const { client } = await connectWithWorkspace();
    const { call, ask } = await askForLogin(client);
    expect(ask.requestedMode).toBe("release");
    await deliver(ask.humanAskId!);
    const transport = humanAsks.getAsk(ask.humanAskId!)!;
    expect(transport.options).toEqual(["Release password", "Decline"]);
    const dm = slackPosts.map((p) => p.text).join("\n");
    expect(dm).toContain("will see the password");
    expect(dm).toContain("qa@example.test");
    expect(dm).not.toContain("horse");

    for (const mode of ["once", "standing", "run"] as const)
      expect(kc.answerKeychainAsk(ask.id, mode, "Alex")).toHaveProperty(
        "error",
      );
    kc.answerKeychainAsk(ask.id, "decline", "Alex");
    await call;
    expect(kc.listGrants()).toHaveLength(0);
  });

  test("a release puts the password in a workspace file once, and never in the transcript", async () => {
    addLogin();
    const { client, written } = await connectWithWorkspace();
    const { call, ask } = await askForLogin(client);
    expect(kc.answerKeychainAsk(ask.id, "release", "Alex")).toEqual({
      ok: true,
      status: "approved",
    });
    const instructions = textOf(await call);
    expect(instructions).toContain("use_login");
    expect(instructions).not.toContain("horse");

    const released = textOf(
      await client.callTool({
        name: "use_login",
        arguments: { credential: "acme-staging" },
      }),
    );
    expect(released).not.toContain("horse");
    const body = JSON.parse(released);
    expect(body).toMatchObject({
      loginUrl: "https://app.example.test/login",
      username: "qa@example.test",
    });
    expect(written).toEqual([{ path: body.passwordFile, password: PASSWORD }]);
    expect(body.passwordFile).toContain("/logins/");

    const again = textOf(
      await client.callTool({
        name: "use_login",
        arguments: { credential: "acme-staging" },
      }),
    );
    expect(again).toContain("no approved release");
    expect(written).toHaveLength(1);
  });

  test("a login is never usable through call_credential, and an API key is never released", async () => {
    addLogin();
    const { client, written } = await connectWithWorkspace();
    const { call, ask } = await askForLogin(client);
    kc.answerKeychainAsk(ask.id, "release", "Alex");
    await call;
    const viaBroker = textOf(
      await client.callTool({
        name: "call_credential",
        arguments: { credential: "acme-staging", method: "GET", path: "/" },
      }),
    );
    expect(viaBroker).not.toContain("horse");
    expect(viaBroker).toContain("no live grant");

    const apiKey = textOf(
      await client.callTool({
        name: "use_login",
        arguments: { credential: "acme-prod" },
      }),
    );
    expect(apiKey).toContain("never released");
    expect(apiKey).not.toContain("sk-test-secret");
    expect(written).toHaveLength(0);
  });

  test("a login can't be asked for as a scripted run", async () => {
    addLogin();
    const { client } = await connectWithWorkspace();
    const result = textOf(
      await client.callTool({
        name: "request_credential",
        arguments: {
          credential: "acme-staging",
          purpose: "sign in from a script",
          run: { command: "bun sign-in.ts" },
        },
      }),
    );
    expect(result).toContain("can't be used by a scripted run");
    expect(kc.listKeychainAsks()).toHaveLength(0);
  });

  test("a failed write leaves the approval unused", async () => {
    addLogin();
    const failing = Object.assign(
      async () => ({ exitCode: 1, stdout: "", stderr: "disk full" }),
      { sandboxed: true, remote: true } as const,
    );
    const server = createKeychainMcpServer({
      sessionId: SESSION,
      user: "Alex",
      loginTarget: async () => ({ kind: "sandbox", exec: failing }),
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    const { call, ask } = await askForLogin(client);
    kc.answerKeychainAsk(ask.id, "release", "Alex");
    await call;
    const result = textOf(
      await client.callTool({
        name: "use_login",
        arguments: { credential: "acme-staging" },
      }),
    );
    expect(result).toContain("still unused");
    expect(kc.listGrants({ sessionId: SESSION })[0]!.status).toBe("active");
  });
});

describe("the retired broker URL", () => {
  test("explains the supported paths to any caller instead of asking for sign-in", async () => {
    const res = await route("/api/keychain/broker/kg-123/v1/items", null);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toContain("retired");
    expect(body.error).toContain("call_credential");
    expect(body.error).toContain("run_with_credential");
  });
});

describe("what each person sees of the keychain", () => {
  test("grant tokens only reach the owner and the requester", () => {
    const cred = kc.findCredential("acme-prod")!;
    const grant = kc.__mintGrantForTest({
      credentialId: cred.id,
      sessionId: SESSION,
      requestedBy: "Sam",
      mode: "standing",
    });
    const owner = kc.keychainViewFor("Alex");
    expect(owner.credentials[0]!.mine).toBe(true);
    expect(owner.grants.map((g) => g.id)).toEqual([grant.id]);
    expect(kc.keychainViewFor("Sam").grants.map((g) => g.id)).toEqual([
      grant.id,
    ]);
    const bystander = kc.keychainViewFor("Bob");
    expect(bystander.credentials).toHaveLength(1);
    expect(bystander.credentials[0]!.mine).toBe(false);
    expect(bystander.grants).toHaveLength(0);
    expect(kc.keychainViewFor("").grants).toHaveLength(0);
    expect(JSON.stringify(bystander)).not.toContain("sk-test-secret");
  });
});

describe("cancellation through the run-rpc dispatcher", () => {
  test("a caller that gives up releases the ask, so a late approval reaches the session", async () => {
    const token = `tok-${crypto.randomUUID()}`;
    runRpc.registerRunToken(token, { sessionId: SESSION, user: "Alex" });
    runRpc.registerInteractiveMcpBuilder((sessionId, user) => ({
      "opensession-keychain": createKeychainMcpServer({
        sessionId,
        user: user || "Alex",
      }),
    }));
    try {
      const abort = new AbortController();
      const d = await runRpc.dispatchRunRpc(
        "/mcp/call",
        {
          token,
          server: "opensession-keychain",
          tool: "request_credential",
          args: {
            credential: "acme-prod",
            purpose: "read the latest invoice",
            mode: "standing",
          },
        },
        abort.signal,
      );
      if (d.kind !== "call") throw new Error("expected a tool call");
      for (let i = 0; i < 100 && !kc.listKeychainAsks().length; i++)
        await Bun.sleep(5);
      const ask = pendingAsk();
      await deliver(ask.humanAskId!);
      expect(humanAsks.getAsk(ask.humanAskId!)?.mode).toBe("block");

      abort.abort();
      expect((await d.done).error).toBeTruthy();
      expect(humanAsks.getAsk(ask.humanAskId!)?.mode).toBe("async");
    } finally {
      runRpc.unregisterRunToken(token);
    }
  });
});
