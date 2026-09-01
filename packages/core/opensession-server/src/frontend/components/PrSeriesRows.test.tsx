import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PrSeriesRows } from "./PrSeriesRows";
import type { SessionPrRef } from "../lib/pr-refs";

function ref(over: Partial<SessionPrRef> = {}): SessionPrRef {
  return {
    repo: "tella-fusion",
    branch: "feature",
    source: "discovered",
    number: 72,
    state: "OPEN",
    url: "https://github.com/tellahq/tella-fusion/pull/72",
    ...over,
  };
}

test("a session with one PR beyond its own branch renders one row", () => {
  const html = renderToStaticMarkup(
    <PrSeriesRows
      refs={[ref({ title: "Fix the uploader" })]}
      primaryRepo="tella-fusion"
    />,
  );

  expect(html.match(/data-tone="/g)).toHaveLength(1);
  expect(html).toContain("Fix the uploader");
  // Same repo as the session's own → the chip is the bare number.
  expect(html).toContain(">#72</span>");
  expect(html).toContain('aria-label="Review tella-fusion pull request #72"');
});

test("no refs renders nothing at all: no empty list chrome", () => {
  expect(renderToStaticMarkup(<PrSeriesRows refs={[]} />)).toBe("");
});

test("a four-PR series renders a row each, every one openable", () => {
  const refs = [
    ref({ repo: "tella-fusion", branch: "a", number: 5253, title: "Webapp" }),
    ref({
      repo: "tella-mac",
      branch: "b",
      number: 14,
      title: "Mac",
      url: "https://github.com/tellahq/tella-mac/pull/14",
      checks: { total: 3, passed: 1, failed: 0, pending: 2 },
    }),
    ref({
      repo: "tella-windows",
      branch: "c",
      number: 8,
      title: "Windows",
      url: "https://github.com/tellahq/tella-windows/pull/8",
      checks: { total: 2, passed: 1, failed: 1, pending: 0 },
    }),
    ref({
      repo: "tella-chrome",
      branch: "d",
      number: 3,
      title: "Extension",
      url: "https://github.com/tellahq/tella-chrome/pull/3",
      state: "MERGED",
    }),
  ];
  const html = renderToStaticMarkup(
    <PrSeriesRows refs={refs} primaryRepo="tella-fusion" />,
  );

  expect(html.match(/data-tone="/g)).toHaveLength(4);
  // Repo, number and title are all legible per row; the repo hint only shows
  // where it disambiguates.
  expect(html).toContain(">#5253</span>");
  expect(html).toContain(">tella-mac #14</span>");
  expect(html).toContain("Windows");
  // Each row states where that PR stands, checks included.
  expect(html).toContain("2 checks pending");
  expect(html).toContain("Checks failed");
  expect(html).toContain("Merged");
  // …and each one is openable both internally and on the provider.
  expect(
    html.match(/aria-label="Review [^"]+ pull request #\d+"/g),
  ).toHaveLength(4);
  expect(html).toContain(
    'href="https://github.com/tellahq/tella-windows/pull/8"',
  );
});

test("each row is toned by its own state, not the series'", () => {
  const html = renderToStaticMarkup(
    <PrSeriesRows
      refs={[
        ref({ repo: "tella-mac", branch: "a", number: 1 }),
        ref({
          repo: "tella-windows",
          branch: "b",
          number: 2,
          checks: { total: 1, passed: 0, failed: 1, pending: 0 },
        }),
      ]}
      primaryRepo="tella-fusion"
    />,
  );

  expect(html).toContain('data-tone="green"');
  expect(html).toContain('data-tone="red"');
  // …and the tone is on the row's own parts, not just the wrapper.
  expect(html).toContain("text-green");
  expect(html).toContain("text-red");
});

test("rows carry their state wash across the full surface", () => {
  const html = renderToStaticMarkup(
    <PrSeriesRows refs={[ref({ title: "Fix the uploader" })]} />,
  );

  expect(html).toContain("bg-green-soft");
  // The compact number chip remains one weight down from the primary row.
  expect(html).toContain("bg-control");
  // A PR with no URL still gets its row, minus the outbound link.
  const noUrl = renderToStaticMarkup(
    <PrSeriesRows refs={[ref({ url: undefined })]} />,
  );
  expect(noUrl).toContain('data-tone="');
  expect(noUrl).not.toContain('aria-label="Open ');
});

test("summary rows show every stacked PR in the workspace card", () => {
  const html = renderToStaticMarkup(
    <PrSeriesRows
      refs={[
        ref({ title: "Foundation" }),
        ref({
          repo: "tella-mac",
          branch: "stack/top",
          number: 73,
          title: "Desktop shell",
          url: "https://github.com/tellahq/tella-mac/pull/73",
          checks: { total: 1, passed: 0, failed: 1, pending: 0 },
        }),
      ]}
      primaryRepo="tella-fusion"
      variant="summary"
    />,
  );

  expect(html.match(/data-tone="/g)).toHaveLength(2);
  expect(html).toContain("#72");
  expect(html).toContain("Foundation");
  expect(html).toContain("tella-mac #73");
  expect(html).toContain("Desktop shell");
  expect(html).toContain("Checks failed");
  expect(html).toContain('href="https://github.com/tellahq/tella-mac/pull/73"');
  // Summary rows use the card's quiet row grammar instead of another status band.
  expect(html).not.toContain("bg-green-soft");
  expect(html).not.toContain("bg-red-soft");
});
