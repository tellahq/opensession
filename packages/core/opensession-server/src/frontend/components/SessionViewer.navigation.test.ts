import { expect, test } from "bun:test";

const removedNavigationProps = [
  "onBack",
  "onNextChat",
  "onNewSession",
  "onNewWorkspace",
  "onStartNewChat",
  "onOpenSession",
  "onOpenNewSession",
  "onOpenReview",
  "onOpenStaging",
  "onOpenAssets",
  "onOpenTerminal",
  "onOpenPreviewTab",
  "onOpenPr",
  "onOpenPortal",
  "onOpenWorkspace",
];

const availabilityProps = [
  "canOpenNextChat",
  "canStartNewSession",
  "canOpenNewWorkspace",
  "canOpenSession",
  "canOpenReview",
  "canOpenAssets",
  "canOpenPr",
  "canOpenPortal",
  "canOpenWorkspace",
];

const callbackOwners = {
  SessionViewerLifecycleBinding: [
    "onArchive",
    "onArchived",
    "onRename",
    "onRunningChange",
    "onReviewChange",
  ],
  SessionViewerWorkspaceBinding: [
    "onRenameWorkspace",
    "onArchiveWorkspace",
    "onDeleteWorkspace",
    "onSetStatus",
    "onRestoreSession",
  ],
  SessionViewerViewTabsBinding: [
    "onCloseStaging",
    "onCloseAssets",
    "onCloseTerminal",
    "onClosePreviewTab",
  ],
  SessionViewerSubagentsBinding: [
    "onOpenSubagent",
    "onSubagentBack",
    "onSubagentLabel",
  ],
};

async function sources() {
  const viewer = await Bun.file(
    new URL("./SessionViewer.tsx", import.meta.url),
  ).text();
  const app = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
  const bindings = await Bun.file(
    new URL("../lib/session-viewer-bindings.ts", import.meta.url),
  ).text();
  return { viewer, app, bindings };
}

function interfaceBody(sourceText: string, name: string) {
  const start = sourceText.indexOf(`export interface ${name} {`);
  const end = sourceText.indexOf("\n}", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceText.slice(start, end);
}

test("SessionViewer navigation comes from NavigationContext", async () => {
  const { viewer, bindings } = await sources();
  const props = interfaceBody(bindings, "SessionViewerProps");
  const availability = interfaceBody(
    bindings,
    "SessionViewerAvailabilityBinding",
  );

  for (const name of removedNavigationProps) {
    expect(bindings).not.toContain(`${name}:`);
    expect(bindings).not.toContain(`${name}?:`);
  }
  for (const name of availabilityProps) {
    expect(availability).toContain(`${name}?: boolean;`);
  }
  expect(props).toContain("availability: SessionViewerAvailabilityBinding;");
  for (const [owner, names] of Object.entries(callbackOwners)) {
    const binding = interfaceBody(bindings, owner);
    for (const name of names) expect(binding).toContain(`${name}?`);
  }

  expect(viewer).toContain(
    'import { useNavigation } from "../hooks/useNavigation";',
  );
  expect(viewer).toContain("const navigation = useNavigation();");
  expect(viewer).toContain(
    "const openNextChat = canOpenNextChat ? navigation.openNextChat : undefined;",
  );
  expect(viewer).toContain(
    "const openNewSession = canStartNewSession\n    ? navigation.openNewSessionInWorkspace\n    : undefined;",
  );
  expect(viewer).toContain('void openNewSession("share");');
  expect(viewer).toContain(
    "navigation.startNewChat(\n                      session,",
  );
  expect(viewer).toContain(
    "openReview && (prPresentation.primary || prPresentation.additional.length)",
  );
  expect(viewer).toContain("if (!id || !openSession) return;");
  expect(viewer).toContain(
    "onOpenAsTab={openAssets ? promoteAssetToTab : undefined}",
  );
  expect(viewer).toContain(
    "const openCurrentWorkspace = canOpenWorkspace\n    ? navigation.openCurrentWorkspace\n    : undefined;",
  );
  expect(viewer).toContain("onOpenSession={openCurrentWorkspace}");
});

test("duplicate session stays available at the current tip inside a workspace", async () => {
  const { viewer } = await sources();
  expect(viewer).toContain("                  {forkAction}");
  expect(viewer).toContain('<span className="grow">Duplicate session</span>');
  expect(viewer).not.toContain("{!workspaceScopedMenu && forkAction}");
  expect(viewer).toContain("                handleFork();");
  expect(viewer).toContain("void navigation.duplicateSession();");
  expect(viewer).not.toContain("const lastAssistantId = entries.findLast(");
  expect(viewer).toContain("? { messageId: forkFrom.messageId }");
});

test("App passes only SessionViewer navigation availability", async () => {
  const { app } = await sources();
  const viewerStart = app.indexOf("<SessionViewer\n");
  const viewerEnd = app.indexOf("\n        />", viewerStart);
  expect(viewerStart).toBeGreaterThanOrEqual(0);
  expect(viewerEnd).toBeGreaterThan(viewerStart);
  const viewerInvocation = app.slice(viewerStart, viewerEnd);

  for (const name of removedNavigationProps) {
    expect(viewerInvocation).not.toContain(`${name}=`);
    expect(viewerInvocation).not.toContain(`${name}:`);
  }
  expect(viewerInvocation).toContain("availability={{");
  for (const name of availabilityProps) {
    expect(viewerInvocation).toContain(`${name}:`);
    expect(viewerInvocation).not.toContain(`${name}=`);
  }

  expect(viewerInvocation).toContain(
    "canOpenNextChat: focused && nextChatAvailable",
  );
  expect(viewerInvocation).toContain(
    "canStartNewSession: !viewerSession.desk && !emptyWorkspaceSession",
  );

  const openSessionStart = app.indexOf("const openSession =");
  const openSessionEnd = app.indexOf("\n  };", openSessionStart);
  expect(openSessionStart).toBeGreaterThanOrEqual(0);
  expect(openSessionEnd).toBeGreaterThan(openSessionStart);
  expect(app.slice(openSessionStart, openSessionEnd)).toContain(
    "setActiveViewTab(null);",
  );
});
