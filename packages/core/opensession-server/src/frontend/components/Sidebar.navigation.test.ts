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
  const controllerSource = await Bun.file(
    new URL("../hooks/useSidebarWorkspaceController.tsx", import.meta.url),
  ).text();
  const feedRendererSource = await Bun.file(
    new URL("./sidebar/sidebar-feed-renderers.tsx", import.meta.url),
  ).text();
  const supportRendererSource = await Bun.file(
    new URL("./sidebar/sidebar-support-renderer.tsx", import.meta.url),
  ).text();
  const toolsModelSource = await Bun.file(
    new URL("./sidebar/sidebar-tools-model.tsx", import.meta.url),
  ).text();
  const chromeSource = await Bun.file(
    new URL("./sidebar/SidebarChrome.tsx", import.meta.url),
  ).text();
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
  expect(sidebarSource).toContain("navigation.openSession(session.id);");
  expect(controllerSource).toContain(
    "navigation.openWorkspace(row.workspace.id, unreadSession.id);",
  );
  expect(toolsModelSource).toContain(
    "onClick: () => navigation.openReports(),",
  );
  expect(sidebarSource).toContain(
    "navigation.openReports({ automationId, reportId })",
  );
  expect(automationBandSource).toContain(
    "onOpenReport(overview.id, overview.latestReport.id);",
  );
  expect(sidebarSource).toContain("onOpen={() => navigation.openPrItem(item)}");
  expect(supportRendererSource).toContain(
    "onOpen={() => navigation.openTicket(t)}",
  );
  expect(feedRendererSource).toContain(
    "onOpen={() => navigation.openFeedItem(feed, item)}",
  );
  expect(chromeSource).toContain("onClick={navigation.openNewWorkspace}");
  expect(sidebarSource).toContain("onNewSession={navigation.openNewWorkspace}");
});

test("App does not pass navigation callbacks to Sidebar", async () => {
  const appSource = await Bun.file(
    new URL("./AppSidebar.tsx", import.meta.url),
  ).text();
  const sidebarStart = appSource.indexOf("<Sidebar\n");
  const sidebarEnd = appSource.indexOf("\n        />", sidebarStart);
  expect(sidebarStart).toBeGreaterThanOrEqual(0);
  expect(sidebarEnd).toBeGreaterThan(sidebarStart);
  const sidebarInvocation = appSource.slice(sidebarStart, sidebarEnd);

  for (const name of removedNavigationProps) {
    expect(sidebarInvocation).not.toContain(`${name}=`);
  }
});
