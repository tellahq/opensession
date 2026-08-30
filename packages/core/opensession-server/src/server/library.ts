/**
 * The library — one browsable catalog over the extension points that are
 * already data.
 *
 * There is no new "plugin" abstraction here, deliberately. Open Session
 * already has several ways to add capability, each with its own store, schema
 * and install path; what it has never had is a front door. Someone landing on
 * a fresh instance sees a sidebar with Home in it and no sense of what else
 * exists (`DEFAULT_VISIBLE_TOOLS` is `["home"]` — every other tool is already
 * opt-in, just undiscoverable).
 *
 * So this module unifies exactly one thing: what a gallery card and an install
 * button need. Everything else stays where it lives.
 *
 *   type          catalogued from                     installing means
 *   ──────────────────────────────────────────────────────────────────────────
 *   tool          CORE_TOOLS below                    a sidebar switch
 *   automation    recipes/automations/*.json          a config seed
 *                 AUTOMATION_TEMPLATES                a pre-filled create form
 *   integration   integrations/registry.ts            credentials + a restart
 *   connection    curated first-party MCP servers     guided setup
 *   package       ~/.opensession-plugins.json         `opensession plugins add`
 *
 * Most entries are derived: adding a recipe file or integration registry
 * entry puts it in the library with no edit here. Core tools and curated
 * first-party connections are the two hand-maintained exceptions because
 * neither has another registry to derive from. Keeping that exception narrow
 * matters: a catalog maintained by hand drifts from the thing it lists, and
 * this repo already has one instance of that drift
 * (recipes/ and automation-templates.ts describe overlapping jobs in two
 * formats; the library shows both and marks how each installs, which is the
 * honest presentation until they are merged).
 *
 * What is NOT here yet, and why:
 *
 * - **Third-party connections.** Connections still has no general catalog.
 *   Curated first-party servers can be listed here once their command, setup,
 *   and permission boundary are maintained in this repository.
 * - **Skills.** `.agents/skills/` and `skills-lock.json` are instance-local
 *   and gitignored, so there is nothing in the repository to catalogue. The
 *   lock file's `{source, sourceType, skillPath, computedHash}` shape is the
 *   right envelope for remote, hash-pinned entries when they arrive.
 * - **Feed projects.** Zero shipped descriptors; feeds are instance data.
 *
 * Packages (adrs/publishable-packages.md) are the one type that is listed
 * only once INSTALLED, because there is no catalog of published ones to read:
 * they are discovered through a GitHub topic and installed from the CLI,
 * which is where the review that gates the install lives. The card is a
 * record of what is here and what it brought, not an install button.
 *
 * The honest caveat about `installed`: for core tools it is `null`, because
 * the server has no truth to report. Tool visibility is localStorage, per
 * browser (`sidebar-tools.ts`), which means today's switch hides the sidebar
 * entry and nothing else — the routes, WebSocket handlers and side effects
 * (Tasks' Slack reminders, Web Push, the Desk payload) run regardless. A
 * server-side gate is what turns that switch from cosmetic into real; until
 * it exists the panel says so rather than implying otherwise.
 *
 * See docs/plugins.md for the design this is the first slice of.
 */

import { listRecipes } from "../../../../../scripts/lib/recipes";
import { AUTOMATION_TEMPLATES } from "./automation-templates";
import { listAutomations } from "./automations";
import { INTEGRATIONS } from "./integrations/registry";
import { isEnabled } from "./integrations/load";
import { listInstalledPackages } from "./plugins";
import { readMcpConfig } from "./connections";

export type LibraryEntryType =
  | "tool"
  | "automation"
  | "integration"
  | "connection"
  | "package";

/**
 * How an entry gets installed — which decides what the card's button does and
 * how much the click is trusted to do on its own.
 */
