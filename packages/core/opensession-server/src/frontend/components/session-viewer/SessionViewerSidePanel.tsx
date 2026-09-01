import type { ComponentProps } from "react";
import { DiffPanel } from "../DiffPanel";
import { PortalsPage } from "../PortalsPanel";
import { SidePanelHost } from "../session/SidePanelHost";
import { WorkflowPanel } from "../WorkflowPanel";
import { WorkspaceSummaryBody } from "../WorkspaceSummary";
import { WorkspaceWaiting } from "./busy-indicators";

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
}

interface PortalContent {
  sessionId: PortalsProps["sessionId"];
  status: PortalsProps["status"];
  activePortal: PortalsProps["activePortal"];
  onBack: PortalsProps["onBack"];
  onOpenPortal: PortalsProps["onOpenPortal"];
  onStartPortal: PortalsProps["onStartPortal"];
  onPortalAction: PortalsProps["onPortalAction"];
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
  summary: WorkspaceSummaryContent;
  summaryRuntime: WorkspaceSummaryRuntime;
  changes: WorkspaceChangesContent;
  changesContainerRef: ComponentProps<"div">["ref"];
  portals: PortalContent;
  agents: AgentContent;
}

export function SessionViewerSidePanel({
  shell,
  summary,
  summaryRuntime,
  changes,
  changesContainerRef,
  portals,
  agents,
}: SessionViewerSidePanelProps) {
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
        livePortals={shell.livePortals}
        runningAgents={shell.runningAgents}
        terminalMounted={shell.terminalMounted}
        onTerminalMount={shell.onTerminalMount}
        sessionId={changes.sessionId}
        changes={
          <>
            <section
              aria-label="Workspace summary"
              className="flex flex-col border-b border-divider py-2"
            >
              <WorkspaceSummaryBody
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
            </section>
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
                />
              )}
            </div>
          </>
        }
        portals={
          <PortalsPage
            sessionId={portals.sessionId}
            status={portals.status}
            activePortal={portals.activePortal}
            onBack={portals.onBack}
            hideHeader
            onOpenPortal={portals.onOpenPortal}
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
