import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SidePanelPage } from "../../lib/side-panel-open";
import {
  PANEL_BODY,
  PANEL_OVERLAY,
  PANEL_SHELL,
  PANEL_TAB,
  PANEL_TABS,
} from "../../lib/session-panel-classes";
import { cn } from "../../ui/cn";
import { IconFile, IconGlobe, IconStack, IconTerminal } from "../icons";
import { ShellPanel } from "../TerminalPanel";

interface SidePanelHostProps {
  hidden: boolean;
  isPhone: boolean;
  available: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portalTarget?: HTMLElement | null;
  style?: CSSProperties;
  resizeHandle: ReactNode;
  hasWorkspace: boolean;
  page: SidePanelPage;
  onPageChange: (page: SidePanelPage) => void;
  livePortals: number;
  runningAgents: number;
  terminalMounted: boolean;
  onTerminalMount: () => void;
  sessionId: string;
  pinned?: ReactNode;
  changes: ReactNode;
  portals: ReactNode;
  agents: ReactNode;
}

export function SidePanelHost({
  hidden,
  isPhone,
  available,
  open,
  onOpenChange,
  portalTarget,
  style,
  resizeHandle,
  hasWorkspace,
  page,
  onPageChange,
  livePortals,
  runningAgents,
  terminalMounted,
  onTerminalMount,
  sessionId,
  pinned,
  changes,
  portals,
  agents,
}: SidePanelHostProps) {
  if (hidden) return null;

  const region = (
    <>
      {!isPhone && available && open && (
        <div className={PANEL_OVERLAY} onClick={() => onOpenChange(false)} />
      )}
      {!isPhone && available && open ? (
        <div className={PANEL_SHELL} style={style}>
          {resizeHandle}
          {hasWorkspace && !pinned && (
            <div className={PANEL_TABS}>
              <button
                type="button"
                aria-pressed={page === "changes"}
                className={cn(
                  PANEL_TAB,
                  page === "changes" && "bg-hover text-fg",
                )}
                onClick={() => onPageChange("changes")}
              >
                <IconFile size={15} className="shrink-0" />
                <span className="@max-[380px]:hidden">Changes</span>
              </button>
              <button
                type="button"
                aria-pressed={page === "portals"}
                className={cn(
                  PANEL_TAB,
                  page === "portals" && "bg-hover text-fg",
                )}
                onClick={() => onPageChange("portals")}
              >
                <IconGlobe size={15} className="shrink-0" />
                <span className="@max-[380px]:hidden">Portals</span>
                {livePortals > 0 && (
                  <span className="shrink-0 tabular-nums text-faint @max-[380px]:hidden">
                    {livePortals}
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-pressed={page === "agents"}
                className={cn(
                  PANEL_TAB,
                  page === "agents" && "bg-hover text-fg",
                )}
                onClick={() => onPageChange("agents")}
              >
                <IconStack size={15} className="shrink-0" />
                <span className="@max-[380px]:hidden">Agents</span>
                {runningAgents > 0 && (
                  <span className="shrink-0 tabular-nums text-yellow @max-[380px]:hidden">
                    {runningAgents}
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-pressed={page === "terminal"}
                className={cn(
                  PANEL_TAB,
                  page === "terminal" && "bg-hover text-fg",
                )}
                onClick={() => {
                  onTerminalMount();
                  onPageChange("terminal");
                }}
              >
                <IconTerminal size={15} className="shrink-0" />
                <span className="@max-[380px]:hidden">Terminal</span>
              </button>
            </div>
          )}
          <div className={PANEL_BODY}>
            {pinned ??
              (page === "changes"
                ? changes
                : page === "portals"
                  ? portals
                  : page === "agents"
                    ? agents
                    : null)}
            {/* Keep terminals mounted while switching panel tabs so their PTYs
                survive. Closing the panel still closes its terminals. */}
            {hasWorkspace && terminalMounted && (
              <div
                className={
                  !pinned && page === "terminal"
                    ? "flex h-full min-h-0 flex-col"
                    : "hidden"
                }
              >
                <div className="min-h-0 flex-1">
                  <ShellPanel
                    sessionId={sessionId}
                    visible={page === "terminal"}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );

  return portalTarget ? createPortal(region, portalTarget) : region;
}
