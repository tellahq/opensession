import { githubAuthState, type SetupStatus } from "../components/setup-shared";
import type { SettingsSectionKey } from "./settings-sections";

export const SETUP_WIDGET_DISMISSED_KEY =
  "opensession:setup-widget-dismissed:v1";
export const SETUP_WIDGET_VISIBLE_ITEM_LIMIT = 3;

export type SetupWidgetTarget = SettingsSectionKey | "new-session";

export interface SetupWidgetItem {
  id:
    | "server"
    | "github"
    | "models"
    | "repository"
    | "domain"
    | "tools"
    | "members"
    | "session";
  label: string;
  detail?: string;
  complete: boolean;
  target: SetupWidgetTarget;
}

function hasDomain(publicBaseUrl: string): boolean {
  try {
    const hostname = new URL(publicBaseUrl).hostname.toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".local"))
      return false;
    if (hostname.includes(":")) return false;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
    return hostname.includes(".");
  } catch {
    return false;
  }
}

export function setupWidgetItems(
  status: SetupStatus,
  hasCreatedSession: boolean,
): SetupWidgetItem[] {
  const connectedTool = status.integrations.some(
    (integration) =>
      integration.id !== "github" &&
      integration.enabled &&
      integration.missingRequired.length === 0,
  );

  return [
    {
      id: "server",
      label: "Create server",
      complete: true,
      target: "runners",
    },
    {
      id: "github",
      label: "Connect GitHub",
      complete: githubAuthState(status.github).tone === "on",
      target: "setup",
    },
    {
      id: "models",
      label: "Add models",
      complete: status.engine.ready,
      target: "providers",
    },
    {
      id: "repository",
      label: "Add repository",
      complete: status.repos.length > 0,
      target: "repos",
    },
    {
      id: "domain",
      label: "Add domain",
      complete: hasDomain(status.access.publicBaseUrl),
      target: "ingress",
    },
    {
      id: "tools",
      label: "Connect tools",
      detail: "Slack, Plain, Figma, Linear and more",
      complete: connectedTool,
      target: "integrations",
    },
    {
      id: "members",
      label: "Invite members",
      complete: status.team.count > 1,
      target: "members",
    },
    {
      id: "session",
      label: "Start your first session",
      complete: hasCreatedSession,
      target: "new-session",
    },
  ];
}

export function visibleSetupWidgetItems(
  items: SetupWidgetItem[],
): SetupWidgetItem[] {
  return items
    .filter((item) => !item.complete)
    .slice(0, SETUP_WIDGET_VISIBLE_ITEM_LIMIT);
}

export function setupWidgetDismissed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(SETUP_WIDGET_DISMISSED_KEY) === "1";
}

export function dismissSetupWidget(): void {
  window.localStorage.setItem(SETUP_WIDGET_DISMISSED_KEY, "1");
}
