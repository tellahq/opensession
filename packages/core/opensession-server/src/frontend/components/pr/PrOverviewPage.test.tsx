import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { prStatusMark } from "../../lib/pr-status";
import { providerFromUrl } from "../../lib/provider";
import type { PrDetails } from "../../lib/types";
import { PrOverviewPage } from "./PrOverviewPage";

const pr: PrDetails = {
  number: 42,
  title:
    "A complete pull request title that should wrap rather than truncate on a phone",
  url: "https://github.com/acme/project/pull/42",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feature",
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  reviewDecision: "",
  author: "acme",
  body: "Summary",
  checks: [],
};

for (const [state, isDraft, label] of [
  ["OPEN", false, "Open"],
  ["OPEN", true, "Draft"],
  ["MERGED", false, "Merged"],
  ["CLOSED", false, "Closed"],
] as const) {
  test(`phone overview leads with the ${label} identity, then status, then the description`, () => {
    const html = renderToStaticMarkup(
      <PrOverviewPage
        compactToolbar={false}
        sessionId="example-session"
        provider={providerFromUrl(pr.url)}
        pr={{ ...pr, state, isDraft }}
        railStacked
        rail={
          <aside>
            <button>Metadata action</button>
          </aside>
        }
        statusMark={prStatusMark({ state, isDraft })}
        hideWideOverviewRail={false}
        bodyHtml="<p>Description first</p>"
        comments={[]}
      />,
    );
    expect(html).toContain(pr.title);
    expect(html).toContain(label);
    expect(html).toContain("+10");
    expect(html).toContain("1 file");
    expect(html).toContain("feature");
    expect(html.indexOf(pr.title)).toBeLessThan(
      html.indexOf("Metadata action"),
    );
    expect(html.indexOf("Metadata action")).toBeLessThan(
      html.indexOf("Description first"),
    );
  });
}

test("desktop overview leads with the title, branches and the merge box", () => {
  const html = renderToStaticMarkup(
    <PrOverviewPage
      compactToolbar={false}
      sessionId="example-session"
      provider={providerFromUrl(pr.url)}
      pr={pr}
      railStacked={false}
      rail={<aside>Rail</aside>}
      mergeBox={<section>Merge box</section>}
      statusMark={prStatusMark({ state: pr.state, isDraft: pr.isDraft })}
      hideWideOverviewRail={false}
      bodyHtml="<p>Description first</p>"
      comments={[]}
    />,
  );
  expect(html).toContain("wants to merge into");
  expect(html).toContain("Copy branch name");
  expect(html.indexOf("wants to merge into")).toBeLessThan(
    html.indexOf("Merge box"),
  );
  expect(html.indexOf("Merge box")).toBeLessThan(
    html.indexOf("Description first"),
  );
});
