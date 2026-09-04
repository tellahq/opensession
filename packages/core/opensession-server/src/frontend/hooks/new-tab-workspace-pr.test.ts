import { expect, test } from "bun:test";

const tabsSource = await Bun.file(
  new URL("./useSessionTabs.tsx", import.meta.url),
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

test("the tab's resources are asked again once the create has landed", () => {
  const landed = tabsSource.indexOf(
    "void revalidateApiResources(sessionApiKeyFilter(createdId));",
  );
  expect(landed).toBeGreaterThan(0);
  // After the server copy is in the list, before the pending shell is released.
  const before = tabsSource.slice(
    tabsSource.indexOf("const created = await newSessionApi("),
    landed,
  );
  expect(before).toContain("inject(");
  expect(before).not.toContain("clearTimeout(pendingTimer.current)");
});
