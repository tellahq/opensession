import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "./TranscriptBlocks.test-setup";

const { ClampedBody, MessageBubble } = await import("./MessageBubble");

describe("images a person sends", () => {
  const entry = (images: string[]) => ({
    id: "u1",
    type: "user" as const,
    timestamp: "2026-09-14T00:00:00.000Z",
    content: "cool",
    images,
  });

  test("sit above the bubble as square tiles when there are several", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        entry={entry([
          "https://example.test/a.png",
          "https://example.test/b.png",
        ])}
        sessionId="session"
      />,
    );
    expect(html.indexOf("example.test/a.png")).toBeLessThan(
      html.indexOf("cool"),
    );
    expect(html.match(/size-24/g)).toHaveLength(2);
  });

  test("keep one picture at its own shape, still above the words", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        entry={entry(["https://example.test/a.png"])}
        sessionId="session"
      />,
    );
    expect(html.indexOf("example.test/a.png")).toBeLessThan(
      html.indexOf("cool"),
    );
    expect(html).not.toContain("size-24");
  });
});

describe("message expander threshold", () => {
  test.each([24_000, 24_001, 29_999])(
    "shows all %i characters without an expander",
    (length) => {
      const content = `${"a".repeat(length - 9)} tail-end`;
      const html = renderToStaticMarkup(
        <ClampedBody content={content} className="" />,
      );
      expect(html).toContain(content);
      expect(html).not.toContain("Show full message");
    },
  );

  test.each([30_000, 36_000])(
    "keeps the 24,000-character preview for %i characters",
    (length) => {
      const content = `${"a".repeat(length - 9)} tail-end`;
      const html = renderToStaticMarkup(
        <ClampedBody content={content} className="" />,
      );
      expect(html).toContain("a".repeat(24_000));
      expect(html).not.toContain("tail-end");
      expect(html).toContain("Show full message");
    },
  );

  test("shows near-limit messages in full even with an earlier line break", () => {
    const content = `${"a".repeat(16_000)}\n${"b".repeat(12_000)}`;
    const html = renderToStaticMarkup(
      <ClampedBody content={content} className="" />,
    );
    expect(html).toContain("b".repeat(12_000));
    expect(html).not.toContain("Show full message");
  });

  test("keeps hydration available when only a wire preview is present", () => {
    const content = "a".repeat(24_000);
    const html = renderToStaticMarkup(
      <ClampedBody
        content={content}
        className=""
        sessionId="session"
        entry={{
          id: "entry",
          type: "assistant",
          timestamp: "2026-09-14T00:00:00.000Z",
          content,
          contentClamped: true,
          contentLength: 28_000,
        }}
      />,
    );
    expect(html).toContain("Show full message");
  });
});
