import {
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type {
  SidePanelDockable,
  SidePanelPage,
  SidePanelTab,
} from "../../lib/side-panel-open";
import {
  getSidePanelState,
  subscribeSidePanel,
} from "../../lib/side-panel-store";
import {
  PANEL_BODY,
  PANEL_DROP_PREVIEW,
  PANEL_ENTER,
  PANEL_NEW_ROW,
  PANEL_NEW_ROWS,
  PANEL_OVERLAY,
  PANEL_SHELL,
  PANEL_TAB,
  PANEL_TAB_ACTIVE,
  PANEL_TAB_CLOSE,
  PANEL_TAB_CLOSE_ACTIVE,
  PANEL_TAB_SELECT,
  PANEL_TABS,
} from "../../lib/session-panel-classes";
import { cn } from "../../ui/cn";
import { ContextMenu, MENU_ICON } from "../../ui/menu";
import { Tooltip } from "../../ui/tooltip";
import {
  IconExpand,
  IconFile,
  IconGlobe,
  IconPlus,
  IconPullRequest,
  IconStack,
  IconTerminal,
  IconX,
} from "../icons";
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
  /** The panel's open tabs, in strip order (browser-wide). */
  tabs: readonly SidePanelTab[];
  /** Tabs this session has something to show in. Others stay out of the strip. */
  availableTabs: readonly SidePanelTab[];
  onCloseTab: (tab: SidePanelTab) => void;
  /** Hand Review or Browser to the main tab strip. */
  onMoveToMain?: (tab: SidePanelDockable) => void;
  /** The Browser tab's name: the Portal it shows, else "Browser". */
  browserLabel?: string;
  /** An action just opened the panel: slide it in (PANEL_ENTER). */
  entering?: boolean;
  livePortals: number;
  runningAgents: number;
  terminalMounted: boolean;
  onTerminalMount: () => void;
  sessionId: string;
  changes: ReactNode;
  review?: ReactNode;
  browser?: ReactNode;
  portals: ReactNode;
  agents: ReactNode;
}

const ICON = 15;

function tabIcon(tab: SidePanelTab) {
  switch (tab) {
    case "changes":
      return <IconFile size={ICON} className="shrink-0" />;
    case "review":
      return <IconPullRequest size={ICON} className="shrink-0" />;
    case "browser":
    case "portals":
      return <IconGlobe size={ICON} className="shrink-0" />;
    case "agents":
      return <IconStack size={ICON} className="shrink-0" />;
    case "terminal":
      return <IconTerminal size={ICON} className="shrink-0" />;
  }
}

const TAB_LABELS: Record<SidePanelTab, string> = {
  changes: "Changes",
  review: "Review",
  browser: "Browser",
  portals: "Portals",
  agents: "Agents",
  terminal: "Terminal",
};

function isDockable(tab: SidePanelTab): tab is SidePanelDockable {
  return tab === "review" || tab === "browser";
}

