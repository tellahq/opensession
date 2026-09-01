import { useState } from "react";
import {
  getActiveViewTabKeys,
  type ActiveViewTab,
} from "../lib/active-view-tab";
import type { PortalTarget } from "../lib/portals";

export function useOnDemandViewTabs({
  workspaceKey,
  activeViewTab,
  setActiveViewTab,
}: {
  workspaceKey: string | null | undefined;
  activeViewTab: ActiveViewTab;
  setActiveViewTab: (tab: ActiveViewTab) => void;
}) {
  const stagingActive = activeViewTab === "staging";
  const assetsActive = activeViewTab === "assets";
  const previewLiveActive = activeViewTab === "preview";
  const portalActive = activeViewTab === "portal";
  const terminalActive = activeViewTab === "terminal";
  const [stagingOpen, setStagingOpen] = useState<Set<string>>(
    () => new Set(getActiveViewTabKeys("staging")),
  );
  // Sessions whose local-dev Preview view-tab is open (full-width iframe of
  // the running dev server — sibling of Staging, which shows the PR deploy).
  const [previewTabOpen, setPreviewTabOpen] = useState<Set<string>>(
    () => new Set(getActiveViewTabKeys("preview")),
  );
  // One transient browser target per workspace. Selecting another service
  // reuses the same center pane instead of filling the tab strip with ports.
  const [portalTargets, setPortalTargets] = useState<
    Record<string, PortalTarget>
  >({});
  const [assetsOpen, setAssetsOpen] = useState<Set<string>>(
    () => new Set(getActiveViewTabKeys("assets")),
  );
  // Workspaces with a Terminal view-tab open. Starts empty every load: the
  // tab owns live PTYs, so it is never restored (see active-view-tab.ts).
  const [terminalOpen, setTerminalOpen] = useState<Set<string>>(
    () => new Set(),
  );

  // Open/foreground this workspace's Preview environment view-tab (the Info
  // panel button). Adds the tab to the strip if absent.
  function openStaging() {
    if (!workspaceKey) return;
    const key = workspaceKey;
    setStagingOpen((prev) => {
      if (prev.has(key)) return prev;
      return new Set(prev).add(key);
    });
    setActiveViewTab("staging");
  }
  // Open/foreground this workspace's local-dev Preview view-tab (the header
  // Preview button routes here instead of window.open — the Mac shell was
  // turning those into stray Electron windows).
  function openPreviewTab() {
    if (!workspaceKey) return;
    const key = workspaceKey;
    setPreviewTabOpen((prev) => {
      if (prev.has(key)) return prev;
      return new Set(prev).add(key);
    });
    setActiveViewTab("preview");
  }
  function closePreviewTab() {
    if (workspaceKey) {
      const key = workspaceKey;
      setPreviewTabOpen((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
    if (previewLiveActive) setActiveViewTab(null);
  }
  function openPortal(target: PortalTarget) {
    if (!workspaceKey) return;
    setPortalTargets((prev) => ({ ...prev, [workspaceKey]: target }));
    setActiveViewTab("portal");
  }
  function closePortalTab() {
    if (workspaceKey) {
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

  const currentPortalTarget = workspaceKey
    ? (portalTargets[workspaceKey] ?? null)
    : null;

  return {
    stagingOpen,
    previewTabOpen,
    assetsOpen,
    terminalOpen,
    currentPortalTarget,
    openStaging,
    closeStagingTab,
    openPreviewTab,
    closePreviewTab,
    openAssets,
    closeAssetsTab,
    openTerminal,
    closeTerminalTab,
    openPortal,
    closePortalTab,
  };
}
