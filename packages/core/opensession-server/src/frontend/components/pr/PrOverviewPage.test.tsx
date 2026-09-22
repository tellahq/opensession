import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
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
  test(`phone overview shows the full title and ${label} status before metadata`, () => {
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
        hideWideOverviewRail={false}
        bodyHtml="<p>Description first</p>"
        comments={[]}
      />,
    );
    expect(html).toContain(pr.title);
    expect(html).toContain(`<span>${label}</span>`);
    expect(html.indexOf(pr.title)).toBeLessThan(
      html.indexOf("Description first"),
    );
    expect(html.indexOf("Description first")).toBeLessThan(
      html.indexOf("Metadata action"),
    );
    expect(html).toContain('class="desktop:order-first"');
  });
}
