import type React from "react";
import {
  DETAIL_PANE,
  RIGHT_PANEL_SLOT,
  WORKSPACE_SHELL,
} from "../lib/app-shell-classes";
import { KeptFrameLayer } from "./KeptFrameLayer";
import { TitleBar } from "./TitleBar";

/** AppShell owns only layout chrome. App keeps routing, data, and mutations. */
export function AppShell({
  paneRef,
  rightPanelRef,
  collapsedControls,
  children,
}: {
  paneRef: (node: HTMLElement | null) => void;
  rightPanelRef: (node: HTMLDivElement | null) => void;
  /** Floating controls shown while the sidebar is collapsed. */
  collapsedControls?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={WORKSPACE_SHELL}>
      <main className={DETAIL_PANE} ref={paneRef}>
        {children}
        {/* Collapsed-sidebar controls float over the draggable header. Electron
            applies drag and no-drag regions in document order, so they must
            come after the header for their no-drag carve-out to win. */}
        {collapsedControls}
        {/* WCO back/forward fallback: the primary cluster lives in the
            sidebar's top chrome row, which vanishes when the sidebar is
            collapsed. This floating copy shows only then (CSS-gated). */}
        <TitleBar pane />
        {/* Browser and Portal pages that survive switching tabs and
            sessions. Last, so it paints over the slots it fills. */}
        <KeptFrameLayer />
      </main>

      {/* Full-height right column inside the same rounded workspace shell as
          the detail pane. The active session's workspace/sub-agent panel
          portals in here. */}
      <div className={RIGHT_PANEL_SLOT} ref={rightPanelRef} />
      {/* The panel's Browser pages, kept like the pane's above. */}
      <KeptFrameLayer panel />
    </div>
  );
}
