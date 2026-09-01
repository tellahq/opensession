import { expect, test } from "bun:test";

const panelSource = await Bun.file(
  new URL("./WorkflowPanel.tsx", import.meta.url),
).text();
const viewerSource = await Promise.all([
  Bun.file(
    new URL("./session-viewer/SessionViewerChrome.tsx", import.meta.url),
  ).text(),
  Bun.file(new URL("./SessionViewer.tsx", import.meta.url)).text(),
]).then((parts) => parts.join("\n"));

test("workflow session rows keep link styling and in-app navigation", () => {
  const rowStart = panelSource.indexOf("function NestedSessionRow(");
  const rowEnd = panelSource.indexOf("\nfunction DetailPre", rowStart);
  expect(rowStart).toBeGreaterThanOrEqual(0);
  expect(rowEnd).toBeGreaterThan(rowStart);
  const rowSource = panelSource.slice(rowStart, rowEnd);

  expect(rowSource).toContain("href={session.url}");
  expect(rowSource).toContain("no-underline");
  expect(rowSource).toContain("event.preventDefault();");
  expect(rowSource).toContain("onOpen(session.id);");
  expect(rowSource).toContain("event.metaKey");
  expect(rowSource).toContain("event.ctrlKey");
  expect(rowSource).toContain("event.shiftKey");
  expect(rowSource).toContain("event.altKey");
});

test("both Agents panel layouts provide the app navigation handler", () => {
  const workflowPanels = viewerSource.match(/<WorkflowPanel[\s\S]*?\/>/g) ?? [];
  expect(workflowPanels).toHaveLength(2);
  expect(workflowPanels[0]).toContain("onOpenSession=");
  expect(workflowPanels[0]).toContain("setInfoPageOpen(false);");
  expect(workflowPanels[1]).toContain("onOpenSession={openSession}");
});
