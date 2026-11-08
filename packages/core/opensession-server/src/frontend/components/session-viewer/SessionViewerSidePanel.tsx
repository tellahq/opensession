import { type ComponentProps, type CSSProperties, useState } from "react";
import type { PanelBrowserTarget } from "../../lib/portal-pin";
import { DiffPanel } from "../DiffPanel";
import { PortalPane } from "../PortalPane";
import { PortalsPage } from "../PortalsPanel";
import { PrPanel } from "../PrPanel";
import { SessionPreviewSurface } from "../session/SessionPreviewSurface";
import type { ReviewRegion } from "./SessionViewerMainRegion";
import { SidePanelHost } from "../session/SidePanelHost";
import { WorkflowPanel } from "../WorkflowPanel";
import { WorkspaceSummaryBody } from "../WorkspaceSummary";
import { WorkspaceWaiting } from "./busy-indicators";
import { ThreadsPanel } from "../threads/ThreadsPanel";
import type { SidePanelThreads } from "../../hooks/useSidePanelTabs";

type HostProps = ComponentProps<typeof SidePanelHost>;
type SummaryProps = ComponentProps<typeof WorkspaceSummaryBody>;
type DiffProps = ComponentProps<typeof DiffPanel>;
type PortalsProps = ComponentProps<typeof PortalsPage>;
type AgentsProps = ComponentProps<typeof WorkflowPanel>;

interface SidePanelShell {
  hidden: HostProps["hidden"];
  isPhone: HostProps["isPhone"];
  available: HostProps["available"];
  open: HostProps["open"];
  onOpenChange: HostProps["onOpenChange"];
  portalTarget: HostProps["portalTarget"];
  style: HostProps["style"];
  resizeHandle: HostProps["resizeHandle"];
  hasWorkspace: HostProps["hasWorkspace"];
  page: HostProps["page"];
  onPageChange: HostProps["onPageChange"];
  livePortals: HostProps["livePortals"];
  runningAgents: HostProps["runningAgents"];
  terminalMounted: HostProps["terminalMounted"];
  onTerminalMount: HostProps["onTerminalMount"];
}

type PreviewSurface = ComponentProps<typeof SessionPreviewSurface>["surface"];
type StagingSurface = Extract<PreviewSurface, { kind: "staging" }>;

/** The Browser tab: what was handed to the panel, else the PR's preview. */
export interface PanelBrowserContent {
  target: PanelBrowserTarget | null;
  sessionId: string;
  staging: StagingSurface["deployment"];
  stagingUrl: string | null | undefined;
  shareLink: StagingSurface["shareLink"];
  onClose: () => void;
  /** Move the page to the main tab strip. */
  onExpand: () => void;
}

/** The panel's own tab strip. */
interface SidePanelTabs {
  tabs: HostProps["tabs"];
  availableTabs: HostProps["availableTabs"];
  onCloseTab: HostProps["onCloseTab"];
  onMoveToMain: HostProps["onMoveToMain"];
  browserLabel: HostProps["browserLabel"];
  entering: HostProps["entering"];
}

interface WorkspaceSummaryContent {
  session: SummaryProps["session"];
  onOpenPanelTab: SummaryProps["onOpenPanelTab"];
  onOpenPr: SummaryProps["onOpenPr"];
  onOpenStackPr: SummaryProps["onOpenStackPr"];
  onOpenChecks: SummaryProps["onOpenChecks"];
  onOpenAsset: SummaryProps["onOpenAsset"];
  onOpenAssets: SummaryProps["onOpenAssets"];
  onOpenSession: SummaryProps["onOpenSession"];
  onArchive: SummaryProps["onArchive"];
  reviewRequest: SummaryProps["reviewRequest"];
  reviewRequestSessionId: SummaryProps["reviewRequestSessionId"];
  onReviewChange: SummaryProps["onReviewChange"];
  prReviewRequested: SummaryProps["prReviewRequested"];
  running: SummaryProps["running"];
  workspacePreparing: SummaryProps["workspacePreparing"];
}

interface WorkspaceSummaryRuntime {
  send: SummaryProps["send"];
  refreshTick: SummaryProps["refreshTick"];
  liveMedia: SummaryProps["liveMedia"];
  close: SummaryProps["close"];
}

