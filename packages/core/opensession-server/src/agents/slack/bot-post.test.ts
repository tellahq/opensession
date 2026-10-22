import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __setIdentitiesForTest } from "../../server/shared/user-mappings";
import { postAsSlackBot, withSenderTag } from "./bot-post";

const originalFetch = globalThis.fetch;
const originalToken = process.env.SLACK_BOT_TOKEN;
const channel = { id: "C1", name: "engineering" };

interface Call {
  method: string;
  auth: string;
  body: any;
}

function mockSlack(answer: (method: string, calls: Call[]) => object): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = url.pathname.replace("/api/", "");
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      auth: headers.get("Authorization") || "",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(answer(method, calls));
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = originalToken;
});

describe("postAsSlackBot", () => {
  test("posts with the bot token, never a person's", async () => {
    const calls = mockSlack((method) =>
      method === "chat.postMessage"
        ? { ok: true, ts: "1.2" }
        : { ok: true, permalink: "https://acme.slack.com/archives/C1/p12" },
    );
    const posted = await postAsSlackBot(channel, "Shipped", [], {
      sender: undefined,
      sessionUrl: undefined,
    });
    expect(posted).toEqual({
      ts: "1.2",
      permalink: "https://acme.slack.com/archives/C1/p12",
    });
    expect(calls.map((call) => call.method)).toEqual([
      "chat.postMessage",
      "chat.getPermalink",
    ]);
    expect(calls.every((call) => !call.auth.includes("xoxp"))).toBe(true);
  });

  test("replies in a thread when given one", async () => {
    const calls = mockSlack((method) =>
      method === "chat.postMessage" ? { ok: true, ts: "1.4" } : { ok: true },
    );
    await postAsSlackBot(channel, "Shipped", [], {
      sender: undefined,
      sessionUrl: undefined,
      threadTs: "1.1",
    });
    expect(calls[0]).toMatchObject({
      method: "chat.postMessage",
      body: { channel: "C1", thread_ts: "1.1" },
    });
  });

  test("joins a public channel the bot isn't in, then posts", async () => {
    let posts = 0;
    const calls = mockSlack((method) => {
      if (method === "chat.postMessage")
        return ++posts === 1
          ? { ok: false, error: "not_in_channel" }
          : { ok: true, ts: "1.3" };
      return { ok: true };
    });
    const posted = await postAsSlackBot(channel, "Shipped", [], {
      sender: undefined,
      sessionUrl: undefined,
    });
    expect(posted.ts).toBe("1.3");
    expect(calls.map((call) => call.method)).toEqual([
      "chat.postMessage",
      "conversations.join",
      "chat.postMessage",
      "chat.getPermalink",
    ]);
  });

  test("asks for an invite when the bot can't join", async () => {
    mockSlack((method) =>
      method === "conversations.join"
        ? { ok: false, error: "method_not_supported_for_channel_type" }
        : { ok: false, error: "not_in_channel" },
    );
    await expect(
      postAsSlackBot(channel, "Shipped", [], {
        sender: undefined,
        sessionUrl: undefined,
      }),
    ).rejects.toThrow(
      "Invite the bot to #engineering in Slack, then send again",
    );
  });

  test("refuses without a bot token", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const calls = mockSlack(() => ({ ok: true }));
    await expect(
      postAsSlackBot(channel, "Shipped", [], {
        sender: undefined,
        sessionUrl: undefined,
      }),
    ).rejects.toThrow("Slack isn't set up on this server yet");
    expect(calls).toEqual([]);
  });

  test("tags the person who pressed Send", async () => {
    const restore = __setIdentitiesForTest([
      {
        name: "Alice Example",
        email: "alice@example.com",
        slackId: "U0ALICE01",
        github: "alice",
      },
    ]);
    try {
      const calls = mockSlack(() => ({ ok: true, ts: "1.4" }));
      await postAsSlackBot(channel, "Shipped", [], {
        sender: "alice",
        sessionUrl: "https://os.example.test/session/os-1",
      });
      expect(calls[0]?.body?.text).toBe(
        "Shipped\n_via <@U0ALICE01> in <https://os.example.test/session/os-1|session>_",
      );
    } finally {
      restore();
    }
  });
});

describe("withSenderTag", () => {
  test("falls back to the escaped name for someone outside Slack", () => {
    expect(withSenderTag("Shipped", "<mallory>")).toBe(
      "Shipped\n_via &lt;mallory&gt;_",
    );
  });

  test("stands alone under an image-only post", () => {
    expect(withSenderTag("", "mallory")).toBe("_via mallory_");
  });

  test("leaves the message alone without a sender or session", () => {
    expect(withSenderTag("Shipped", undefined)).toBe("Shipped");
  });

  test("links the session even without a sender", () => {
    expect(
      withSenderTag("Shipped", undefined, "https://os.example.test/session/a"),
    ).toBe("Shipped\n_via <https://os.example.test/session/a|session>_");
  });

  test("drops a session URL that would break Slack link markup", () => {
    expect(
      withSenderTag("Shipped", "mallory", "https://x.test/a|<!channel>"),
    ).toBe("Shipped\n_via mallory_");
  });
});
