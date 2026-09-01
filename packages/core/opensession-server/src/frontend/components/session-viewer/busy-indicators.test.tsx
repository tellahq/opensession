import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import { LiveTurnStore } from "../../lib/live-turn-store";
import { BusyInline } from "./busy-indicators";

describe("BusyInline", () => {
  test("centers the shimmer label with its dot and elapsed time", () => {
    const html = renderToStaticMarkup(
      <BusyInline
        since={Date.now() - 12_000}
        stoppingSince={null}
        liveTurnStore={new LiveTurnStore()}
      />,
    );

    // TextShimmer is an inline block. Its status wrapper must shrink to that
    // line box instead of inheriting the taller transcript line box.
    expect(html).toContain(
      '<span role="status" aria-live="polite" style="display:inline-flex">',
    );
    expect(html).toContain("Still working");
  });
});
