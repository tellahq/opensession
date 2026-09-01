import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TextShimmer } from "./text-shimmer";

describe("TextShimmer", () => {
  test("counter-translates an aria-hidden copy without animating paint", () => {
    const markup = renderToStaticMarkup(
      <TextShimmer className="[--text-shimmer-highlight:var(--text-dim)]">
        Thinking
      </TextShimmer>,
    );

    expect(markup.match(/Thinking/g)).toHaveLength(2);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("animation-name:text-shimmer-window");
    expect(markup).toContain("animation-name:text-shimmer-copy");
    expect(markup).not.toContain("background-position");
  });
});
