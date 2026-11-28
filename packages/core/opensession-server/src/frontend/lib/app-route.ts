import { BASE_PATH, stripBasePath } from "./base";
import type { SettingsSectionKey } from "./settings-sections";
import { assetSuffix, splitSessionRef, subagentSuffix } from "./share-link";

export type Route =
  | { view: "prs" }
  | { view: "issues" }
  | { view: "feed" }
  | { view: "new"; prompt?: string }
  | { view: "session"; id: string; subagent?: string[]; asset?: string }
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
  | { view: "databases"; databaseId?: string; table?: string }
  | { view: "analytics" }
  | { view: "tasks" }
  | { view: "reviews"; id?: string }
  | { view: "supporttinder" }
  | { view: "automations"; id?: string }
  | { view: "security" }
  | { view: "goals"; id?: string }
  | {
      view: "settings";
      section?: SettingsSectionKey;
      /** On the repos section, the repository whose page is open. */
      repo?: string;
    }
  | { view: "archived" }
  | { view: "inbox" }
  | { view: "catchup" }
  | {
      view: "channels";
      id?: string;
      thread?: string;
      /** Threads, Drafts & sent or Search, instead of a conversation. */
      page?: ChannelsPageName;
      /** What Search looks for. */
      query?: string;
    };

/** The Channels place's own pages, which sit above its conversations. */
export type ChannelsPageName = "threads" | "drafts" | "search";

export function isChannelsPage(value: string): value is ChannelsPageName {
  return value === "threads" || value === "drafts" || value === "search";
}

const TOOL_VIEWS = new Set(["automations", "security", "goals"]);
const SETTINGS_SECTIONS: ReadonlySet<string> = new Set<SettingsSectionKey>([
  "myAccounts",
  "keychain",
  "preferences",
  "appearance",
  "notifications",
  "shortcuts",
  "general",
  "repos",
  "members",
  "providers",
  "sandboxes",
  "runners",
  "library",
  "connections",
  "memory",
  "ingress",
  "storage",
  "deploys",
  "papercuts",
  "audit",
]);
const LEGACY_SETTINGS_SECTIONS = new Map<string, SettingsSectionKey>([
  ["model", "providers"],
  ["models", "providers"],
  ["modelProviders", "providers"],
  ["usage", "providers"],
  ["warmPreviews", "repos"],
  ["previewPool", "repos"],
  ["prewarming", "repos"],
  ["workspace", "general"],
  ["setup", "general"],
  ["integrations", "connections"],
  ["personalPrompt", "preferences"],
  ["deskVoice", "preferences"],
  ["composer", "preferences"],
  ["profile", "myAccounts"],
  ["identity", "general"],
  ["authentication", "general"],
  ["downloads", "myAccounts"],
]);

/** The route that shows a Settings section. The tools that live in Settings
 *  (Automations, Goals, Security) are routes of their own, and a link to one
 *  as a plain section would open Settings with nothing in it. */
export function settingsRoute(section?: SettingsSectionKey): Route {
  return section && isToolView(section)
    ? { view: section }
    : { view: "settings", section };
}

export function isToolView(
  view: string,
): view is "automations" | "security" | "goals" {
  return TOOL_VIEWS.has(view);
}

function isSettingsSection(value: string): value is SettingsSectionKey {
  return SETTINGS_SECTIONS.has(value);
}

function sessionRoute(rest: string): Route {
  const { id, subagent, asset } = splitSessionRef(rest);
  const route: Extract<Route, { view: "session" }> = { view: "session", id };
  if (subagent.length) route.subagent = subagent;
  if (asset) route.asset = asset;
  return route;
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
  const databases = path.match(/^\/databases(?:\/([^/]+)(?:\/([^/]+))?)?$/);
  if (databases) {
    const route: Extract<Route, { view: "databases" }> = { view: "databases" };
    if (databases[1]) route.databaseId = decodeURIComponent(databases[1]);
    if (databases[2]) route.table = decodeURIComponent(databases[2]);
    return route;
  }

  const channels = path.match(/^\/channels(?:\/([^/]+)(?:\/([^/]+))?)?$/);
  if (channels) {
    const route: Extract<Route, { view: "channels" }> = { view: "channels" };
    const first = channels[1] ? decodeURIComponent(channels[1]) : undefined;
    if (first === "search") {
      route.page = "search";
      if (channels[2]) route.query = decodeURIComponent(channels[2]);
      return route;
    }
    if (first && isChannelsPage(first) && !channels[2]) route.page = first;
    else if (first) route.id = first;
    if (first && channels[2]) route.thread = decodeURIComponent(channels[2]);
    return route;
  }

  if (path === "/analytics") return { view: "analytics" };
  if (path === "/feed" || path === "/people") return { view: "feed" };
  if (path === "/tasks") return { view: "tasks" };
  if (path === "/issues") return { view: "issues" };
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
    const repoPage = key?.match(/^repos\/(.+)$/);
    if (repoPage)
      return {
        view: "settings",
        section: "repos",
        repo: decodeURIComponent(repoPage[1]!),
      };
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
  if (path === "/inbox") return { view: "inbox" };
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
      return `${BASE_PATH}/session/${encodeURIComponent(route.id)}${subagentSuffix(route.subagent)}${assetSuffix(route.asset)}`;
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
    case "databases":
      return route.databaseId
        ? `${BASE_PATH}/databases/${encodeURIComponent(route.databaseId)}${route.table ? `/${encodeURIComponent(route.table)}` : ""}`
        : `${BASE_PATH}/databases`;
    case "analytics":
      return `${BASE_PATH}/analytics`;
    case "feed":
      return `${BASE_PATH}/feed`;
    case "tasks":
      return `${BASE_PATH}/tasks`;
    case "issues":
      return `${BASE_PATH}/issues`;
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
        ? `${BASE_PATH}/settings/${route.section}${
            route.section === "repos" && route.repo
              ? `/${encodeURIComponent(route.repo)}`
              : ""
          }`
        : `${BASE_PATH}/settings`;
    case "archived":
      return `${BASE_PATH}/archived`;
    case "inbox":
      return `${BASE_PATH}/inbox`;
    case "catchup":
      return `${BASE_PATH}/catchup`;
    case "channels":
      if (route.page === "search" && route.query)
        return `${BASE_PATH}/channels/search/${encodeURIComponent(route.query)}`;
      if (route.page) return `${BASE_PATH}/channels/${route.page}`;
      return route.id
        ? `${BASE_PATH}/channels/${encodeURIComponent(route.id)}${route.thread ? `/${encodeURIComponent(route.thread)}` : ""}`
        : `${BASE_PATH}/channels`;
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

/** The Settings section a route shows, tools included. */
export function settingsSectionOf(
  route: Route,
): SettingsSectionKey | undefined {
  if (route.view === "settings") return route.section;
  return isToolView(route.view) ? route.view : undefined;
}

export function isSettingsRoute(route: Route): boolean {
  return route.view === "settings" || isToolView(route.view);
}

export function samePanel(a: Route, b: Route): boolean {
  if (a.view !== b.view) return false;
  const id = (route: Route) => ("id" in route ? route.id : undefined);
  return id(a) !== undefined && id(a) === id(b);
}
