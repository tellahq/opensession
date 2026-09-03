import { expect, test } from "bun:test";
import ts from "typescript";

async function interfaceMemberCount(path: string, interfaceName: string) {
  const source = await Bun.file(new URL(path, import.meta.url)).text();
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === interfaceName,
  );
  expect(declaration).toBeDefined();
  return declaration?.members.length ?? 0;
}

test("feature JSX factories live with sidebar components", async () => {
  const sidebarSource = await Bun.file(
    new URL("./Sidebar.tsx", import.meta.url),
  ).text();
  const owners = [
    ["sidebar-feed-renderers", "createSidebarFeedRenderers"],
    ["sidebar-support-renderer", "createSupportRenderer"],
    ["sidebar-tools-model", "createSidebarToolsModel"],
    ["sidebar-workspace-renderers", "createWorkspaceGroupingRenderers"],
  ] as const;

  for (const [moduleName, exportName] of owners) {
    expect(sidebarSource).toContain(`from "./sidebar/${moduleName}"`);
    const ownerSource = await Bun.file(
      new URL(`./sidebar/${moduleName}.tsx`, import.meta.url),
    ).text();
    expect(ownerSource).toContain(`export function ${exportName}`);
    expect(
      await Bun.file(
        new URL(`../lib/${moduleName}.tsx`, import.meta.url),
      ).exists(),
    ).toBe(false);
  }
});

test("extracted sidebar boundaries keep cohesive top-level APIs", async () => {
  const workspaceRowProps = await interfaceMemberCount(
    "./sidebar/WorkspaceRow.tsx",
    "WorkspaceRowProps",
  );
  const sidebarChromeProps = await interfaceMemberCount(
    "./sidebar/SidebarChrome.tsx",
    "SidebarChromeProps",
  );
  const workspaceControllerOptions = await interfaceMemberCount(
    "../hooks/useSidebarWorkspaceController.tsx",
    "WorkspaceControllerOptions",
  );

  expect(workspaceRowProps).toBe(7);
  expect(sidebarChromeProps).toBe(5);
  expect(workspaceControllerOptions).toBe(8);
  expect(
    Math.max(workspaceRowProps, sidebarChromeProps, workspaceControllerOptions),
  ).toBeLessThanOrEqual(15);
});
