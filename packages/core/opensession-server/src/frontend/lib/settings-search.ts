/**
 * Search over the Settings nav.
 *
 * Settings is a couple of dozen sections deep and their names are the *place*
 * a setting lives, not the words anyone arrives with: "dark mode" is in
 * Preferences, "cron" in Automations. So each section carries a
 * few aliases — the notable settings inside it plus the words people reach for
 * — and a query matches a section's label, its group, or one of those.
 *
 * Keywords are deliberately hand-written rather than scraped from the panels:
 * a panel's rows are loaded lazily and its copy changes for reasons that have
 * nothing to do with findability, so an index built from them would be both
 * unavailable at nav-render time and noisy. Keep an entry short — the terms
 * someone would type, not a summary of the page.
 */

export const SETTINGS_KEYWORDS = {
  myAccounts: [
    // Your profile lives at the top of this page, so its words have to find
    // it here.
    "profile",
    "avatar",
    "picture",
    "photo",
    "profile picture",
    "my name",
    "change my name",
    "rename",
    "display name",
    "timezone",
    "my email",
    "oauth",
    "sign in",
    "connect account",
    "act as me",
    "personal token",
    "github account",
    // The keychain is a section of this page, so its words have to find it
    // here — nothing else in Settings answers "secrets".
    "keychain",
    "credentials",
    "secrets",
    "grants",
    "access request",
  ],
  preferences: [
    "theme",
    "accent",
    "dark mode",
    "light mode",
    "row density",
    "show in sidebar",
    "default model",
    "code workspace",
    "checkout",
    "worktree",
    "output style",
    "concise",
    "response length",
    "send messages with",
    "enter key",
    "steer",
    "queue",
    "follow-up",
    "next button",
    "next chat",
    "vim mode",
    "pin new sessions",
    "tool calls",
    "transcript",
    "desk voice",
    "personal prompt",
    "standing instructions",
  ],
  notifications: [
    "push",
    "desktop notifications",
    "sound",
    "alerts",
    "needs input",
    "run complete",
  ],
  shortcuts: [
    "keyboard",
    "key bindings",
    "rebind",
    "hotkey",
    "chord",
    "command menu",
    "archive shortcut",
  ],
  general: [
    "workspace name",
    "instance name",
    "branding",
    "product name",
    "agent name",
    "identity",
    "persona",
    "default repo",
  ],
  setup: ["onboarding", "getting started", "checklist", "first run"],
  repos: [
    "repositories",
    "projects",
    "checkout",
    "worktree",
    "branch",
    "clone",
  ],
  members: ["team", "people", "teammates", "access"],
  authentication: [
    "sign in",
    "login",
    "github",
    "oauth",
    "device flow",
    "none",
  ],
  providers: [
    "models",
    "default model",
    "engine",
    "pi",
    "claude accounts",
    "codex",
    "api key",
    "fallback",
    "usage",
    "spend",
    "cost",
    "tokens",
    "credits",
    "limits",
    "quota",
  ],
  runners: ["run hosts", "machines", "workers", "capacity", "detached runs"],
  library: ["templates", "prompts", "skills", "starters", "commands"],
  sandboxes: [
    "docker",
    "daytona",
    "box",
    "ascii",
    "modal",
    "isolation",
    "compute",
  ],
  integrations: [
    "tools",
    "webhooks",
    "credentials",
    "github app",
    "private key",
    "client secret",
  ],
  connections: ["mcp servers", "tools", "agents", "add mcp server"],
  memory: ["facts", "remember", "scopes"],
  automations: ["scheduled", "cron", "triggers", "watchers", "jobs"],
  goals: ["standing goals", "objectives"],
  security: ["scans", "deepsec", "vulnerabilities", "findings"],
  ingress: [
    "webhooks",
    "public",
    "github",
    "plain",
    "cloudflare tunnel",
    "caddy",
    "dns",
    "oidc",
    "workload identity",
  ],
  storage: ["assets", "s3", "r2", "bucket", "object storage", "cloudflare"],
  prewarming: [
    "acceleration",
    "faster starts",
    "dependency cache",
    "preview pool",
    "warm",
    "install",
  ],
  deploys: ["releases", "restart", "version"],
  papercuts: ["friction", "annoyances"],
  audit: ["history", "events", "who did what"],
  downloads: [
    "download",
    "mac app",
    "desktop app",
    "install",
    "pwa",
    "home screen",
    "dmg",
  ],
};

const SETTINGS_KEYWORD_LOOKUP = new Map<string, string[]>(
  Object.entries(SETTINGS_KEYWORDS),
);

export type SectionLike = { key: string; label: string; group: string };

export type SectionHit<T extends SectionLike> = {
  item: T;
  /** The keyword that matched, when the label itself did not — shown under
   *  the row so a result that looks unrelated explains itself. */
  hint?: string;
};

/**
 * Filter sections against a query. An empty query returns everything with no
 * hints, so callers can render one list either way.
 */
export function matchSections<T extends SectionLike>(
  items: T[],
  query: string,
): SectionHit<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.map((item) => ({ item }));
  const hits: SectionHit<T>[] = [];
  for (const item of items) {
    if (
      item.label.toLowerCase().includes(q) ||
      item.group.toLowerCase().includes(q)
    ) {
      hits.push({ item });
      continue;
    }
    const hint = SETTINGS_KEYWORD_LOOKUP.get(item.key)?.find((keyword) =>
      keyword.includes(q),
    );
    if (hint) hits.push({ item, hint });
  }
  return hits;
}
