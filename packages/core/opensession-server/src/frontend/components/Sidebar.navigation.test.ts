import { expect, test } from "bun:test";

const removedNavigationProps = [
  "onOpenPrs",
  "onOpenFeed",
  "onOpenSettings",
  "onOpenTasks",
  "onOpenAutomation",
  "onOpenPrItem",
  "onOpenPlain",
  "onOpenSupportTinder",
  "onOpenReports",
  "onOpenAnalytics",
  "onSelect",
  "onOpenReview",
  "onOpenTicket",
  "onOpenFeedItem",
  "onNewSession",
  "onNewSessionInRepo",
  "onOpenDraft",
  "onOpenWorkspace",
  "onOpenArchived",
  "onOpenCatchUp",
];

test("Sidebar navigation comes from NavigationContext", async () => {
  const sidebarSource = await Bun.file(
    new URL("./Sidebar.tsx", import.meta.url),
  ).text();
  const automationBandSource = await Bun.file(
    new URL("./sidebar/AutomationsBand.tsx", import.meta.url),
  ).text();
  const extractedNavigationSources = await Promise.all(
    [
      "../hooks/useSidebarWorkspaceController.tsx",
      "../lib/sidebar-feed-renderers.tsx",
      "../lib/sidebar-support-renderer.tsx",
      "../lib/sidebar-tools-model.tsx",
      "./sidebar/SidebarChrome.tsx",
    ].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
  );
  const navigationSource = [sidebarSource, ...extractedNavigationSources].join(
    "\n",
  );
  const typesSource = await Bun.file(
    new URL("../lib/sidebar-types.ts", import.meta.url),
  ).text();
  const propsStart = typesSource.indexOf("export interface Props {");
  const propsEnd = typesSource.indexOf(
    "export interface SidebarHandle",
    propsStart,
  );
  expect(propsStart).toBeGreaterThanOrEqual(0);
  expect(propsEnd).toBeGreaterThan(propsStart);
  const props = typesSource.slice(propsStart, propsEnd);

  for (const name of removedNavigationProps) {
    expect(props).not.toContain(`${name}:`);
    expect(props).not.toContain(`${name}?:`);
  }

  expect(sidebarSource).toContain("const navigation = useNavigation();");
  expect(navigationSource).toContain("navigation.openSession(session.id);");
  expect(navigationSource).toContain(
    "navigation.openWorkspace(row.workspace.id, unreadSession.id);",
  );
  expect(navigationSource).toContain(
    "onClick: () => navigation.openReports(),",
  );
  expect(navigationSource).toContain(
    "navigation.openReports({ automationId, reportId })",
  );
  expect(automationBandSource).toContain(
    "onOpenReport(overview.id, overview.latestReport.id);",
  );
  expect(navigationSource).toContain(
    "onOpen={() => navigation.openPrItem(item)}",
  );
  expect(navigationSource).toContain("onOpen={() => navigation.openTicket(t)}");
  expect(navigationSource).toContain(
    "onOpen={() => navigation.openFeedItem(feed, item)}",
  );
  expect(navigationSource).toContain("onClick={navigation.openNewWorkspace}");
  expect(sidebarSource).toContain("onNewSession={navigation.openNewWorkspace}");
});

test("App does not pass navigation callbacks to Sidebar", async () => {
  const appSource = await Bun.file(
    new URL("../App.tsx", import.meta.url),
  ).text();
  const sidebarStart = appSource.indexOf(
    "<Sidebar\n                    ref={sidebarRef}",
  );
  const sidebarEnd = appSource.indexOf("\n                  />", sidebarStart);
  expect(sidebarStart).toBeGreaterThanOrEqual(0);
  expect(sidebarEnd).toBeGreaterThan(sidebarStart);
  const sidebarInvocation = appSource.slice(sidebarStart, sidebarEnd);

  for (const name of removedNavigationProps) {
    expect(sidebarInvocation).not.toContain(`${name}=`);
  }
});
