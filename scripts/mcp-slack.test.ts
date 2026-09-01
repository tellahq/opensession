import { describe, expect, test } from "bun:test";
import { buildSlackMessageBody } from "./mcp-slack";

describe("buildSlackMessageBody", () => {
  test("uses Slack defaults when unfurl options are omitted", () => {
    expect(buildSlackMessageBody("C123", "hello")).toEqual({
      channel: "C123",
      text: "hello",
    });
  });

  test("passes explicit unfurl options and thread timestamp", () => {
    expect(
      buildSlackMessageBody(
        "C123",
        "hello",
        { unfurl_links: false, unfurl_media: false },
        "123.456",
      ),
    ).toEqual({
      channel: "C123",
      text: "hello",
      thread_ts: "123.456",
      unfurl_links: false,
      unfurl_media: false,
    });
  });
});
