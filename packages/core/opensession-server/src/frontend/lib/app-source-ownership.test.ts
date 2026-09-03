import { describe, expect, test } from "bun:test";

const ownedModules = [
  "../App.tsx",
  "../AppContent.tsx",
  "../components/AppMobileHeader.tsx",
  "../components/AppSessionPane.tsx",
  "../components/AppSidebar.tsx",
  "../components/DeferredSettings.tsx",
  "../hooks/useActiveSession.ts",
  "../hooks/useAppDocumentInteractions.ts",
  "../hooks/useAppGlobalHotkeys.ts",
  "../hooks/useAppRegistries.ts",
  "../hooks/useAppViewState.ts",
  "../hooks/useNewSessionCreateStart.ts",
  "../hooks/useNewTabMorphTimer.ts",
  "../hooks/useSessionTabs.tsx",
  "../hooks/useWorkspacePanes.ts",
  "../components/app-command-actions.tsx",
  "./app-topbar-title.ts",
  "./app-types.ts",
  "./event-target.ts",
  "./tab-split-preview.ts",
  "./workspace-pane-state.ts",
] as const;

async function source(path: (typeof ownedModules)[number]) {
  return Bun.file(new URL(path, import.meta.url)).text();
}

describe("app source ownership", () => {
  test("keeps the composition root and every extracted owner bounded", async () => {
    for (const path of ownedModules) {
      const contents = await source(path);
      expect(contents.split("\n").length - 1, path).toBeLessThanOrEqual(1999);
    }
  });

  test("keeps App as the provider and bootstrap root", async () => {
    const app = await source("../App.tsx");
    expect(app).toContain('import { AppContent } from "./AppContent";');
    expect(app).toContain("<EffectRegistryProvider>");
    expect(app).toContain("<AppContent {...props} />");
    expect(app).not.toContain("useSessionTabs(");
  });

  test("delegates stateful domains from AppContent", async () => {
    const content = await source("../AppContent.tsx");
    for (const owner of [
      "useAppDocumentInteractions",
      "useAppRegistries",
      "useAppViewState",
      "useSessionTabs",
      "useWorkspacePanes",
    ]) {
      expect(content).toContain(`${owner}(`);
    }
    expect(content).toContain("<AppMobileHeader");
    expect(content).toContain("<AppSessionPane");
    expect(content).toContain("<AppSidebar");
  });
});

test("keeps extracted app contracts narrow", async () => {
  const ts = await import("typescript");
  const contracts = [
    ["../components/AppSessionPane.tsx", "AppSessionPaneProps", 9],
    ["../components/AppSidebar.tsx", "AppSidebarProps", 5],
    ["../hooks/useSessionTabs.tsx", "UseSessionTabsOptions", 9],
  ] as const;

  for (const [path, interfaceName, expectedMembers] of contracts) {
    const contents = await source(path);
    const file = ts.createSourceFile(
      path,
      contents,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const declaration = file.statements.find(
      (statement): statement is import("typescript").InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) &&
        statement.name.text === interfaceName,
    );
    expect(declaration, `${path} exports ${interfaceName}`).toBeDefined();
    expect(declaration?.members.length, interfaceName).toBe(expectedMembers);
    expect(declaration?.members.length, interfaceName).toBeLessThanOrEqual(15);

    function checkNestedContracts(node: import("typescript").Node) {
      if (ts.isTypeLiteralNode(node)) {
        expect(
          node.members.length,
          `${interfaceName} nested contract`,
        ).toBeLessThanOrEqual(15);
      }
      ts.forEachChild(node, checkNestedContracts);
    }
    if (declaration) checkNestedContracts(declaration);
  }
});
