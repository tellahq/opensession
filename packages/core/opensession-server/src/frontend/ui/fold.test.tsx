import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Fold } from "./fold";

describe("Fold", () => {
  test("an open fold renders a plain block, without the open animation", () => {
    const html = renderToStaticMarkup(
      <Fold open className="outer" panelClassName="inner">
        <p>Work</p>
      </Fold>,
    );
    expect(html).toMatch(
      /^<div class="min-w-0 outer"><div class="[^"]*inner">/,
    );
    expect(html).not.toContain("data-open");
    expect(html).not.toContain("data-closed");
    expect(html).toContain("<p>Work</p>");
  });

  test("a closed fold is Base UI's collapsible and renders no content", () => {
    const html = renderToStaticMarkup(
      <Fold open={false}>
        <p>Work</p>
      </Fold>,
    );
    expect(html).not.toContain("Work");
  });
});
