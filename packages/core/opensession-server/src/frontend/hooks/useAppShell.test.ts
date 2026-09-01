import { describe, expect, test } from "bun:test";

const appSource = await Bun.file(
  new URL("../AppContent.tsx", import.meta.url),
).text();
const hookSource = await Bun.file(
  new URL("useAppShell.ts", import.meta.url),
).text();
const controllerSource = hookSource.slice(hookSource.indexOf("  return {"));

describe("app shell ownership", () => {
  test("delegates the shell controller once and destructures its groups in App", () => {
    expect(appSource.match(/useAppShell\(\)/g)).toHaveLength(1);
    expect(appSource).toContain(
      "pane: { detailPaneRef, detailPaneEl, captureDetailPane }",
    );
    expect(appSource).toContain(
      "rightPanel: { rightPanelEl, setRightPanelEl }",
    );
    expect(appSource).not.toContain("sidebarStartsCollapsed");
    expect(appSource).not.toContain(
      'localStorage.getItem("opensession-sidebar-w")',
    );
  });

  test("keeps the pane callback stable and callback-ref setters direct", () => {
    expect(hookSource).toContain(
      "const captureDetailPane = useCallback((node: HTMLElement | null) => {",
    );
    expect(hookSource).toContain(
      "detailPaneRef.current = node;\n    setDetailPaneEl(node);\n  }, []);",
    );
    for (const setter of [
      "setTopbarEl",
      "setTopbarActionsEl",
      "setAppHeaderEl",
      "setHeaderModelEl",
      "setHeaderRepoEl",
      "setHeaderActionsEl",
      "setRightPanelEl",
    ]) {
      expect(controllerSource).toMatch(new RegExp(`\\b${setter}(?:,| })`));
    }
  });

  test("retains top-bar scroll tracking and sidebar collapse behavior", () => {
    expect(hookSource).toContain(
      '".viewer-messages, [data-page-scroll], [data-review-canvas]"',
    );
    expect(hookSource).toContain(
      "const restoreMotion = suppressLayoutAnimations()",
    );
    expect(hookSource).toContain("storeSidebarCollapsed(next)");
    expect(hookSource).toContain("if (next) openWorkspaceSummary()");
  });

  test("retains bounded requestAnimationFrame resizing and persistence", () => {
    expect(hookSource).toContain("return v >= 200 && v <= 480 ? v : 280");
    expect(hookSource).toContain(
      "width = Math.min(480, Math.max(200, ev.clientX))",
    );
    expect(hookSource).toContain(
      "if (!frame) frame = requestAnimationFrame(paint)",
    );
    expect(hookSource).toContain("if (frame) cancelAnimationFrame(frame)");
    expect(hookSource).toContain(
      'document.body.classList.add("resizing-sidebar")',
    );
    expect(hookSource).toContain(
      'document.body.classList.remove("resizing-sidebar")',
    );
    expect(hookSource).toContain("setSidebarWidth(width)");
    expect(hookSource).toContain(
      'localStorage.setItem("opensession-sidebar-w", String(Math.round(width)))',
    );
  });

  test("exports only the hook", () => {
    expect(hookSource.match(/\bexport\s+/g)).toHaveLength(1);
    expect(hookSource).toContain("export function useAppShell()");
  });
});
