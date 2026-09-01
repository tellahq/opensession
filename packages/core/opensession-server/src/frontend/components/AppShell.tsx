import type React from "react";
import {
  DETAIL_PANE,
  RIGHT_PANEL_SLOT,
  WORKSPACE_SHELL,
} from "../lib/app-shell-classes";
import { TitleBar } from "./TitleBar";

/** AppShell owns only layout chrome. App keeps routing, data, and mutations. */
export function AppShell({
  paneRef,
  rightPanelRef,
  children,
}: {
  paneRef: (node: HTMLElement | null) => void;
  rightPanelRef: (node: HTMLDivElement | null) => void;
  children: React.ReactNode;
}) {
  return (
    <div className={WORKSPACE_SHELL}>
      <main className={DETAIL_PANE} ref={paneRef}>
        {/* WCO back/forward fallback: the primary cluster lives in the
            sidebar's top chrome row, which vanishes when the sidebar is
            collapsed — this floating copy shows only then (CSS-gated). */}
        <TitleBar pane />
        {/* The overlapping collapsed controls require the pane's header to
            opt out of native dragging. Keep one empty grip beside them so the
            window can still move without stealing any control's clicks. */}
        <div className="wco-collapsed-drag-handle" aria-hidden="true" />
        {children}
      </main>

      {/* Full-height right column inside the same rounded workspace shell as
          the detail pane. The active session's workspace/sub-agent panel
          portals in here. */}
      <div className={RIGHT_PANEL_SLOT} ref={rightPanelRef} />
    </div>
  );
}
