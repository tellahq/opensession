import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import { LiveTurnStore } from "../../lib/live-turn-store";
import { BusyInline, TranscriptSyncing } from "./busy-indicators";

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
      '<span role="status" aria-live="polite" class="inline-flex">',
    );
    expect(html).toContain("Still working");
  });

  test("names a trailing thought, with the elapsed time, at the end", () => {
    const store = new LiveTurnStore();
    const release = store.claimTrailingThought();
    const html = renderToStaticMarkup(
      <BusyInline
        since={Date.now() - 15 * 60_000}
        stoppingSince={null}
        liveTurnStore={store}
      />,
    );
    expect(html).toMatch(/>Thinking<\/span>/);
    expect(html).not.toContain("Still working");
    expect(html).toContain("· 15m");
    release();
  });
});

describe("TranscriptSyncing", () => {
  test("floats a bare ring over the bottom edge, announced but not a row", () => {
    const html = renderToStaticMarkup(<TranscriptSyncing />);

    // A sibling overlay of the scroller: absolute, centred on the reading
    // column, and never a hit target. A transcript row here would read as
    // part of the conversation and move the rows under it.
    expect(html).toContain('role="status"');
    expect(html).toContain("pointer-events-none absolute left-1/2");
    // Clear of the composer's overlap and any action band, not the bare edge.
    expect(html).toContain(
      "bottom-[calc(var(--session-under,0px)+var(--suggestions-under,0px)+8px)]",
    );
    expect(html).toContain("animate-spin");
    expect(html).toContain("Checking for new messages");
    expect(html).not.toContain("Loading transcript");
  });
});