export type LibraryInstallKind =
  /** Writes a config seed; reversible, no credentials needed. */
  | "one-click"
  /** Pre-fills the create form — the human reviews and saves. */
  | "draft"
  /** Needs credentials and a restart; the card links into Setup. */
  | "guided"
  /** A client-side switch today (see the caveat above). */
  | "client";

export interface LibraryEntry {
  /** Unique across types ("tool:notes"), because slugs collide between them. */
  id: string;
  type: LibraryEntryType;
  /** The per-type id, as its own store knows it. */
  slug: string;
  name: string;
  description: string;
  category: string;
  /** Integration ids that must be enabled before this does anything. */
  requires?: string[];
  install: LibraryInstallKind;
  /** null when the server has no truth to report (core tools). */
  installed: boolean | null;
  /**
   * The prompt an automation entry runs, and how it runs it. Carried on the
   * entry rather than behind a second request because an automation IS a
   * prompt and a trigger, and a catalog row that cannot show what it would
   * send is asking to be trusted blind. The native app prefills its new-session
   * composer from these; the web panel ignores them.
   */
  prompt?: string;
  mode?: "ask" | "code";
  model?: string;
  /** The surface that owns installing/configuring it. */
  href: string;
  source: "builtin" | "repo";
}

/**
 * The first-party tools. Home is deliberately absent: it is the shell rather
 * than a tool, and an instance with it removed has no front page.
 *
 * This is the one hand-written table in the module, because a sidebar tool is
 * not data anywhere yet — it is ~11 hardcoded sites across App.tsx and
 * Sidebar.tsx. Collapsing those into a registry is what would let this table
 * be derived too; docs/plugins.md covers that step.
 */
const CORE_TOOLS: {
  slug: string;
  name: string;
  description: string;
  category: string;
  requires?: string[];
}[] = [
  {
    slug: "tasks",
    name: "Tasks",
    description:
      "A shared task list agents can add to. Reminders arrive in Slack and on your phone.",
    category: "Work",
  },
  {
    slug: "catchup",
    name: "Catch up",
    description: "One pass over everything that moved while you were away.",
    category: "Review",
  },
  {
    slug: "supporttinder",
    name: "Support Tinder",
    description: "Review waiting support tickets one at a time.",
    category: "Review",
    requires: ["plain"],
  },
  {
    slug: "reports",
    name: "Reports",
    description:
      "Reports from scheduled automations, kept so you can see trends.",
    category: "Insight",
  },
  {
    slug: "analytics",
    name: "Analytics",
    description: "Sessions, models, and cost for this instance.",
    category: "Insight",
  },
];

/** Automations already present in the store, by name (what a seed creates). */
function installedAutomationNames(): Set<string> {
  try {
    return new Set(listAutomations().map((a) => a.name));
  } catch {
    // The library is a read-only gallery; a broken automation store should
    // degrade to "nothing looks installed", never to a failed request.
    return new Set();
  }
}

function toolEntries(): LibraryEntry[] {
  return CORE_TOOLS.map((tool) => ({
    id: `tool:${tool.slug}`,
    type: "tool" as const,
    slug: tool.slug,
    name: tool.name,
    description: tool.description,
    category: tool.category,
    ...(tool.requires ? { requires: tool.requires } : {}),
    install: "client" as const,
    installed: null,
    href: `/settings/${tool.slug}`,
    source: "builtin" as const,
  }));
}

