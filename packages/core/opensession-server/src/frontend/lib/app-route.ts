import { BASE_PATH, stripBasePath } from "./base";
import type { SettingsSectionKey } from "./settings-sections";
import { splitSessionRef, subagentSuffix } from "./share-link";

export type Route =
  | { view: "prs" }
  | { view: "feed" }
  | { view: "new"; prompt?: string }
  | { view: "session"; id: string; subagent?: string[] }
  | {
      view: "workspace";
      id: string;
      tab?: "review" | "conversation" | "video";
    }
  | { view: "pr"; repo: string; branch: string; number?: number }
  | { view: "pr"; repo: string; branch?: undefined; number: number }
  | { view: "support"; threadId: string }
  | { view: "plain"; threadId?: string }
  | { view: "reports"; automationId?: string; reportId?: string }
  | { view: "analytics" }
  | { view: "tasks" }
  | { view: "reviews"; id?: string }
  | { view: "supporttinder" }
  | { view: "automations"; id?: string }
  | { view: "security" }
  | { view: "goals"; id?: string }
  | { view: "settings"; section?: SettingsSectionKey }
  | { view: "archived" }
  | { view: "catchup" };

const TOOL_VIEWS = new Set(["automations", "security", "goals"]);
const SETTINGS_SECTIONS: ReadonlySet<string> = new Set<SettingsSectionKey>([
  "myAccounts",
  "preferences",
  "notifications",
  "shortcuts",
  "general",
  "setup",
  "repos",
  "members",
  "authentication",
  "providers",
  "sandboxes",
  "runners",
  "library",
  "integrations",
  "connections",
  "memory",
  "ingress",
  "storage",
  "prewarming",
  "deploys",
  "papercuts",
  "audit",
  "downloads",
]);
const LEGACY_SETTINGS_SECTIONS = new Map<string, SettingsSectionKey>([
  ["appearance", "preferences"],
  ["model", "providers"],
  ["models", "providers"],
  ["modelProviders", "providers"],
  ["usage", "providers"],
  ["warmPreviews", "prewarming"],
  ["previewPool", "prewarming"],
  ["workspace", "setup"],
  ["personalPrompt", "preferences"],
  ["deskVoice", "preferences"],
  ["composer", "preferences"],
  ["keychain", "myAccounts"],
  ["profile", "myAccounts"],
  ["identity", "general"],
]);

export function isToolView(
  view: string,
): view is "automations" | "security" | "goals" {
  return TOOL_VIEWS.has(view);
}

function isSettingsSection(value: string): value is SettingsSectionKey {
  return SETTINGS_SECTIONS.has(value);
}

function sessionRoute(rest: string): Route {
  const { id, subagent } = splitSessionRef(rest);
  return subagent.length
    ? { view: "session", id, subagent }
    : { view: "session", id };
}

export function firstMileRequested(pathname: string, search: string): boolean {
  return (
    stripBasePath(pathname) === "/welcome" ||
    new URLSearchParams(search).get("firstmile") === "1"
  );
}

