import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  findSlackChannel,
  forgetSlackChannelsForUser,
  isSlackChannelId,
  mergeSlackChannels,
  resolveSlackChannel,
  slackChannelsForUser,
} from "./channel-directory";

const originalFetch = globalThis.fetch;
const calls: URL[] = [];

function respond(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function mockSlack(handler: (url: URL) => unknown): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url,
    );
    calls.push(url);
    return respond(handler(url));
  }) as typeof fetch;
}

beforeEach(() => {
  calls.length = 0;
  forgetSlackChannelsForUser();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  forgetSlackChannelsForUser();
});

describe("slackChannelsForUser", () => {
  test("pages users.conversations with the caller's token and sorts by name", async () => {
    mockSlack((url) => {
      expect(url.pathname).toBe("/api/users.conversations");
      expect(url.searchParams.get("types")).toBe(
        "public_channel,private_channel",
      );
      return url.searchParams.get("cursor")
        ? {
            ok: true,
            channels: [{ id: "C3", name: "alpha" }],
            response_metadata: { next_cursor: "" },
          }
        : {
            ok: true,
            channels: [
              { id: "C1", name: "zeta" },
              { id: "C2", name: "mid" },
            ],
            response_metadata: { next_cursor: "page-2" },
          };
    });
    const channels = await slackChannelsForUser("acme-dev", "xoxp-token");
    expect(channels).toEqual([
      { id: "C3", name: "alpha" },
      { id: "C2", name: "mid" },
      { id: "C1", name: "zeta" },
    ]);
    expect(calls).toHaveLength(2);
  });

  test("caches per caller and coalesces a concurrent load", async () => {
    mockSlack(() => ({ ok: true, channels: [{ id: "C1", name: "os" }] }));
    const [first, second] = await Promise.all([
      slackChannelsForUser("acme-dev", "xoxp-token"),
      slackChannelsForUser("acme-dev", "xoxp-token"),
    ]);
    expect(first).toEqual(second);
    await slackChannelsForUser("acme-dev", "xoxp-token");
    expect(calls).toHaveLength(1);
    // A reconnect hands out a new token; the old list must not answer for it.
    await slackChannelsForUser("acme-dev", "xoxp-newer");
    expect(calls).toHaveLength(2);
  });

  test("treats a grant without channels:read as an empty directory", async () => {
    mockSlack(() => ({ ok: false, error: "missing_scope" }));
    expect(await slackChannelsForUser("acme-dev", "xoxp-old")).toEqual([]);
  });
});

describe("mergeSlackChannels", () => {
  test("keeps configured channels first and dedupes by id", () => {
    expect(
      mergeSlackChannels(
        [
          { id: "C9", name: "os" },
          { id: "C2", name: "engineering" },
        ],
        [
          { id: "C1", name: "design" },
          { id: "C2", name: "eng" },
          { id: "C3", name: "random" },
        ],
      ),
    ).toEqual([
      { id: "C9", name: "os" },
      { id: "C2", name: "engineering" },
      { id: "C1", name: "design" },
      { id: "C3", name: "random" },
    ]);
  });
});

describe("resolveSlackChannel", () => {
  const configured = [{ id: "C9", name: "os" }];

  test("resolves configured channels by id or #name without a grant", async () => {
    expect(await resolveSlackChannel("C9", configured)).toEqual(configured[0]);
    expect(await resolveSlackChannel("#OS", configured)).toEqual(configured[0]);
    expect(await resolveSlackChannel("C1", configured)).toBeUndefined();
    expect(findSlackChannel(configured, " #os ")).toEqual(configured[0]);
  });

  test("resolves any channel in the caller's directory", async () => {
    mockSlack(() => ({
      ok: true,
      channels: [{ id: "C1", name: "proj-launch" }],
    }));
    expect(
      await resolveSlackChannel("proj-launch", configured, {
        caller: "acme-dev",
        token: "xoxp-token",
      }),
    ).toEqual({ id: "C1", name: "proj-launch" });
  });

  test("confirms an unlisted id with conversations.info and rejects garbage", async () => {
    mockSlack((url) =>
      url.pathname === "/api/conversations.info"
        ? { ok: true, channel: { id: "C7ABCDEF", name: "shared-ext" } }
        : { ok: true, channels: [] },
    );
    const auth = { caller: "acme-dev", token: "xoxp-token" };
    expect(await resolveSlackChannel("C7ABCDEF", configured, auth)).toEqual({
      id: "C7ABCDEF",
      name: "shared-ext",
    });
    expect(
      await resolveSlackChannel("not a channel", configured, auth),
    ).toBeUndefined();
    expect(isSlackChannelId("C7ABCDEF")).toBe(true);
    expect(isSlackChannelId("../etc")).toBe(false);
  });
});
