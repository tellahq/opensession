import { describe, expect, test } from "bun:test";
import {
  hasLayoutBlocks,
  richAttachments,
  richBlocks,
  safeUrl,
} from "./rich-content";

const render = async (markup: string) => `<${markup}>`;

describe("app message content in the Channels place", () => {
  test("keeps only http(s) links", () => {
    expect(safeUrl("https://example.test/a")).toBe("https://example.test/a");
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("slack://open")).toBeUndefined();
    expect(safeUrl(42)).toBeUndefined();
  });

  test("text from rich_text alone is not an app layout", () => {
    expect(hasLayoutBlocks([{ type: "rich_text" }])).toBe(false);
    expect(hasLayoutBlocks([{ type: "rich_text" }, { type: "section" }])).toBe(
      true,
    );
    expect(hasLayoutBlocks(undefined)).toBe(false);
  });

  test("blocks render mrkdwn, keep plain text and drop what cannot show", async () => {
    const blocks = await richBlocks(
      [
        { type: "header", text: { type: "plain_text", text: "Deploy *done*" } },
        {
          type: "section",
          text: { type: "mrkdwn", text: "*ENG-1* fixed" },
          fields: [{ type: "mrkdwn", text: "a" }],
          accessory: {
            type: "image",
            image_url: "https://example.test/i.png",
            alt_text: "i",
          },
        },
        {
          type: "context",
          elements: [
            { type: "image", image_url: "data:x", alt_text: "bad" },
            { type: "mrkdwn", text: "by Ada" },
          ],
        },
        {
          type: "actions",
          elements: [
            { type: "button", text: { text: "Open" }, url: "https://x.test" },
            { type: "button", text: { text: "Ack" }, style: "primary" },
            { type: "static_select" },
          ],
        },
        { type: "input" },
        { type: "rich_text" },
      ],
      render,
    );
    expect(blocks).toEqual([
      { type: "header", text: "Deploy *done*" },
      {
        type: "section",
        text: "<*ENG-1* fixed>",
        fields: ["<a>"],
        image: { url: "https://example.test/i.png", alt: "i" },
      },
      { type: "context", items: [{ kind: "text", text: "<by Ada>" }] },
      {
        type: "actions",
        buttons: [
          { text: "Open", url: "https://x.test/" },
          { text: "Ack", primary: true },
        ],
      },
    ]);
  });

  test("an app card and a link preview", async () => {
    const [card, preview] = await richAttachments(
      [
        {
          color: "#36A64F",
          title: "#42 Fix upload",
          title_link: "https://example.test/pull/42",
          text: "Widens *accept*",
          fields: [{ title: "Checks", value: "12 passed", short: true }],
          footer: "<https://example.test|acme/web>",
          footer_icon: "https://example.test/f.png",
        },
        {
          service_name: "Acme blog",
          service_icon: "https://example.test/s.png",
          title: "Onboarding v2",
          title_link: "https://example.test/blog",
          image_url: "https://example.test/cover.png",
          image_width: 640,
          image_height: 336,
        },
        { fallback: "only a fallback" },
      ],
      render,
    );
    expect(card).toEqual({
      color: "36a64f",
      title: "#42 Fix upload",
      titleLink: "https://example.test/pull/42",
      text: "<Widens *accept*>",
      fields: [{ title: "Checks", value: "<12 passed>", short: true }],
      footer: "<<https://example.test|acme/web>>",
      footerIcon: "https://example.test/f.png",
    });
    expect(preview).toEqual({
      service: { name: "Acme blog", icon: "https://example.test/s.png" },
      title: "Onboarding v2",
      titleLink: "https://example.test/blog",
      image: {
        url: "https://example.test/cover.png",
        alt: "Onboarding v2",
        width: 640,
        height: 336,
      },
    });
  });

  test("an app card with its own blocks shows them instead of its text", async () => {
    const [card] = await richAttachments(
      [
        {
          text: "fallback",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
        },
      ],
      render,
    );
    expect(card).toEqual({ blocks: [{ type: "section", text: "<hi>" }] });
  });
});
