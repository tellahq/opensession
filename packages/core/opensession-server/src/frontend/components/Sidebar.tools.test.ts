import { expect, test } from "bun:test";

const sidebarSource = await Bun.file(
  new URL("./Sidebar.tsx", import.meta.url),
).text();
const toolsNavSource = await Bun.file(
  new URL("./sidebar/SidebarToolsNav.tsx", import.meta.url),
).text();

test("the tools nav owns tool-row rendering", () => {
  expect(sidebarSource).toContain("<SidebarToolsNav");
  expect(sidebarSource).not.toContain("{visibleTools.map((tool)");
  expect(toolsNavSource).toContain("{tools.map((tool)");
  expect(toolsNavSource).toContain("<OrganizationSwitcher");
  expect(toolsNavSource).toContain("<SidebarToolRows");
  expect(toolsNavSource).toContain("<TeamLensMenu");
});