interface WorkspaceChangesContent {
  waitingForWorkspace: boolean;
  sessionId: DiffProps["sessionId"];
  isRunning: DiffProps["isRunning"];
  canSend: DiffProps["canSend"];
  send: DiffProps["send"];
  diff: DiffProps["diff"];
  source: DiffProps["source"];
  onSourceChange: DiffProps["onSourceChange"];
  onShareShipped?: DiffProps["onShareShipped"];
}

interface PortalContent {
  sessionId: PortalsProps["sessionId"];
  status: PortalsProps["status"];
  activePortal: PortalsProps["activePortal"];
  onBack: PortalsProps["onBack"];
  onOpenPortal: PortalsProps["onOpenPortal"];
  onStartPortal: PortalsProps["onStartPortal"];
  onPortalAction: PortalsProps["onPortalAction"];
  onPinPortal?: PortalsProps["onPinPortal"];
}

interface AgentContent {
  sessionId: AgentsProps["sessionId"];
  runs: AgentsProps["runs"];
  onAction: AgentsProps["onAction"];
  subagents: AgentsProps["subagents"];
  onOpenSubagent: AgentsProps["onOpenSubagent"];
  onOpenSession: AgentsProps["onOpenSession"];
  onBack: AgentsProps["onBack"];
}

interface SessionViewerSidePanelProps {
  shell: SidePanelShell;
  tabs: SidePanelTabs;
  summary: WorkspaceSummaryContent;
  summaryRuntime: WorkspaceSummaryRuntime;
  changes: WorkspaceChangesContent;
  changesContainerRef: ComponentProps<"div">["ref"];
  /** The header's summary card is up, so Changes need not repeat it. */
  summaryCardVisible: boolean;
  /** Review's inputs (the main region's); null where it cannot open. */
  review: ReviewRegion | null;
  browser: PanelBrowserContent;
  portals: PortalContent;
  agents: AgentContent;
  /** Set for a conversation that coordinates or has threads. */
  threads: SidePanelThreads | null;
}

