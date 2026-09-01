import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
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
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  shrink0: {
    flexShrink: "0",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  textYellow: {
    color: "var(--yellow)",
  },
  minH0: {
    minHeight: "0",
  },
  flex1: {
    flex: "1",
  },
});

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
          {hasWorkspace && (
            <div className={PANEL_TABS}>
              <button
                type="button"
                aria-pressed={page === "changes"}
                className={cn(
                  PANEL_TAB,
                  page === "changes" && utilityClassName("bg-hover text-fg"),
                )}
                onClick={() => onPageChange("changes")}
              >
                <IconFile
                  size={15}
                  className={mergeStylexOverrideClassName("", sx.shrink0)}
                />
                <span className="@max-[380px]:hidden">Changes</span>
              </button>
              <button
                type="button"
                aria-pressed={page === "portals"}
                className={cn(
                  PANEL_TAB,
                  page === "portals" && utilityClassName("bg-hover text-fg"),
                )}
                onClick={() => onPageChange("portals")}
              >
                <IconGlobe
                  size={15}
                  className={mergeStylexOverrideClassName("", sx.shrink0)}
                />
                <span className="@max-[380px]:hidden">Portals</span>
                {livePortals > 0 && (
                  <span
                    {...mergeStylexProps(
                      "tabular-nums @max-[380px]:hidden",
                      sx.shrink0,
                      sx.textFaint,
                    )}
                  >
                    {livePortals}
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-pressed={page === "agents"}
                className={cn(
                  PANEL_TAB,
                  page === "agents" && utilityClassName("bg-hover text-fg"),
                )}
                onClick={() => onPageChange("agents")}
              >
                <IconStack
                  size={15}
                  className={mergeStylexOverrideClassName("", sx.shrink0)}
                />
                <span className="@max-[380px]:hidden">Agents</span>
                {runningAgents > 0 && (
                  <span
                    {...mergeStylexProps(
                      "tabular-nums @max-[380px]:hidden",
                      sx.shrink0,
                      sx.textYellow,
                    )}
                  >
                    {runningAgents}
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-pressed={page === "terminal"}
                className={cn(
                  PANEL_TAB,
                  page === "terminal" && utilityClassName("bg-hover text-fg"),
                )}
                onClick={() => {
                  onTerminalMount();
                  onPageChange("terminal");
                }}
              >
                <IconTerminal
                  size={15}
                  className={mergeStylexOverrideClassName("", sx.shrink0)}
                />
                <span className="@max-[380px]:hidden">Terminal</span>
              </button>
            </div>
          )}
          <div className={PANEL_BODY}>
            {page === "changes"
              ? changes
              : page === "portals"
                ? portals
                : page === "agents"
                  ? agents
                  : null}
            {/* Keep terminals mounted while switching panel tabs so their PTYs
                survive. Closing the panel still closes its terminals. */}
            {hasWorkspace && terminalMounted && (
              <div
                className={
                  page === "terminal"
                    ? utilityClassName("flex h-full min-h-0 flex-col")
                    : utilityClassName("hidden")
                }
              >
                <div {...stylex.props(sx.minH0, sx.flex1)}>
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
