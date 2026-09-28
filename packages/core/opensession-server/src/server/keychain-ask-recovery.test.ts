/**
 * A keychain ask must stay recoverable when the agent's request_credential
 * call gives up before the owner answers: the approval still mints a grant the
 * session can list, a repeat request re-surfaces the pending ask instead of
 * refusing, and the session can withdraw its own ask.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
      : null,
}));

// Slack transport: record what the owner would see instead of calling Slack.
const slackPosts: Array<{ channel: string; text: string; threadTs?: string }> =
  [];
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
    return { ok: true };
  },
  updateSlackBlocks: async () => ({ ok: true }),
}));

// Delivery normally runs as a durable session-kernel effect; deliver inline.
const realKernel = await import("./session-kernel");
mock.module("./session-kernel", () => ({
  ...realKernel,
  sessionKernel: () => ({ enqueueEffect: async () => {} }),
}));

const humanAsks = await import("./human-asks");
const kc = await import("./keychain");
const { createKeychainMcpServer } =
  await import("../agents/slack/keychain-tools");

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
        arguments: { credential: "acme-prod", purpose: "read invoices" },
      }),
    );
    expect(again).toContain(grant.id);
    expect(kc.listKeychainAsks({ sessionId: SESSION })).toHaveLength(1);
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
