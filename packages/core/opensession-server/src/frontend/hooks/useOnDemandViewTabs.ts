import { useEffect, useState } from "react";
import {
  getActiveViewTabKeys,
  type ActiveViewTab,
} from "../lib/active-view-tab";
import {
  readBrowserTabUrls,
  saveBrowserTabUrls,
} from "../lib/browser-tab-urls";
import { dropKeptFrame, keptFrameKey } from "../lib/kept-frames";
import { requestPanelBrowser } from "../lib/portal-pin";
import type { PortalTarget } from "../lib/portals";
import { opensInSidePanel } from "../lib/side-panel-store";

export function useOnDemandViewTabs({
  workspaceKey,
  sessionId,
  activeViewTab,
  setActiveViewTab,
}: {
  workspaceKey: string | null | undefined;
  /** The open session, whose side panel can take a Portal of its own. */
  sessionId?: string | null;
  activeViewTab: ActiveViewTab;
  setActiveViewTab: (tab: ActiveViewTab) => void;
}) {
  const stagingActive = activeViewTab === "staging";
  const assetsActive = activeViewTab === "assets";
  const portalActive = activeViewTab === "portal";
  const desktopActive = activeViewTab === "desktop";
  const terminalActive = activeViewTab === "terminal";
  const [stagingOpen, setStagingOpen] = useState<Set<string>>(
    () => new Set(getActiveViewTabKeys("staging")),
  );
  // One transient browser target per workspace. Selecting another service
  // reuses the same center pane instead of filling the tab strip with ports.
  const [portalTargets, setPortalTargets] = useState<
    Record<string, PortalTarget>
  >({});
  // A link opened in the Browser tab, per workspace. It takes the tab over
  // from the PR's preview deployment until the tab closes, and is saved so a
  // reload brings the tab back with its page.
  const [browserUrls, setBrowserUrls] =
    useState<Record<string, string>>(readBrowserTabUrls);
  useEffect(() => saveBrowserTabUrls(browserUrls), [browserUrls]);
  const [assetsOpen, setAssetsOpen] = useState<Set<string>>(
    () => new Set(getActiveViewTabKeys("assets")),
  );
  // Workspaces with a Terminal view-tab open. Starts empty every load: the
  // tab owns live PTYs, so it is never restored (see active-view-tab.ts).
  const [terminalOpen, setTerminalOpen] = useState<Set<string>>(
    () => new Set(),
  );
  // Workspaces with the Sandbox Desktop view-tab open. Also starts empty:
  // the pane mints a one-viewer URL and may wake the Sandbox when it mounts.
  const [desktopOpen, setDesktopOpen] = useState<Set<string>>(() => new Set());

  // Open/foreground this workspace's Preview environment view-tab (the Info
  // panel button). Adds the tab to the strip if absent.
  function openStaging() {
    if (opensInSidePanel("browser")) {
      requestPanelBrowser({ kind: "staging" });
      return;
    }
    if (!workspaceKey) return;
    const key = workspaceKey;
    setStagingOpen((prev) => {
      if (prev.has(key)) return prev;
      return new Set(prev).add(key);
    });
    setActiveViewTab("staging");
  }
  // Open a link in this workspace's Browser tab, adding the tab if absent.
  function openBrowser(url: string) {
    if (opensInSidePanel("browser")) {
      requestPanelBrowser({ kind: "url", url });
      return;
    }
    if (!workspaceKey) return;
    const key = workspaceKey;
    setBrowserUrls((prev) => {
      if (prev[key] === url) return prev;
      // Last is most recent, so the saved list drops the oldest first.
      const next = { ...prev };
      delete next[key];
      next[key] = url;
      return next;
    });
    setStagingOpen((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    setActiveViewTab("staging");
  }
  function openPortal(target: PortalTarget) {
    if (target.sessionId === sessionId && opensInSidePanel("browser")) {
      requestPanelBrowser({ kind: "portal", target });
      return;
    }
    if (!workspaceKey) return;
    setPortalTargets((prev) => ({ ...prev, [workspaceKey]: target }));
    setActiveViewTab("portal");
  }
  function closePortalTab() {
    if (workspaceKey) {
      dropKeptFrame(keptFrameKey("portal", workspaceKey));
      setPortalTargets((prev) => {
        if (!prev[workspaceKey]) return prev;
        const next = { ...prev };
        delete next[workspaceKey];
        return next;
      });
    }
    if (portalActive) setActiveViewTab(null);
  }
  function closeStagingTab() {
    if (workspaceKey) {
      const key = workspaceKey;
      dropKeptFrame(keptFrameKey("staging", key));
      setBrowserUrls((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setStagingOpen((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
    if (stagingActive) setActiveViewTab(null);
  }
  // Open/foreground this workspace's Assets view-tab (the Info panel's Assets
  // button). Adds the tab to the strip if absent.
  function openAssets() {
    if (!workspaceKey) return;
    const key = workspaceKey;
    setAssetsOpen((prev) => {
      if (prev.has(key)) return prev;
      return new Set(prev).add(key);
    });
    setActiveViewTab("assets");
  }
  function closeAssetsTab() {
    if (workspaceKey) {
      const key = workspaceKey;
      setAssetsOpen((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
    if (assetsActive) setActiveViewTab(null);
  }
  // Open/foreground this workspace's Terminal view-tab (the Info panel's
  // Terminal row). Closing it is what tears the shells down.
  function openTerminal() {
    if (!workspaceKey) return;
    const key = workspaceKey;
    setTerminalOpen((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    setActiveViewTab("terminal");
  }
  function closeTerminalTab() {
    if (workspaceKey) {
      const key = workspaceKey;
      setTerminalOpen((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
    if (terminalActive) setActiveViewTab(null);
  }

  // Open/foreground this workspace's Desktop view-tab (the Sandbox popover's
  // Open desktop). Closing it drops the embedded stream.
  function openDesktop() {
    if (!workspaceKey) return;
    const key = workspaceKey;
    setDesktopOpen((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    setActiveViewTab("desktop");
  }
  function closeDesktopTab() {
    if (workspaceKey) {
      const key = workspaceKey;
      setDesktopOpen((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
    if (desktopActive) setActiveViewTab(null);
  }

  const currentPortalTarget = workspaceKey
    ? (portalTargets[workspaceKey] ?? null)
    : null;
  const currentBrowserUrl = workspaceKey
    ? (browserUrls[workspaceKey] ?? null)
    : null;

  return {
    stagingOpen,
    assetsOpen,
    terminalOpen,
    desktopOpen,
    currentPortalTarget,
    currentBrowserUrl,
    openStaging,
    openBrowser,
    closeStagingTab,
    openAssets,
    closeAssetsTab,
    openTerminal,
    closeTerminalTab,
    openDesktop,
    closeDesktopTab,
    openPortal,
    closePortalTab,
  };
}
