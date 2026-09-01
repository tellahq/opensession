import { expect, test } from "bun:test";

const summarySource = await Bun.file(
  new URL("./WorkspaceSummary.tsx", import.meta.url),
).text();
const viewerSource = await Bun.file(
  new URL("./SessionViewer.tsx", import.meta.url),
).text();

test("PR status stays hidden until a new workspace is ready", () => {
  expect(summarySource).toContain(
    "workspacePreparing ?? Boolean(session.workspacePreparing)",
  );
  expect(summarySource).toContain("enabled: !workspaceIsPreparing");
  expect(summarySource).toContain("{!workspaceIsPreparing && (");

  const headerStatusStart = viewerSource.indexOf("<PrStatusBar");
  const headerCondition = viewerSource.slice(
    Math.max(0, headerStatusStart - 300),
    headerStatusStart,
  );
  expect(headerCondition).toContain("!workspacePreparing");

  expect(
    viewerSource.match(/workspacePreparing=\{workspacePreparing\}/g),
  ).toHaveLength(3);
});
