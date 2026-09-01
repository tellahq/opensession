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
    "hooks/useSessionViewerActionsController.ts",
    "lib/session-viewer-actions.ts",
    "lib/transcript-history-controller.ts",
    "components/session/SessionPreviewSurface.tsx",
    "components/session-viewer/shell-timing.ts",
    "components/session-viewer/SessionViewerChrome.tsx",
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

test("SessionViewer delegates bounded action state without moving memo wrappers", async () => {
  const [viewer, controller, actions] = await Promise.all([
    source("components/SessionViewer.tsx"),
    source("hooks/useSessionViewerActionsController.ts"),
    source("lib/session-viewer-actions.ts"),
  ]);
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
    expect(viewer.match(new RegExp(`${hook}\\(`, "g")), hook).toHaveLength(1);
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
