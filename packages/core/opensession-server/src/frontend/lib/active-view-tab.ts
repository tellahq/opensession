// The foregrounded non-session tab in each workspace. This is a per-device
// working preference, like tab order, so switching workspaces or reloading the
// app returns each workspace to the surface that was last in front.
const KEY = "opensession-active-view-tabs";

const VIEW_TABS = [
  "review",
  "conversation",
  // The feed web-panel tab (a video embed — the feeds design).
  "video",
  "staging",
  "assets",
  "preview",
  // An interactive shell in the session's workspace. Never persisted
  // (saveActiveViewTab drops it): restoring it on load would spawn a PTY for
  // anyone who once opened one.
  "terminal",
  // A portal target only lives in memory, so this center-panel browser is
  // transient for the same reason as a sub-agent drill-in.
  "portal",
  // A sub-agent drill-in opened from a session's transcript. Transient: its
  // breadcrumb stack only lives in memory, so this one is never persisted
  // (saveActiveViewTab drops it) — a reload would restore an empty tab.
  "subagent",
] as const;

export type ActiveViewTab = (typeof VIEW_TABS)[number] | null;
type ActiveViewTabMap = Record<string, ActiveViewTab>;

function read(): ActiveViewTabMap {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (!value || Array.isArray(value)) return {};
    const tabs: Array<[string, ActiveViewTab]> = [];
    for (const [workspaceId, tab] of Object.entries(value)) {
      switch (tab) {
        case null:
        case "review":
        case "conversation":
        case "video":
        case "staging":
        case "assets":
        case "preview":
        case "terminal":
        case "portal":
        case "subagent":
          tabs.push([workspaceId, tab]);
      }
    }
    return Object.fromEntries(tabs);
  } catch {
    return {};
  }
}

/** `undefined` means the workspace has never had an explicit selection. */
export function getActiveViewTab(
  workspaceId: string,
): ActiveViewTab | undefined {
  return read()[workspaceId];
}

export function saveActiveViewTab(
  workspaceId: string,
  tab: ActiveViewTab,
): void {
  if (!workspaceId) return;
  // Sub-agent tabs are transient — leave the workspace's remembered pane
  // alone rather than restoring a tab whose stack is gone. Terminal is
  // dropped for a stronger reason: restoring it would spawn a PTY on load.
  if (tab === "subagent" || tab === "portal" || tab === "terminal") return;
  const map = read();
  map[workspaceId] = tab;
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* private mode / quota: the in-memory selection still works */
  }
}

/** Workspaces whose remembered selection requires that view tab to be open. */
export function getActiveViewTabKeys(
  tab: Exclude<ActiveViewTab, null>,
): string[] {
  return Object.entries(read())
    .filter(([, selected]) => selected === tab)
    .map(([workspaceId]) => workspaceId);
}
