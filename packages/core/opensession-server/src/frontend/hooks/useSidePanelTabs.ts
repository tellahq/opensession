import { useEffect } from "react";
import { useNavigation } from "./useNavigation";
import type { ReviewRegion } from "../components/session-viewer/SessionViewerMainRegion";
import type { PanelBrowserTarget } from "../lib/portal-pin";
import type { PortalTarget } from "../lib/portals";
import {
  withSidePanelTab,
  type SidePanelDockable,
  type SidePanelTab,
} from "../lib/side-panel-open";
import type { PanelBrowserContent } from "../components/session-viewer/SessionViewerSidePanel";
import {
  registerSidePanelHost,
  setSidePanelDock,
} from "../lib/side-panel-store";

interface PanelState {
  panelBrowser: PanelBrowserTarget | null;
  closePanelBrowser: () => void;
  takePanelBrowser: () => PanelBrowserTarget | null;
  panelTabs: SidePanelTab[];
  closePanelTab: (tab: SidePanelTab) => void;
  /** An action just opened the panel, so it slides in. */
  panelEntering: boolean;
  setPanelTerminalMounted: (mounted: boolean) => void;
}

interface SidePanelTabsOptions {
  /** This viewer's panel is the one on screen: focused, desktop, available. */
  canHost: boolean;
  hasWorkspace: boolean;
  /** The viewer's gated openers (unset where the session cannot open one). */
  navigation: {
    openReview?: () => void;
    openPortal?: (target: PortalTarget) => void;
  };
  /** Review's inputs, shared with the main region's Review canvas. */
  review: ReviewRegion;
  /** The PR's preview deployment, the Browser tab's page when none was handed
   *  to the panel. */
  preview: Omit<PanelBrowserContent, "target" | "onClose" | "onExpand">;
  panel: PanelState;
}

/**
 * The session viewer's side of the panel's tab strip: which tabs this session
 * can fill, closing them, and handing Review or Browser to the main strip.
 * Returns SessionViewerSidePanel's `tabs`, `review` and `browser` props.
 */
export function useSidePanelTabs({
  canHost,
  hasWorkspace,
  navigation: { openReview, openPortal },
  review,
  preview,
  panel,
}: SidePanelTabsOptions) {
  const navigation = useNavigation();
  const { panelBrowser, closePanelBrowser, takePanelBrowser } = panel;
  const { closePanelTab, setPanelTerminalMounted, panelEntering } = panel;
  // A page attached to this session keeps its Browser tab in the strip, even
  // after another session closed its own.
  const panelTabs = panelBrowser
    ? withSidePanelTab(panel.panelTabs, "browser")
    : panel.panelTabs;
  // While this viewer's panel is on screen, Review and Browser requests from
  // anywhere in the app open in it (see opensInSidePanel).
  const hostKey = preview.sessionId;
  useEffect(
    () => (canHost ? registerSidePanelHost(hostKey) : undefined),
    [canHost, hostKey],
  );

  // Review needs a workspace to diff; the Browser tab needs a page, either one
  // handed to the panel or the PR's preview.
  const reviewAvailable = !!openReview && hasWorkspace;
  const availableTabs: SidePanelTab[] = [
    "changes",
    ...(reviewAvailable ? (["review"] as const) : []),
    ...(panelBrowser || preview.stagingUrl ? (["browser"] as const) : []),
    "portals",
    "agents",
    ...(hasWorkspace ? (["terminal"] as const) : []),
  ];

  /** Hand Review or Browser to the main tab strip, and open them there from
   *  now on. */
  const moveToMain = (tab: SidePanelDockable) => {
    setSidePanelDock(tab, "main");
    if (tab === "review") {
      closePanelTab("review");
      openReview?.();
      return;
    }
    const target = takePanelBrowser();
    if (target?.kind === "portal") openPortal?.(target.target);
    else if (target?.kind === "url") navigation.openBrowser(target.url);
    else navigation.openStaging();
  };

  const closeTab = (tab: SidePanelTab) => {
    if (tab === "browser") closePanelBrowser();
    else closePanelTab(tab);
    if (tab === "terminal") setPanelTerminalMounted(false);
  };

  const browser: PanelBrowserContent = {
    ...preview,
    target: panelBrowser,
    onClose: closePanelBrowser,
    onExpand: () => moveToMain("browser"),
  };

  return {
    review: reviewAvailable ? review : null,
    browser,
    tabs: {
      tabs: panelTabs,
      availableTabs,
      onCloseTab: closeTab,
      onMoveToMain: moveToMain,
      browserLabel:
        panelBrowser?.kind === "portal" ? panelBrowser.target.name : undefined,
      entering: panelEntering,
    },
  };
}
