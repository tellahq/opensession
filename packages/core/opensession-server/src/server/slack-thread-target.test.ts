import { afterEach, describe, expect, test } from "bun:test";
import {
  SLACK_THREAD_TARGET,
  sessionSlackThread,
  slackThreadOption,
  slackThreadReceipt,
  slackThreadTarget,
} from "./slack-thread-target";
import { slackChannelsPayload } from "./routes/slack-channels";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const origin = {
  sessionKey: "C0ACME01-1.1",
  channel: "C0ACME01",
  threadTs: "1.1",
  messageTs: "1.1",
};

describe("sessionSlackThread", () => {
  test("is the thread a Slack-started session came from", () => {
    expect(sessionSlackThread({ slackOrigin: origin })).toEqual({
      channel: "C0ACME01",
      threadTs: "1.1",
    });
    expect(
      sessionSlackThread({
        slackThread: { channel: "C0ACME02", threadTs: "2.2" },
      }),
    ).toEqual({ channel: "C0ACME02", threadTs: "2.2" });
  });

  test("is absent for sessions not started from Slack", () => {
    expect(sessionSlackThread({})).toBeUndefined();
    expect(sessionSlackThread(undefined)).toBeUndefined();
    expect(
      sessionSlackThread({
        slackThread: { channel: "opensession", threadTs: "1.1" },
      }),
    ).toBeUndefined();
  });
});

describe("slackThreadTarget", () => {
  test("names the thread after a known channel without asking Slack", async () => {
    globalThis.fetch = (async () => {
      throw new Error("unexpected Slack call");
    }) as unknown as typeof fetch;
    const target = await slackThreadTarget({ slackOrigin: origin }, [
      { id: "C0ACME01", name: "support" },
    ]);
    expect(target).toEqual({
      channel: { id: "C0ACME01", name: "support" },
      threadTs: "1.1",
    });
    expect(slackThreadOption(target!)).toEqual({
      id: SLACK_THREAD_TARGET,
      name: "support thread",
    });
    expect(slackThreadReceipt(target!)).toEqual({
      id: "C0ACME01",
      name: "support thread",
    });
  });

  test("looks an unknown channel's name up", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        ok: true,
        channel: { name: "help" },
      })) as unknown as typeof fetch;
    const target = await slackThreadTarget({ slackOrigin: origin });
    expect(target?.channel).toEqual({ id: "C0ACME01", name: "help" });
  });
});

describe("slackChannelsPayload", () => {
  test("lists the session's thread first and preselects it", async () => {
    const payload = await slackChannelsPayload(
      { authUser: null },
      {
        thread: {
          channel: { id: "C0ACME01", name: "support" },
          threadTs: "1.1",
        },
      },
    );
    expect(payload.channels[0]).toEqual({
      id: SLACK_THREAD_TARGET,
      name: "support thread",
    });
    expect(payload.defaultChannel).toBe(SLACK_THREAD_TARGET);
  });
});
