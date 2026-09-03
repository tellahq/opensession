import { describe, expect, test } from "bun:test";

const appSource = await Promise.all([
  Bun.file(new URL("useWorkspacePanes.ts", import.meta.url)).text(),
  Bun.file(new URL("../components/AppSessionPane.tsx", import.meta.url)).text(),
  Bun.file(new URL("../AppContent.tsx", import.meta.url)).text(),
]).then((sources) => sources.join("\n"));
const hookSource = await Bun.file(
  new URL("useOnDemandViewTabs.ts", import.meta.url),
).text();

describe("on-demand view tab ownership", () => {
  test("moves on-demand tab state and controllers out of App", () => {
    for (const setter of [
      "setStagingOpen",
      "setPreviewTabOpen",
      "setAssetsOpen",
      "setTerminalOpen",
      "setPortalTargets",
    ]) {
      expect(appSource).not.toContain(setter);
    }
    for (const controller of [
      "openStaging",
      "closeStagingTab",
      "openPreviewTab",
      "closePreviewTab",
      "openAssets",
      "closeAssetsTab",
      "openTerminal",
      "closeTerminalTab",
      "openPortal",
      "closePortalTab",
    ]) {
      expect(appSource).not.toContain(`function ${controller}(`);
    }
  });

  test("passes the persisting active-tab setter to the hook", () => {
    expect(appSource.match(/useOnDemandViewTabs\(\{/g)).toHaveLength(1);
    const callStart = appSource.indexOf("useOnDemandViewTabs({");
    const hookCall = appSource.slice(
      callStart,
      appSource.indexOf("});", callStart) + 3,
    );
    expect(hookCall).toContain("workspaceKey: wsKey");
    expect(hookCall).toContain("setActiveViewTab,");
    expect(hookCall).not.toContain("setActiveViewTabState");
  });

  test("keeps existing tab-strip, viewer, and navigation consumers", () => {
    expect(appSource).toContain("previewOpen: previewTabOpen");
    expect(appSource).toContain(
      "terminalTabOpen: !!wsKey && terminalOpen.has(wsKey)",
    );
    expect(appSource).toContain("openPreview: openPreviewTab");
  });

  test("restores only persistent on-demand tabs", () => {
    for (const tab of ["staging", "preview", "assets"]) {
      expect(hookSource).toContain(`new Set(getActiveViewTabKeys("${tab}"))`);
    }
    expect(hookSource).toMatch(
      /const \[terminalOpen, setTerminalOpen\] = useState<Set<string>>\(\s*\(\) => new Set\(\),/,
    );
    expect(hookSource).toContain(
      "const [portalTargets, setPortalTargets] = useState<",
    );
    expect(hookSource).not.toContain("saveActiveViewTab");
    expect(hookSource).not.toContain("localStorage");
  });

  test("falls back only when the closed tab is active", () => {
    for (const [tab, active] of [
      ["preview", "previewLiveActive"],
      ["portal", "portalActive"],
      ["staging", "stagingActive"],
      ["assets", "assetsActive"],
      ["terminal", "terminalActive"],
    ]) {
      expect(hookSource).toContain(
        `const ${active} = activeViewTab === "${tab}"`,
      );
      expect(hookSource).toContain(`if (${active}) setActiveViewTab(null)`);
    }
  });

  test("exports only the hook", () => {
    expect(hookSource.match(/\bexport\s+/g)).toHaveLength(1);
    expect(hookSource).toContain("export function useOnDemandViewTabs({");
  });
});