/**
 * The right side panel: its own tab strip over its own page. Tabs open and
 * close like the main strip's, "+" opens a new-tab page listing what the panel
 * can hold, and Review and Browser can move over to the main strip.
 */
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
  tabs,
  availableTabs,
  onCloseTab,
  onMoveToMain,
  browserLabel,
  entering = false,
  livePortals,
  runningAgents,
  terminalMounted,
  onTerminalMount,
  sessionId,
  changes,
  review,
  browser,
  portals,
  agents,
}: SidePanelHostProps) {
  const dropHover = useSyncExternalStore(
    subscribeSidePanel,
    () => getSidePanelState().dropHover,
    () => false,
  );
  if (hidden) return null;

  const shown = tabs.filter((tab) => availableTabs.includes(tab));
  // A selected tab this session cannot show (a Review tab over a session
  // with nothing to review) falls back to the first tab it can.
  const current: SidePanelPage =
    page === "new" || shown.includes(page) ? page : (shown[0] ?? "new");
  const label = (tab: SidePanelTab) =>
    tab === "browser" && browserLabel ? browserLabel : TAB_LABELS[tab];
  const select = (next: SidePanelPage) => {
    if (next === "terminal") onTerminalMount();
    onPageChange(next);
  };
  const count = (tab: SidePanelTab) =>
    tab === "portals" && livePortals > 0 ? (
      <span className="shrink-0 tabular-nums text-faint @max-[380px]:hidden">
        {livePortals}
      </span>
    ) : tab === "agents" && runningAgents > 0 ? (
      <span className="shrink-0 tabular-nums text-yellow @max-[380px]:hidden">
        {runningAgents}
      </span>
    ) : null;

  const strip = (
    <div className={PANEL_TABS} role="tablist" aria-label="Side panel">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {shown.map((tab) => {
          const active = current === tab;
          const name = label(tab);
          return (
            <ContextMenu.Root key={tab}>
              <ContextMenu.Trigger
                render={
                  <div
                    className={cn(
                      PANEL_TAB,
                      "group/ptab",
                      active && PANEL_TAB_ACTIVE,
                    )}
                  />
                }
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={PANEL_TAB_SELECT}
                  onClick={() => select(tab)}
                  title={name}
                >
                  {tabIcon(tab)}
                  <span className="truncate @max-[380px]:hidden">{name}</span>
                  {count(tab)}
                </button>
                <button
                  type="button"
                  className={cn(
                    PANEL_TAB_CLOSE,
                    active && PANEL_TAB_CLOSE_ACTIVE,
                  )}
                  aria-label={`Close ${name}`}
                  onClick={() => onCloseTab(tab)}
                >
                  <IconX size={13} dense aria-hidden="true" />
                </button>
              </ContextMenu.Trigger>
              <ContextMenu.Popup className="min-w-[220px]" finalFocus={false}>
                {onMoveToMain && isDockable(tab) && (
                  <ContextMenu.Item onClick={() => onMoveToMain(tab)}>
                    <IconExpand size={20} className={MENU_ICON} />
                    <span className="grow">Move to main tabs</span>
                  </ContextMenu.Item>
                )}
                <ContextMenu.Item onClick={() => onCloseTab(tab)}>
                  <IconX size={20} className={MENU_ICON} />
                  <span className="grow">Close tab</span>
                </ContextMenu.Item>
              </ContextMenu.Popup>
            </ContextMenu.Root>
          );
        })}
        {current === "new" && (
          <div className={cn(PANEL_TAB, PANEL_TAB_ACTIVE)}>
            <span role="tab" aria-selected className={PANEL_TAB_SELECT}>
              <IconPlus size={ICON} className="shrink-0" />
              <span className="truncate @max-[380px]:hidden">New tab</span>
            </span>
          </div>
        )}
        {current !== "new" && (
          <Tooltip label="New tab">
            <button
              type="button"
              className={cn(
                PANEL_TAB,
                "shrink-0 px-1.5 @max-[380px]:flex-none",
              )}
              aria-label="New tab"
              onClick={() => select("new")}
            >
              <IconPlus size={ICON} />
            </button>
          </Tooltip>
        )}
      </div>
      {onMoveToMain && current !== "new" && isDockable(current) && (
        <Tooltip label="Move to main tabs">
          <button
            type="button"
            className={cn(PANEL_TAB, "shrink-0 px-1.5 @max-[380px]:flex-none")}
            aria-label="Move to main tabs"
            onClick={() => onMoveToMain(current)}
          >
            <IconExpand size={ICON} />
          </button>
        </Tooltip>
      )}
    </div>
  );

  const newTabPage = (
    <div className="px-3 pt-4">
      <div className="px-3 pb-2 text-label font-semibold text-faint">Open</div>
      <div className={PANEL_NEW_ROWS}>
        {availableTabs.map((tab) => (
          <button
            key={tab}
            type="button"
            className={PANEL_NEW_ROW}
            onClick={() => select(tab)}
          >
            <span className="text-dim">{tabIcon(tab)}</span>
            <span className="grow truncate">{label(tab)}</span>
            {count(tab)}
          </button>
        ))}
      </div>
    </div>
  );

  const region = (
    <>
      {!isPhone && available && open && (
        <div className={PANEL_OVERLAY} onClick={() => onOpenChange(false)} />
      )}
      {!isPhone && available && open ? (
        <div className={cn(PANEL_SHELL, entering && PANEL_ENTER)} style={style}>
          {resizeHandle}
          {dropHover && (
            <div className={PANEL_DROP_PREVIEW} aria-hidden="true" />
          )}
          {strip}
          <div
            className={cn(
              PANEL_BODY,
              // Review and Browser bring their own scrollers and toolbars.
              (current === "review" || current === "browser") &&
                "flex flex-col overflow-hidden",
            )}
          >
            {current === "new"
              ? newTabPage
              : current === "changes"
                ? changes
                : current === "review"
                  ? review
                  : current === "browser"
                    ? browser
                    : current === "portals"
                      ? portals
                      : current === "agents"
                        ? agents
                        : null}
            {/* Keep terminals mounted while switching panel tabs so their PTYs
                survive. Closing the panel or its Terminal tab ends them. */}
            {hasWorkspace && terminalMounted && tabs.includes("terminal") && (
              <div
                className={
                  current === "terminal"
                    ? "flex h-full min-h-0 flex-col"
                    : "hidden"
                }
              >
                <div className="min-h-0 flex-1">
                  <ShellPanel
                    sessionId={sessionId}
                    visible={current === "terminal"}
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
