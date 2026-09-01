import type { ActiveViewTab } from "./active-view-tab";
import type { Workspace } from "./types";

export type WorkspacePaneTab = "review" | "conversation" | "video";
export type PaneTabIcon = "globe";

export interface PaneTabDescriptor {
  id: string;
  label: string;
  active: boolean;
  dotClass: string | null;
  icon?: PaneTabIcon;
}

interface BuildWorkspacePaneTabsInput {
  workspaceKey: string | null;
  sessionId?: string;
  activeViewTab: ActiveViewTab;
  reviewCapable: boolean;
  reviewIsDefault: boolean;
  reviewOpen: ReadonlySet<string>;
  reviewClosed: ReadonlySet<string>;
  reviewDotClass: string | null;
  conversationThreadId: string | null;
  conversationClosed: ReadonlySet<string>;
  videoLabel: string | null;
  videoClosed: ReadonlySet<string>;
  stagingOpen: ReadonlySet<string>;
  previewOpen: ReadonlySet<string>;
  portalLabel: string | null;
  assetsOpen: ReadonlySet<string>;
  terminalOpen: ReadonlySet<string>;
  subagentLabel: string | null;
}

export function buildWorkspacePaneTabs({
  workspaceKey,
  sessionId,
  activeViewTab,
  reviewCapable,
  reviewIsDefault,
  reviewOpen,
  reviewClosed,
  reviewDotClass,
  conversationThreadId,
  conversationClosed,
  videoLabel,
  videoClosed,
  stagingOpen,
  previewOpen,
  portalLabel,
  assetsOpen,
  terminalOpen,
  subagentLabel,
}: BuildWorkspacePaneTabsInput): PaneTabDescriptor[] {
  if (!workspaceKey) return [];
  const tabs: PaneTabDescriptor[] = [];
  if (
    reviewCapable &&
    (reviewOpen.has(workspaceKey) ||
      (reviewIsDefault && !reviewClosed.has(workspaceKey)))
  ) {
    tabs.push({
      id: `review:${workspaceKey}`,
      label: "Review",
      active: activeViewTab === "review",
      dotClass: reviewDotClass,
    });
  }
  if (conversationThreadId && !conversationClosed.has(workspaceKey)) {
    tabs.push({
      id: `conversation:${workspaceKey}`,
      label: "Conversation",
      active: activeViewTab === "conversation",
      dotClass: null,
    });
  }
  if (videoLabel && !videoClosed.has(workspaceKey)) {
    tabs.push({
      id: `video:${workspaceKey}`,
      label: videoLabel,
      active: activeViewTab === "video",
      dotClass: null,
    });
  }
  if (!sessionId) return tabs;

  if (stagingOpen.has(workspaceKey)) {
    tabs.push({
      id: `staging:${workspaceKey}`,
      label: "Preview environment",
      active: activeViewTab === "staging",
      dotClass: null,
      icon: "globe",
    });
  }
  if (previewOpen.has(workspaceKey)) {
    tabs.push({
      id: `preview:${workspaceKey}`,
      label: "Preview",
      active: activeViewTab === "preview",
      dotClass: null,
    });
  }
  if (portalLabel) {
    tabs.push({
      id: `portal:${workspaceKey}`,
      label: portalLabel,
      active: activeViewTab === "portal",
      dotClass: "bg-green",
      icon: "globe",
    });
  }
  if (assetsOpen.has(workspaceKey)) {
    tabs.push({
      id: `assets:${workspaceKey}`,
      label: "Assets",
      active: activeViewTab === "assets",
      dotClass: null,
    });
  }
  if (terminalOpen.has(workspaceKey)) {
    tabs.push({
      id: `terminal:${workspaceKey}`,
      label: "Terminal",
      active: activeViewTab === "terminal",
      dotClass: null,
    });
  }
  if (subagentLabel) {
    tabs.push({
      id: `subagent:${sessionId}`,
      label: subagentLabel,
      active: activeViewTab === "subagent",
      dotClass: null,
    });
  }
  return tabs;
}

export function sessionlessWorkspacePanes(
  workspaceKey: string | null,
  workspace: Workspace | null,
  options: {
    reviewOpen: ReadonlySet<string>;
    reviewClosed: ReadonlySet<string>;
    conversationClosed: ReadonlySet<string>;
    videoClosed: ReadonlySet<string>;
    hasWebPanel: (workspace: Workspace) => boolean;
  },
): WorkspacePaneTab[] {
  if (!workspaceKey || !workspace) return [];
  const reviewIsDefault =
    workspace.prNumber !== undefined || workspace.key?.startsWith("ghpr-");
  const panes: WorkspacePaneTab[] = [];
  if (
    (workspace.prNumber !== undefined || !!workspace.branch) &&
    (options.reviewOpen.has(workspaceKey) ||
      (reviewIsDefault && !options.reviewClosed.has(workspaceKey)))
  ) {
    panes.push("review");
  }
  if (
    workspace.plainThreadId &&
    !options.conversationClosed.has(workspaceKey)
  ) {
    panes.push("conversation");
  }
  if (
    options.hasWebPanel(workspace) &&
    !options.videoClosed.has(workspaceKey)
  ) {
    panes.push("video");
  }
  return panes;
}

export function viewTabKind(id: string): Exclude<ActiveViewTab, null> | null {
  if (id.startsWith("subagent:")) return "subagent";
  if (id.startsWith("staging:")) return "staging";
  if (id.startsWith("assets:")) return "assets";
  if (id.startsWith("terminal:")) return "terminal";
  if (id.startsWith("preview:")) return "preview";
  if (id.startsWith("portal:")) return "portal";
  if (id.startsWith("conversation:")) return "conversation";
  if (id.startsWith("video:")) return "video";
  if (id.startsWith("review:")) return "review";
  return null;
}
