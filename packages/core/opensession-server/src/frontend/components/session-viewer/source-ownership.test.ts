import { expect, test } from "bun:test";

const frontendRoot = new URL("../../", import.meta.url);

async function source(relativePath: string) {
  return Bun.file(new URL(relativePath, frontendRoot)).text();
}

function interfaceMemberCount(sourceText: string, name: string) {
  const start = sourceText.indexOf(`interface ${name} {`);
  const end = sourceText.indexOf("\n}", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceText.slice(start, end).split(";").length - 1;
}

test("SessionViewer decomposition files stay below the source line limit", async () => {
  const paths = [
    "hooks/useSessionViewerSubscription.ts",
    "hooks/useSessionModelWorkflowController.ts",
    "hooks/useSessionRuntimeController.ts",
    "hooks/useTranscriptHistoryController.ts",
    "hooks/useTranscriptReaderController.ts",
    "hooks/useSessionViewerActionsController.ts",
    "hooks/useSessionReviewController.ts",
    "hooks/useSessionViewStateController.ts",
    "hooks/useSessionConversationState.ts",
    "hooks/useSessionWorkspaceToolsController.ts",
    "hooks/useSessionChromeController.ts",
    "lib/session-viewer-actions.ts",
    "lib/transcript-history-controller.ts",
    "components/session/SessionPreviewSurface.tsx",
    "components/session-viewer/SessionViewerMainRegion.tsx",
    "components/session-viewer/shell-timing.ts",
    "components/session-viewer/SessionViewerChrome.tsx",
    "components/session-viewer/SessionViewerAssetOverlay.tsx",
    "components/session-viewer/SessionViewerDialogs.tsx",
    "components/session-viewer/SessionViewerSidePanel.tsx",
    "lib/session-viewer-constants.ts",
    "lib/session-viewer-derive.ts",
  ];

  for (const path of paths) {
    const lineCount = (await source(path)).split("\n").length;
    expect(
      lineCount,
      `${path} has ${lineCount} physical lines`,
    ).toBeLessThanOrEqual(1_999);
  }
});

test("new SessionViewer controllers keep cohesive bounded contracts", async () => {
  const contracts = {
    "hooks/useSessionReviewController.ts": [
      "ReviewNavigationAvailability",
      "ReviewVisibility",
      "SessionReviewControllerOptions",
    ],
    "hooks/useSessionViewStateController.ts": [
      "ViewStateIdentity",
      "ViewStateTranscript",
      "ViewStateSurface",
      "ViewStateSocket",
      "HeaderLayoutControllerOptions",
    ],
    "hooks/useSessionConversationState.ts": [
      "AvailabilityIdentity",
      "ShippedPresentationIdentity",
      "ShippedPresentationActions",
      "SlackComposerState",
      "ConversationActionIdentity",
      "ConversationActionRuntime",
      "DraftContextState",
      "SendComposerOptions",
      "SendQueueOptions",
      "ConversationProjectionOptions",
      "HeaderActionIdentity",
      "HeaderActionRuntime",
      "HeaderActionModel",
      "HeaderActionSetters",
    ],
    "hooks/useSessionWorkspaceToolsController.ts": [
      "WorkspaceToolsIdentity",
      "WorkspaceToolsRuntime",
      "WorkspaceToolsRelations",
    ],
    "hooks/useSessionChromeController.ts": [
      "ChromeIdentity",
      "ChromePanel",
      "ChromeRuntime",
      "ChromeLifecycle",
      "ChromeDeleteState",
      "ChromePreview",
    ],
  };

  for (const [path, names] of Object.entries(contracts)) {
    const text = await source(path);
    for (const name of names)
      expect(
        interfaceMemberCount(text, name),
        `${path}: ${name}`,
      ).toBeLessThanOrEqual(15);
    expect(text, path).not.toMatch(
      /:\s*any\b|<any>|as unknown|(?:Chunk|Group)\d+/,
    );
  }
});

test("the main conversation region owns its complete bounded JSX contract", async () => {
  const [viewer, region] = await Promise.all([
    source("components/SessionViewer.tsx"),
    source("components/session-viewer/SessionViewerMainRegion.tsx"),
  ]);
  const groups = [
    "SurfaceRegion",
    "PaneRegion",
    "ReviewRegion",
    "TranscriptState",
    "TranscriptContent",
    "TranscriptActions",
    "TranscriptInteraction",
    "SlackRegion",
    "EmptyConversationRegion",
    "ActionBandRegion",
    "ComposerState",
    "ComposerConfiguration",
    "ComposerActions",
    "ComposerMoreActions",
    "LayoutRegion",
    "TranscriptRegion",
    "ComposerRegion",
    "SessionViewerMainRegionProps",
  ];

  expect(viewer).toContain("<SessionViewerMainRegion");
  for (const owner of [
    "<ConversationLoading",
    "<TranscriptView",
    "<BusyInline",
    "<AskCard",
    "<ShippedChangeComposer",
    "<ReplySuggestions",
    "<Composer\n",
    "<ShellPanel",
  ]) {
    expect(region, owner).toContain(owner);
    expect(viewer, owner).not.toContain(owner);
  }
  for (const group of groups) {
    expect(interfaceMemberCount(region, group), group).toBeLessThanOrEqual(15);
  }
  expect(region).not.toMatch(/\buse(?:Memo|Callback)\(/);
  expect(region).not.toMatch(/\b(?:any|ts-ignore|ts-expect-error)\b/);
});

test("transcript reader lifecycle stays grouped and out of SessionViewer", async () => {
  const [viewer, reader] = await Promise.all([
    source("components/SessionViewer.tsx"),
    source("hooks/useTranscriptReaderController.ts"),
  ]);
  const groups = [
    "ReaderTranscriptState",
    "ReaderIndexState",
    "ReaderHistoryState",
    "ReaderLayoutOptions",
    "ReaderLifecycleIdentity",
    "ReaderLifecycleTranscript",
    "ReaderLifecycleHistory",
    "ReaderLifecycleScroll",
    "ReaderLifecycleRuntime",
    "ReaderLifecycleIndex",
    "ReaderLifecycleOptions",
  ];

  for (const group of groups) {
    expect(interfaceMemberCount(reader, group), group).toBeLessThanOrEqual(15);
  }
  expect(viewer.match(/useTranscriptReaderLayout\(/g)).toHaveLength(1);
  expect(viewer.match(/useTranscriptReaderLifecycle\(/g)).toHaveLength(1);
  expect(viewer).not.toContain("const initiallyScrolledSessionRef = useRef");
  expect(reader).not.toMatch(/:\s*any\b/);
  expect(reader).not.toMatch(/\bas\s+(?:const|[A-Z]\w*)\b/);
});

test("the session subscription has one bounded grouped options contract", async () => {
  const subscription = await source("hooks/useSessionViewerSubscription.ts");
  const groups = [
    "SubscriptionConnection",
    "SubscriptionTranscript",
    "SubscriptionIndex",
    "SubscriptionHistory",
    "SubscriptionRuntime",
    "SubscriptionComposer",
    "SubscriptionSlack",
  ];

  expect(subscription).toContain(
    "export function useSessionViewerSubscription({",
  );
  expect(
    interfaceMemberCount(subscription, "SessionViewerSubscriptionOptions"),
  ).toBe(groups.length);
  for (const group of groups) {
    expect(
      interfaceMemberCount(subscription, group),
      group,
    ).toBeLessThanOrEqual(15);
  }
  expect(subscription).not.toMatch(/\buse(?:Memo|Callback)\(/);
});

test("SessionViewer delegates its complete header chrome through bounded consumer groups", async () => {
  const [viewer, chrome] = await Promise.all([
    source("components/SessionViewer.tsx"),
    source("components/session-viewer/SessionViewerChrome.tsx"),
  ]);
  const groups = [
    "ChromeOverflowGit",
    "ChromePrTarget",
    "ChromeEffectiveReview",
    "ChromeIdentity",
    "ChromeLayout",
    "ChromeMenuState",
    "ChromeSessionActions",
    "ChromeWorkspaceActions",
    "ChromeModel",
    "ChromeInfoState",
    "ChromeInfoActions",
    "ChromeConversation",
    "SessionViewerChromeProps",
  ];

  expect(viewer).toContain("<SessionViewerChrome");
  expect(viewer).not.toContain("{!hideHeader &&");
  expect(chrome).toContain("{!hideHeader &&");
  expect(chrome).toContain("headerRepoEl &&");
  expect(chrome).toContain("headerModelEl &&");
  for (const group of groups) {
    expect(interfaceMemberCount(chrome, group), group).toBeLessThanOrEqual(15);
  }
  expect(chrome).not.toMatch(/\buse(?:Memo|Callback)\(/);
  expect(chrome).not.toMatch(/\b(?:any|as unknown|ts-ignore)\b/);
  expect(chrome).not.toContain("...props");
});

test("SessionViewer delegates overlays and the side panel through bounded contracts", async () => {
  const [viewer, dialogs, assetOverlay, sidePanel] = await Promise.all([
    source("components/SessionViewer.tsx"),
    source("components/session-viewer/SessionViewerDialogs.tsx"),
    source("components/session-viewer/SessionViewerAssetOverlay.tsx"),
    source("components/session-viewer/SessionViewerSidePanel.tsx"),
  ]);

  expect(viewer).toContain("<SessionViewerDialogs");
  expect(viewer).toContain("<SessionViewerAssetOverlay");
  expect(viewer).toContain("<SessionViewerSidePanel");
  expect(viewer).not.toContain("<SidePanelHost");
  expect(viewer).not.toContain("<AssetOverlay");
  expect(viewer).not.toContain("<DeleteSessionDialog");
  expect(viewer).not.toContain("<Modal.Root");

  const contracts = [
    [dialogs, "SessionViewerDialogsProps"],
    [dialogs, "DeleteDialogState"],
    [dialogs, "DeleteDialogActions"],
    [dialogs, "BranchDialogState"],
    [dialogs, "BranchDialogActions"],
    [assetOverlay, "SessionViewerAssetOverlayProps"],
    [assetOverlay, "AssetOverlayIdentity"],
    [assetOverlay, "AssetOverlayActions"],
    [sidePanel, "SessionViewerSidePanelProps"],
    [sidePanel, "SidePanelShell"],
    [sidePanel, "WorkspaceSummaryContent"],
    [sidePanel, "WorkspaceSummaryRuntime"],
    [sidePanel, "WorkspaceChangesContent"],
    [sidePanel, "PortalContent"],
    [sidePanel, "AgentContent"],
  ];
  for (const [moduleSource, contract] of contracts) {
    expect(
      interfaceMemberCount(moduleSource, contract),
      contract,
    ).toBeLessThanOrEqual(15);
  }

  for (const moduleSource of [dialogs, assetOverlay, sidePanel]) {
    expect(moduleSource).not.toMatch(/\buse(?:Memo|Callback)\(/);
    expect(moduleSource).not.toMatch(/\{\s*\.\.\./);
    expect(moduleSource).not.toMatch(/\bany\b|\bts-ignore\b|\bas\s+[A-Z]/);
  }
});

test("SessionViewer delegates bounded action state without moving memo wrappers", async () => {
  const [viewer, controller, actions, review, viewState, chrome] =
    await Promise.all([
      source("components/SessionViewer.tsx"),
      source("hooks/useSessionViewerActionsController.ts"),
      source("lib/session-viewer-actions.ts"),
      source("hooks/useSessionReviewController.ts"),
      source("hooks/useSessionViewStateController.ts"),
      source("hooks/useSessionChromeController.ts"),
    ]);
  const hookOwners = `${viewer}\n${review}\n${viewState}\n${chrome}`;
  const controllerGroups = [
    "ShippedShareIdentity",
    "HeaderLayoutIdentity",
    "OverflowIdentity",
    "ArchiveShortcutIdentity",
    "ArchiveShortcutActions",
  ];
  const actionGroups = [
    "ShippedIdentity",
    "ShippedSetters",
    "ShippedShareInput",
    "ComposerSetters",
    "ShareSessionContext",
    "SharePaneContext",
    "BranchActionState",
    "ArchiveCallbacks",
    "ArchiveSetters",
  ];

  for (const hook of [
    "useShippedShareState",
    "useSessionHeaderLayout",
    "useSessionOverflowState",
    "useSessionArchiveShortcut",
  ]) {
    expect(hookOwners.match(new RegExp(`${hook}\\(`, "g")), hook).toHaveLength(
      1,
    );
  }
  for (const group of controllerGroups) {
    expect(interfaceMemberCount(controller, group), group).toBeLessThanOrEqual(
      15,
    );
  }
  for (const group of actionGroups) {
    expect(interfaceMemberCount(actions, group), group).toBeLessThanOrEqual(15);
  }
  expect(controller).not.toMatch(/\buse(?:Memo|Callback)\(/);
  expect(actions).not.toMatch(/\buse[A-Z]\w*\(/);
  expect(viewer).not.toContain("async function archiveSessionAction");
  expect(viewer).not.toContain("async function shareShippedChangeAction");
});
