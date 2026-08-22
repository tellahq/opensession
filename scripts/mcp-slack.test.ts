import { describe, expect, test } from "bun:test";
import { attributedSlackText, buildSlackMessageBody, tools } from "./mcp-slack";

describe("buildSlackMessageBody", () => {
  test("uses Slack defaults when unfurl options are omitted", () => {
    expect(buildSlackMessageBody("C123", "hello")).toEqual({
      channel: "C123",
      text: "hello",
    });
  });

  test("passes explicit unfurl options and thread timestamp", () => {
    expect(buildSlackMessageBody(
      "C123",
      "hello",
      { unfurl_links: false, unfurl_media: false },
      "123.456",
    )).toEqual({
      channel: "C123",
      text: "hello",
      thread_ts: "123.456",
      unfurl_links: false,
      unfurl_media: false,
    });
  });
});


describe("attributedSlackText", () => {
  test("keeps personal Slack posts under the connected person's account", () => {
    expect(attributedSlackText("Shipped it", "Michiel Westerbeek", true)).toBe(
      "Shipped it",
    );
  });

  test("names the requester when Slack falls back to the bot", () => {
    expect(attributedSlackText("Shipped it", "Michiel Westerbeek", false)).toBe(
      "Shipped it\n\nSent by Michiel Westerbeek via Open Session",
    );
  });
});

describe("Slack MCP tools", () => {
  test("supports attributed local file uploads", () => {
    expect(tools.map((tool) => tool.name)).toContain("slack_post_files");
  });
});
