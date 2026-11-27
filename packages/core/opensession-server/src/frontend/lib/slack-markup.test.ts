import { expect, test } from "bun:test";
import { slackBlocks, slackInlines } from "./slack-markup";

test("reads Slack emphasis, code and links", () => {
  expect(slackInlines("a *bold _both_* and ~gone~ `x*y*`")).toEqual([
    { type: "text", text: "a " },
    {
      type: "bold",
      children: [
        { type: "text", text: "bold " },
        { type: "italic", children: [{ type: "text", text: "both" }] },
      ],
    },
    { type: "text", text: " and " },
    { type: "strike", children: [{ type: "text", text: "gone" }] },
    { type: "text", text: " " },
    { type: "code", text: "x*y*" },
  ]);
  expect(slackInlines("2*3*4 stays")).toEqual([
    { type: "text", text: "2*3*4 stays" },
  ]);
  expect(slackInlines("see [docs](https://example.test) [[@Ada]]")).toEqual([
    { type: "text", text: "see " },
    { type: "link", href: "https://example.test", label: "docs" },
    { type: "text", text: " " },
    { type: "tag", label: "@Ada" },
  ]);
});

test("splits quotes and code blocks out of paragraphs", () => {
  expect(
    slackBlocks("hi\n> quoted\n> more\nafter\n```\nconst a = 1;\n```"),
  ).toEqual([
    { type: "paragraph", inlines: [{ type: "text", text: "hi" }] },
    { type: "quote", inlines: [{ type: "text", text: "quoted\nmore" }] },
    { type: "paragraph", inlines: [{ type: "text", text: "after" }] },
    { type: "code", text: "const a = 1;" },
  ]);
});
