import { expect, test } from "bun:test";

const tabsSource = await Bun.file(
  new URL("./useSessionTabs.tsx", import.meta.url),
).text();
const viewerSource = await Bun.file(
  new URL("../components/SessionViewer.tsx", import.meta.url),
).text();

test("a new tab's local shell inherits the workspace's PRs, not the source's flat PR fields", () => {
  const draft = tabsSource.slice(
    tabsSource.indexOf("const draft: UnifiedSession = {"),
    tabsSource.indexOf('if (mode === "ask") {'),
  );
  expect(draft).toContain("prs: siblingTabPrRefs(src)");
  expect(draft).toContain("prUrl: undefined");
  expect(draft).toContain("prNumber: undefined");
  expect(draft).toContain("prState: undefined");
});

test("PR surfaces revalidate once a pending create lands", () => {
  expect(viewerSource).toContain(
    "const settled = wasPendingCreation.current && !pendingCreation;",
  );
  expect(viewerSource).toContain(
    "if (settled) setGitRefreshTick((tick) => tick + 1);",
  );
});