export function parseRoute(pathname: string): Route {
  const path = stripBasePath(pathname);
  const workspaceSession = path.match(/^\/workspace\/[^/]+\/session\/(.+)$/);
  if (workspaceSession) return sessionRoute(workspaceSession[1]!);

  const workspace = path.match(
    /^\/workspace\/([^/]+)(?:\/(review|conversation|video))?$/,
  );
  if (workspace) {
    const tab = workspace[2];
    const route: Extract<Route, { view: "workspace" }> = {
      view: "workspace",
      id: decodeURIComponent(workspace[1]!),
    };
    if (tab === "review" || tab === "conversation" || tab === "video")
      route.tab = tab;
    return route;
  }

  const session = path.match(/^\/session\/(.+)$/);
  if (session) return sessionRoute(session[1]!);

  const pullRequest = path.match(/^\/pr\/([^/]+)\/(.+)$/);
  if (pullRequest) {
    const repo = decodeURIComponent(pullRequest[1]!);
    const ref = decodeURIComponent(pullRequest[2]!);
    return /^\d{1,7}$/.test(ref)
      ? { view: "pr", repo, number: Number(ref) }
      : { view: "pr", repo, branch: ref };
  }

  const support = path.match(/^\/support\/(.+)$/);
  if (support) {
    return { view: "support", threadId: decodeURIComponent(support[1]!) };
  }
  const plain = path.match(/^\/plain(?:\/(.+))?$/);
  if (plain) {
    const route: Extract<Route, { view: "plain" }> = { view: "plain" };
    if (plain[1]) route.threadId = decodeURIComponent(plain[1]);
    return route;
  }
  const reports = path.match(/^\/reports(?:\/([^/]+)(?:\/([^/]+))?)?$/);
  if (reports) {
    const route: Extract<Route, { view: "reports" }> = { view: "reports" };
    if (reports[1]) route.automationId = decodeURIComponent(reports[1]);
    if (reports[2]) route.reportId = decodeURIComponent(reports[2]);
    return route;
  }

  if (path === "/analytics") return { view: "analytics" };
  if (path === "/feed" || path === "/people") return { view: "feed" };
  if (path === "/tasks") return { view: "tasks" };
  if (path === "/new") return { view: "new" };

  const automation = path.match(/^\/automations(?:\/(.+))?$/);
  if (automation) {
    const route: Extract<Route, { view: "automations" }> = {
      view: "automations",
    };
    if (automation[1]) route.id = decodeURIComponent(automation[1]);
    return route;
  }
  if (path === "/security") return { view: "security" };
  const goal = path.match(/^\/goals(?:\/(.+))?$/);
  if (goal) {
    const route: Extract<Route, { view: "goals" }> = { view: "goals" };
    if (goal[1]) route.id = decodeURIComponent(goal[1]);
    return route;
  }
  if (path === "/connections") {
    return { view: "settings", section: "connections" };
  }

  const settings = path.match(/^\/settings(?:\/(.+))?$/);
  if (settings) {
    const key = settings[1];
    if (key && isToolView(key)) return { view: key };
    if (key && isSettingsSection(key)) {
      return { view: "settings", section: key };
    }
    const legacySection = key ? LEGACY_SETTINGS_SECTIONS.get(key) : undefined;
    return legacySection
      ? { view: "settings", section: legacySection }
      : { view: "settings" };
  }

  if (path === "/archived") return { view: "archived" };
  if (path === "/catchup") return { view: "catchup" };
  if (path === "/support-tinder") return { view: "supporttinder" };
  const reviews = path.match(/^\/reviews(?:\/(.+))?$/);
  if (reviews) {
    const route: Extract<Route, { view: "reviews" }> = { view: "reviews" };
    if (reviews[1]) route.id = decodeURIComponent(reviews[1]);
    return route;
  }
  return { view: "prs" };
}

export function routePath(route: Route): string {
  switch (route.view) {
    case "session":
      return `${BASE_PATH}/session/${encodeURIComponent(route.id)}${subagentSuffix(route.subagent)}`;
    case "workspace":
      return `${BASE_PATH}/workspace/${encodeURIComponent(route.id)}${route.tab ? `/${route.tab}` : ""}`;
    case "pr":
      return `${BASE_PATH}/pr/${encodeURIComponent(route.repo)}/${
        route.branch === undefined
          ? route.number
          : encodeURIComponent(route.branch)
      }`;
    case "support":
      return `${BASE_PATH}/support/${encodeURIComponent(route.threadId)}`;
    case "plain":
      return route.threadId
        ? `${BASE_PATH}/plain/${encodeURIComponent(route.threadId)}`
        : `${BASE_PATH}/plain`;
    case "reports":
      return route.automationId
        ? `${BASE_PATH}/reports/${encodeURIComponent(route.automationId)}${route.reportId ? `/${encodeURIComponent(route.reportId)}` : ""}`
        : `${BASE_PATH}/reports`;
    case "analytics":
      return `${BASE_PATH}/analytics`;
    case "feed":
      return `${BASE_PATH}/feed`;
    case "tasks":
      return `${BASE_PATH}/tasks`;
    case "new":
      return route.prompt
        ? `${BASE_PATH}/new?prompt=${encodeURIComponent(route.prompt)}`
        : `${BASE_PATH}/new`;
    case "automations":
      return route.id
        ? `${BASE_PATH}/automations/${encodeURIComponent(route.id)}`
        : `${BASE_PATH}/automations`;
    case "security":
      return `${BASE_PATH}/security`;
    case "goals":
      return route.id
        ? `${BASE_PATH}/goals/${encodeURIComponent(route.id)}`
        : `${BASE_PATH}/goals`;
    case "settings":
      return route.section
        ? `${BASE_PATH}/settings/${route.section}`
        : `${BASE_PATH}/settings`;
    case "archived":
      return `${BASE_PATH}/archived`;
    case "catchup":
      return `${BASE_PATH}/catchup`;
    case "supporttinder":
      return `${BASE_PATH}/support-tinder`;
    case "reviews":
      return route.id
        ? `${BASE_PATH}/reviews/${encodeURIComponent(route.id)}`
        : `${BASE_PATH}/reviews`;
    default:
      return `${BASE_PATH}/`;
  }
}

export function isSettingsRoute(route: Route): boolean {
  return route.view === "settings" || isToolView(route.view);
}

export function samePanel(a: Route, b: Route): boolean {
  if (a.view !== b.view) return false;
  const id = (route: Route) => ("id" in route ? route.id : undefined);
  return id(a) !== undefined && id(a) === id(b);
}
