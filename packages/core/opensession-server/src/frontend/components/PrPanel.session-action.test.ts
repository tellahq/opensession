import { expect, test } from "bun:test";

const [
  panel,
  rail,
  workspace,
  viewer,
  viewerMainRegion,
  queuePreview,
  appContent,
] = await Promise.all([
  Bun.file(new URL("./PrPanel.tsx", import.meta.url)).text(),
  Bun.file(new URL("./pr/ReviewRail.tsx", import.meta.url)).text(),
  Bun.file(new URL("./WorkspacePane.tsx", import.meta.url)).text(),
  Bun.file(new URL("./SessionViewer.tsx", import.meta.url)).text(),
  Bun.file(
    new URL("./session-viewer/SessionViewerMainRegion.tsx", import.meta.url),
  ).text(),
  Bun.file(new URL("./PrQueuePreview.tsx", import.meta.url)).text(),
  Bun.file(new URL("../AppContent.tsx", import.meta.url)).text(),
]);

test("PR session actions open the workspace composer instead of a modal", () => {
  expect(panel).toContain("onStartSession?: () => void");
  expect(panel).toContain("onClick={onStartSession}");
  expect(panel).not.toContain("PrSessionsList");
  expect(panel).not.toContain("sessionsOpen");
  expect(panel).not.toContain("Sessions on this PR");

  expect(rail).toContain("onClick={onStartSession}");
  expect(rail).toContain("New session");
  expect(rail).not.toContain("sessionCount");

  expect(workspace).toContain(
    "onStartSession={onNewSession ? () => onNewSession() : undefined}",
  );
  expect(viewerMainRegion).toContain("onStartSession={openNewSession}");
  expect(viewer).toContain('() => void openNewSession("share")');

  expect(queuePreview).toContain("onStartSession={onStartSession}");
  expect(appContent).toContain(
    'navigate({ view: "workspace", id: workspaceId })',
  );
});
