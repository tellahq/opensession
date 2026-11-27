import { describe, expect, test } from "bun:test";
import { defaultSlackChannel } from "./slack-channels";

describe("Slack channel selection", () => {
  test("prefers os regardless of configured order or case", () => {
    expect(
      defaultSlackChannel([
        { id: "C1", name: "product" },
        { id: "C2", name: "Engineering" },
        { id: "C3", name: "OS" },
      ]),
    ).toBe("C3");
  });

  test("falls back to engineering when os is not configured", () => {
    expect(
      defaultSlackChannel([
        { id: "C1", name: "product" },
        { id: "C2", name: "Engineering" },
      ]),
    ).toBe("C2");
  });

  test("falls back to the first configured channel", () => {
    expect(
      defaultSlackChannel([
        { id: "C1", name: "product" },
        { id: "C2", name: "general" },
      ]),
    ).toBe("C1");
    expect(defaultSlackChannel([])).toBeUndefined();
  });
});

describe("Slack files in the Channels place", () => {
  test("proxies only Slack's own file host over https", async () => {
    const { slackFileUrl } = await import("./slack-channels");
    expect(slackFileUrl("https://files.slack.com/files-tmb/T1/a.png")).toBe(
      "https://files.slack.com/files-tmb/T1/a.png",
    );
    expect(slackFileUrl("http://files.slack.com/a.png")).toBeUndefined();
    expect(slackFileUrl("https://example.test/a.png")).toBeUndefined();
    expect(
      slackFileUrl("https://files.slack.com.example.test/a"),
    ).toBeUndefined();
    expect(slackFileUrl(null)).toBeUndefined();
  });

  test("shows images through the proxy and other files as links", async () => {
    const { messageFiles } = await import("./slack-channels");
    const files = messageFiles([
      {
        name: "shot.png",
        mimetype: "image/png",
        thumb_720: "https://files.slack.com/t/shot.png",
        thumb_720_w: 720,
        thumb_720_h: 400,
        permalink: "https://acme.slack.com/files/1",
      },
      { title: "notes.pdf", mimetype: "application/pdf" },
      { mode: "tombstone" },
    ]);
    expect(files).toEqual([
      {
        name: "shot.png",
        thumb: `/api/slack/file?url=${encodeURIComponent("https://files.slack.com/t/shot.png")}`,
        width: 720,
        height: 400,
        permalink: "https://acme.slack.com/files/1",
      },
      { name: "notes.pdf" },
    ]);
  });
});
