/**
 * Product + agent branding for the frontend — the single place the UI gets
 * its names from, so rebranding an instance is a one-line flip here.
 *
 * Server-side equivalents live in src/server/config.ts (productName(),
 * productMark(), personaName(), backed by ~/.opensession/config.json). The
 * frontend has no bootstrap/config API yet, so these are build-time
 * constants; when a config endpoint exists, hydrate them from it and keep
 * these values as the fallbacks.
 *
 * Naming rules:
 * - PRODUCT_NAME is the full wordmark, used in prose, titles, and headers.
 *   It is two words ("Open Session"); the repo, package, env vars, state
 *   dirs, MCP ids and URL prefixes stay one word (`opensession`).
 * - PRODUCT_MARK is the short visual monogram for brand-mark contexts only
 *   (logo chip, favicon, loading screen) — e.g. "OS" for Open Session. Never
 *   use the short mark in code identifiers, package names, or CLI/env names.
 * - These are display strings only. Protocol identifiers (localStorage
 *   `backstage-user`, `/backstage/` routes, `bks-` prefixes) stay literal.
 */

type InstanceBrand = {
  productName?: string;
  productMark?: string;
  personaName?: string;
  publicBaseUrl?: string;
  webhookBaseUrl?: string;
  githubBotLogins?: string[];
  defaultRepoId?: string;
  plainWorkspaceId?: string;
  agentationEnabled?: boolean;
};

const INSTANCE: InstanceBrand =
  typeof window === "undefined"
    ? {}
    : (
        window as typeof window & {
          __OPENSESSION_INSTANCE__?: InstanceBrand;
        }
      ).__OPENSESSION_INSTANCE__ || {};

export const PRODUCT_NAME = INSTANCE.productName || "Open Session";

/** Short brand monogram for visual brand-mark contexts (logo chip, favicon,
 *  loading screen) — never in code identifiers, package names, or CLI/env. */
export const PRODUCT_MARK = INSTANCE.productMark || "OS";

/** The agent's display name (server: personaName(), config persona.name). */
export const AGENT_NAME = INSTANCE.personaName || "Assistant";
export const PUBLIC_BASE_URL =
  INSTANCE.publicBaseUrl ||
  (typeof location === "undefined" ? "http://127.0.0.1:3850" : location.origin);
export const WEBHOOK_BASE_URL = INSTANCE.webhookBaseUrl || PUBLIC_BASE_URL;
export const GITHUB_BOT_LOGINS = new Set(
  (INSTANCE.githubBotLogins || []).map((login) => login.toLowerCase()),
);
/** Primary GitHub bot login (first policy.githubBotLogins entry) for display
 *  fallbacks; empty string when the instance has no bot. */
export const GITHUB_BOT_NAME = (INSTANCE.githubBotLogins || [])[0] || "";
export const DEFAULT_REPO_ID = INSTANCE.defaultRepoId || "opensession";

/** Plain workspace id for deep links into app.plain.com (server:
 *  `integrations.plain.workspaceId`). Null when the instance has none —
 *  consumers hide their "open in Plain" affordances. */
export const PLAIN_WORKSPACE_ID = INSTANCE.plainWorkspaceId || null;

/** Visual page feedback is an operator-only tool, opt-in at server startup. */
export const AGENTATION_ENABLED = INSTANCE.agentationEnabled === true;

/**
 * A session's origin as shown in the UI. `opensession` — and `backstage`, the
 * pre-rename id older servers and archived sessions still carry — both mean
 * "started in this product's own UI", so they display as the product name;
 * every other origin (slack/linear/cli) shows as-is. The ids themselves stay
 * literal on the wire.
 */
export const sessionSourceLabel = (source: string) =>
  source === "opensession" || source === "backstage"
    ? PRODUCT_NAME.toLowerCase()
    : source;

/**
 * The same origin written for prose — a tooltip or a sentence, where the
 * lowercase chip id reads as a typo ("From slack"). Unknown origins fall back
 * to the chip label, which is the id itself.
 */
const SOURCE_NAMES: Record<string, string> = {
  slack: "Slack",
  linear: "Linear",
  cli: "the CLI",
};

export const sessionSourceName = (source: string) =>
  SOURCE_NAMES[source] ?? sessionSourceLabel(source);

/** Default document.title when no view-specific title applies. */
export const DEFAULT_DOC_TITLE = PRODUCT_NAME;

/** "<view> — Open Session" document titles. */
export const docTitle = (view: string) => `${view} · ${PRODUCT_NAME}`;
