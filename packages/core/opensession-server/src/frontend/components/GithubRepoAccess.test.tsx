import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GithubRepoAccess } from "./GithubRepoAccess";

const installUrl = "https://github.com/apps/example-app/installations/new";

function render(
  installations?: { login: string; type?: string }[],
  refreshing = false,
) {
  return renderToStaticMarkup(
    <GithubRepoAccess
      installations={installations}
      installUrl={installUrl}
      refreshing={refreshing}
      onRefresh={() => {}}
    />,
  );
}

describe("GitHub repository access", () => {
  test("links to the App's installation page and points other accounts to their own App", () => {
    const html = render([{ login: "acme", type: "Organization" }]);
    expect(html).toContain("Installed on");
    expect(html).toContain("acme");
    expect(html).toContain("Organization");
    expect(html).not.toContain("Personal account");
    expect(html).toContain(`href="${installUrl}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Choose repositories");
    expect(html).toContain("Refresh repositories");
    expect(html).toContain(
      "A private App installs only on the account that owns it",
    );
  });

  test("shows both installation types without inferring them from App ownership", () => {
    const html = render([
      { login: "acme", type: "Organization" },
      { login: "solo-dev", type: "User" },
    ]);
    expect(html).toContain("acme");
    expect(html).toContain("solo-dev");
    expect(html).toContain("Organization");
    expect(html).toContain("Personal account");
  });

  test("distinguishes no installations from an unavailable installation list", () => {
    expect(render([])).toContain("No accounts yet.");
    expect(render()).toContain("Couldn’t check installed accounts.");
    expect(render()).not.toContain("No accounts yet.");
  });

  test("disables refresh while it is pending", () => {
    const html = render([], true);
    expect(html).toContain("Refreshing…");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("Refresh repositories");
  });
});