export function SessionViewerSidePanel({
  shell,
  tabs,
  summary,
  summaryRuntime,
  changes,
  changesContainerRef,
  summaryCardVisible,
  review,
  browser,
  portals,
  agents,
  threads,
}: SessionViewerSidePanelProps) {
  const [prBandHeight, measurePrBand] = useBoxHeight();
  const changesStyle: CSSProperties & { "--diff-panel-top": string } = {
    "--diff-panel-top": `${prBandHeight}px`,
  };
  return (
    <>
      {/* Right region: the Workspace panel. Portaled to an app-level slot so
          it opens as a full-height column beside the left sidebar (not just
          below the session header). */}
      <SidePanelHost
        hidden={shell.hidden}
        isPhone={shell.isPhone}
        available={shell.available}
        open={shell.open}
        onOpenChange={shell.onOpenChange}
        portalTarget={shell.portalTarget}
        style={shell.style}
        resizeHandle={shell.resizeHandle}
        hasWorkspace={shell.hasWorkspace}
        page={shell.page}
        onPageChange={shell.onPageChange}
        tabs={tabs.tabs}
        availableTabs={tabs.availableTabs}
        onCloseTab={tabs.onCloseTab}
        onMoveToMain={tabs.onMoveToMain}
        browserLabel={tabs.browserLabel}
        entering={tabs.entering}
        livePortals={shell.livePortals}
        runningAgents={shell.runningAgents}
        terminalMounted={shell.terminalMounted}
        onTerminalMount={shell.onTerminalMount}
        sessionId={changes.sessionId}
        review={
          review ? (
            <PrPanel
              onOpenPr={review.openPr}
              sessionId={changes.sessionId}
              sessions={review.allSessions || review.workspaceSessions || []}
              onStartSession={
                review.openNewSession
                  ? () => void review.openNewSession?.("share")
                  : undefined
              }
              editGate={review.connected && !review.isBusy && !review.noEngine}
              onAddToInput={(text) =>
                review.setComposerPrefill((p) => ({
                  seq: (p?.seq ?? 0) + 1,
                  text,
                }))
              }
              repos={review.panelReviewRepos}
              linkedPrs={summary.session.linkedPrs}
              discoveredPrs={review.discoveredPrs}
              focusTarget={review.reviewFocus}
              linkable
              walkthrough={summary.session.walkthrough}
              page={review.reviewPage}
              onPageChange={review.setReviewPage}
            />
          ) : undefined
        }
        browser={<PanelBrowser content={browser} />}
        pinnedThreads={threads?.pinned}
        threads={
          threads && (
            <ThreadsPanel
              workspace={threads.workspace}
              rootId={threads.rootId}
              onOpenSession={summary.onOpenSession}
              onOpenAsset={summary.onOpenAsset}
            />
          )
        }
        changes={
          // One box around the summary and the diff, so the pinned PR band
          // stays up for the whole scroll, and the diff's own sticky toolbar
          // and file headers land under it rather than behind it.
          <div style={changesStyle}>
            {/* `contents` lets the PR band pin against the box above rather
                than ending its stick with the summary. */}
            {/* The summary card in the header says the same, so the column
                only carries it while the card is down. */}
            {!summaryCardVisible && (
              <section aria-label="Workspace summary" className="contents">
                <WorkspaceSummaryBody
                  prGroupRef={measurePrBand}
                  session={summary.session}
                  onOpenPanelTab={summary.onOpenPanelTab}
                  onOpenPr={summary.onOpenPr}
                  onOpenStackPr={summary.onOpenStackPr}
                  onOpenChecks={summary.onOpenChecks}
                  onOpenAsset={summary.onOpenAsset}
                  onOpenAssets={summary.onOpenAssets}
                  onOpenSession={summary.onOpenSession}
                  onArchive={summary.onArchive}
                  reviewRequest={summary.reviewRequest}
                  reviewRequestSessionId={summary.reviewRequestSessionId}
                  onReviewChange={summary.onReviewChange}
                  prReviewRequested={summary.prReviewRequested}
                  running={summary.running}
                  workspacePreparing={summary.workspacePreparing}
                  send={summaryRuntime.send}
                  refreshTick={summaryRuntime.refreshTick}
                  liveMedia={summaryRuntime.liveMedia}
                  close={summaryRuntime.close}
                />
                <div
                  aria-hidden="true"
                  className="mt-2 border-b border-divider"
                />
              </section>
            )}
            <div ref={changesContainerRef}>
              {changes.waitingForWorkspace ? (
                <WorkspaceWaiting detail="This takes a moment." />
              ) : (
                <DiffPanel
                  sessionId={changes.sessionId}
                  isRunning={changes.isRunning}
                  canSend={changes.canSend}
                  send={changes.send}
                  diff={changes.diff}
                  showFileList={false}
                  source={changes.source}
                  onSourceChange={changes.onSourceChange}
                  gitRefreshTick={summaryRuntime.refreshTick}
                  onShareShipped={changes.onShareShipped}
                />
              )}
            </div>
          </div>
        }
        portals={
          <PortalsPage
            sessionId={portals.sessionId}
            status={portals.status}
            activePortal={portals.activePortal}
            onBack={portals.onBack}
            hideHeader
            onOpenPortal={portals.onOpenPortal}
            onPinPortal={portals.onPinPortal}
            onStartPortal={portals.onStartPortal}
            onPortalAction={portals.onPortalAction}
          />
        }
        agents={
          <WorkflowPanel
            sessionId={agents.sessionId}
            runs={agents.runs}
            onAction={agents.onAction}
            subagents={agents.subagents}
            onOpenSubagent={agents.onOpenSubagent}
            onOpenSession={agents.onOpenSession}
            onBack={agents.onBack}
            hideHeader
          />
        }
      />
    </>
  );
}

/** The Browser tab's page. Not kept alive: the main strip's Browser tab owns
 *  the workspace's kept frame, and the two can hold different pages. */
function PanelBrowser({ content }: { content: PanelBrowserContent }) {
  const { target, sessionId, staging, stagingUrl, shareLink } = content;
  const { onClose, onExpand } = content;
  if (target?.kind === "portal")
    return (
      <PortalPane
        target={target.target}
        commentSessionId={sessionId}
        onClose={onClose}
        onExpand={onExpand}
      />
    );
  if (target?.kind === "url")
    return (
      <SessionPreviewSurface
        surface={{ kind: "browser", url: target.url }}
        commentSessionId={sessionId}
      />
    );
  if (!stagingUrl) return null;
  return (
    <SessionPreviewSurface
      surface={{
        kind: "staging",
        deployment: staging,
        url: stagingUrl,
        shareLink,
      }}
      commentSessionId={sessionId}
    />
  );
}

/** Tracks an element's rendered height through a callback ref. The React
 *  Compiler keeps `measure` stable, so the observer attaches once per node. */
function useBoxHeight() {
  const [height, setHeight] = useState(0);
  const measure = (el: HTMLElement | null) => {
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  };
  return [height, measure] as const;
}
