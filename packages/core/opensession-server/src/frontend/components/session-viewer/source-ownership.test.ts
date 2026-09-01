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
    "lib/transcript-history-controller.ts",
    "components/session/SessionPreviewSurface.tsx",
    "components/session-viewer/shell-timing.ts",
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
