import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import { LiveTurnStore } from "../../lib/live-turn-store";
import { BusyInline, TranscriptSyncing } from "./busy-indicators";

describe("BusyInline", () => {
  // The engine's phase reaches the row through useSyncExternalStore, which a
  // static render reads as no phase; busy-activity.test.ts covers the words.
  test("is the dot and the elapsed time, the phase only for screen readers", () => {
    const html = renderToStaticMarkup(
      <BusyInline
        since={Date.now() - 24_000}
        stoppingSince={null}
        liveTurnStore={new LiveTurnStore()}
      />,
    );
    expect(html).toMatch(
      /<span role="status" aria-live="polite" class="[^"]*"><span class="sr-only">Working<\/span><\/span>/,
    );
    expect(html).not.toContain("data-text-shimmer");
    expect(html).toMatch(/>24s<\/span>/);
  });

  test("counts from the first second", () => {
    const html = renderToStaticMarkup(
      <BusyInline
        since={Date.now()}
        stoppingSince={null}
        liveTurnStore={new LiveTurnStore()}
      />,
    );
    expect(html).toMatch(/>0s<\/span>/);
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
    expect(html).toContain("spinner__styles.ring");
    expect(html).toContain("Checking for new messages");
    expect(html).not.toContain("Loading transcript");
  });
});