function automationEntries(installedNames: Set<string>): LibraryEntry[] {
  const recipes = listRecipes().map((recipe) => ({
    id: `automation:${recipe.id}`,
    type: "automation" as const,
    slug: recipe.id,
    name: recipe.label || recipe.automation.name,
    description: recipe.description,
    category: "Automation",
    ...(recipe.requires?.length ? { requires: recipe.requires } : {}),
    install: "one-click" as const,
    installed: installedNames.has(recipe.automation.name),
    prompt: recipe.automation.prompt,
    ...(recipe.automation.mode ? { mode: recipe.automation.mode } : {}),
    ...(typeof recipe.automation.model === "string"
      ? { model: recipe.automation.model }
      : {}),
    href: "/settings/automations",
    source: "repo" as const,
  }));

  // Templates are starting points rather than finished jobs: they carry a
  // prompt written against a specific repo or product and are meant to be
  // edited before saving, so they install as a draft, not a click.
  const templates = AUTOMATION_TEMPLATES.map((template) => ({
    id: `automation:${template.id}`,
    type: "automation" as const,
    slug: template.id,
    name: template.name,
    description: template.description,
    category: "Automation",
    install: "draft" as const,
    installed: installedNames.has(template.name),
    prompt: template.prompt,
    mode: template.mode,
    href: "/settings/automations",
    source: "builtin" as const,
  }));

  // A recipe and a template can describe the same job (both ship a stale-PR
  // nudge). Prefer the recipe: it installs without editing.
  const seen = new Set(recipes.map((r) => r.slug));
  return [...recipes, ...templates.filter((t) => !seen.has(t.slug))];
}

function integrationEntries(): LibraryEntry[] {
  return INTEGRATIONS.map((spec) => ({
    id: `integration:${spec.id}`,
    type: "integration" as const,
    slug: spec.id,
    name: spec.label,
    description: integrationDescription(spec.id),
    category: "Integration",
    install: "guided" as const,
    installed: spec.always ? true : isEnabled(spec),
    href: "/settings/integrations",
    source: "builtin" as const,
  }));
}

/**
 * One line per integration for the card. The registry itself carries no
 * description — it is a boot-path table, and adding prose to it would put
 * copy in the file whose array order is load order.
 */
function integrationDescription(id: string): string {
  switch (id) {
    case "plain":
      return "Turn support tickets into workspaces with drafted replies.";
    case "linear":
      return "Assign issues to agents the way you would a teammate.";
    case "slack":
      return "Talk to agents in Slack and get answers in the thread.";
    case "stripe":
      return "Read billing context while investigating. Agents can never move money.";
    case "grafana":
      return "Query logs and metrics. Failures can start their own investigation.";
    case "github":
      return "Pull requests, reviews, and checks.";
    case "codestorage":
      return "Store session artifacts on a code.storage host.";
    default:
      return "";
  }
}

/**
 * Installed packages, one card each. A package is a composite: wiring an MCP
 * server, seeding an automation and dropping a skill in one act is what makes
 * this a library rather than four settings pages with a search box, so the
 * card names the package rather than listing its pieces separately.
 */
function connectionEntries(): LibraryEntry[] {
  const servers = readMcpConfig().mcpServers;
  return [
    {
      id: "connection:apple-mobile",
      type: "connection" as const,
      slug: "apple-mobile",
      name: "Apple mobile",
      description:
        "Build Swift apps and prepare approved ad-hoc or TestFlight releases.",
      category: "Developer tools",
      install: "guided" as const,
      installed: Boolean(
        servers["apple-build"] &&
        Array.isArray(servers["apple-release"]?.allowedUsers) &&
        servers["apple-release"].allowedUsers.length,
      ),
      href: "/settings/integrations",
      source: "builtin" as const,
    },
  ];
}

function packageEntries(): LibraryEntry[] {
  try {
    return listInstalledPackages().map((pkg) => ({
      id: `package:${pkg.name}`,
      type: "package" as const,
      slug: pkg.name,
      name: pkg.name,
      description: pkg.description,
      category: "Package",
      install: "guided" as const,
      installed: true,
      href: "/settings/library",
      source: "repo" as const,
    }));
  } catch {
    return [];
  }
}

/** The whole catalog, freshly derived. Cheap enough to skip caching. */
export function listLibrary(): LibraryEntry[] {
  const installedNames = installedAutomationNames();
  return [
    ...toolEntries(),
    ...automationEntries(installedNames),
    ...integrationEntries(),
    ...connectionEntries(),
    ...packageEntries(),
  ];
}
