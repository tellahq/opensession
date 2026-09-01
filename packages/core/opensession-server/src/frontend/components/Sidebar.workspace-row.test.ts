import { expect, test } from "bun:test";

const sidebarSource = await Bun.file(
  new URL("./Sidebar.tsx", import.meta.url),
).text();
const controllerSource = await Bun.file(
  new URL("../hooks/useSidebarWorkspaceController.tsx", import.meta.url),
).text();
const rowSource = await Bun.file(
  new URL("./sidebar/WorkspaceRow.tsx", import.meta.url),
).text();

test("workspace rows own presentation while their controller owns gestures", () => {
  expect(sidebarSource).toContain("useSidebarWorkspaceController({");
  expect(sidebarSource).not.toContain("function renderWsRowImpl(");
  expect(sidebarSource).not.toContain("function wsRowTouchMove(");

  expect(controllerSource).toContain("function renderWsRowImpl(");
  expect(controllerSource).toContain("function wsRowTouchMove(");
  expect(controllerSource).toContain("const workspaceOverlays = (");
  expect(controllerSource).toContain("<WorkspaceRow");

  expect(rowSource).toContain("data-sidebar-item-key={`workspace:${row.key}`}");
  expect(rowSource).toContain('data-swipe-action="archive"');
  expect(rowSource).toContain("<WorkspaceDraftIndicator");
});
