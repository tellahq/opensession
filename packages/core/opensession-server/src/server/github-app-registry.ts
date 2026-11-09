/**
 * Additional GitHub Apps, one per GitHub account.
 *
 * The setup wizard creates a private GitHub App, and GitHub only lets a
 * private App be installed on the account that owns it. An install that works
 * with repositories under several accounts (an organization and someone's
 * personal account, say) therefore needs one App per account.
 *
 * The App configured by the classic `integrations.github` fields
 * (oauthClientId, appSlug, ...) stays the primary App and keeps serving every
 * owner it always served. `integrations.github.apps` lists further Apps:
 *
 *   "apps": [{
 *     "id": "a1b2c3d4e5f6",          // stable local id, webhook path segment
 *     "owner": "octocat",             // the account the App belongs to
 *     "ownerType": "User",            // or "Organization"
 *     "appSlug": "open-session-octocat",
 *     "oauthClientId": "Iv1....",
 *     "oauthClientSecret": "...",
 *     "webhookSecret": "..."
 *   }]
 *
 * A repository whose owner matches an additional App's `owner` is served by
 * that App; every other repository keeps using the primary App. With no
 * `apps` list nothing changes. Each App's private key lives in
 * `~/.opensession/github-apps/<id>.pem` (0600).
 *
 * This module only reads config, so the token (github-app.ts) and sign-in
 * (github-auth.ts) modules can both import it without a cycle.
 */
import { configuredIntegration } from "./config";
import { stateDir } from "./paths";

export interface AdditionalGithubApp {
  /** Local id: `[a-z0-9-]`, unique, part of the key path and webhook URL. */
  id: string;
  /** GitHub login of the account that owns (and is the only one able to
   *  install) this App. */
  owner: string;
  ownerType: "User" | "Organization" | "";
  slug: string;
  clientId: string;
  clientSecret: string | null;
  webhookSecret: string | null;
}

const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function validAdditionalGithubAppId(id: unknown): id is string {
  return typeof id === "string" && APP_ID.test(id);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Parse one config entry. Incomplete entries are skipped rather than
 *  half-used: an App without a client id or owner cannot mint or be chosen. */
function parseAdditionalGithubApp(raw: unknown): AdditionalGithubApp | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const id = text(entry.id);
  const owner = text(entry.owner);
  const clientId = text(entry.oauthClientId);
  const slug = text(entry.appSlug);
  if (!validAdditionalGithubAppId(id) || !owner || !clientId || !slug)
    return null;
  const ownerType = text(entry.ownerType);
  return {
    id,
    owner,
    ownerType:
      ownerType === "User" || ownerType === "Organization" ? ownerType : "",
    slug,
    clientId,
    clientSecret: text(entry.oauthClientSecret) || null,
    webhookSecret: text(entry.webhookSecret) || null,
  };
}

/** Every well-formed additional App, in config order. A later entry for an
 *  owner (or id) that is already listed is ignored. */
export function additionalGithubApps(): AdditionalGithubApp[] {
  const list = configuredIntegration("github").apps;
  if (!Array.isArray(list)) return [];
  const apps: AdditionalGithubApp[] = [];
  const owners = new Set<string>();
  const ids = new Set<string>();
  for (const raw of list) {
    const app = parseAdditionalGithubApp(raw);
    if (!app) continue;
    const owner = app.owner.toLowerCase();
    if (owners.has(owner) || ids.has(app.id)) continue;
    owners.add(owner);
    ids.add(app.id);
    apps.push(app);
  }
  return apps;
}

/** The additional App that serves repositories under `owner`, or null when
 *  the primary App serves them. */
export function additionalGithubAppForOwner(
  owner: string | null | undefined,
): AdditionalGithubApp | null {
  const wanted = owner?.trim().toLowerCase();
  if (!wanted) return null;
  return (
    additionalGithubApps().find((app) => app.owner.toLowerCase() === wanted) ??
    null
  );
}

export function additionalGithubAppById(
  id: string | null | undefined,
): AdditionalGithubApp | null {
  if (!id) return null;
  return additionalGithubApps().find((app) => app.id === id) ?? null;
}

let keyDirOverride: string | undefined;

/** Test seam: keep key writes away from the operator's real state dir. */
export function __setAdditionalGithubAppKeyDirForTest(
  dir: string | undefined,
): void {
  keyDirOverride = dir;
}

export function additionalGithubAppKeyPath(id: string): string {
  if (!validAdditionalGithubAppId(id))
    throw new Error(`invalid GitHub App id: ${id}`);
  const dir = keyDirOverride || stateDir("github-apps");
  return `${dir}/${id}.pem`;
}

/** Where GitHub delivers an App's webhooks: the classic path for the primary
 *  App, a per-App path for each additional one so its deliveries are checked
 *  against its own secret. */
export function githubWebhookPath(appId?: string | null): string {
  return appId ? `/github/webhook/${appId}` : "/github/webhook";
}

/** The sentence every "no App reaches this owner" failure uses, so a 403
 *  from GitHub turns into something a person can act on. */
export function missingGithubAppMessage(owner: string): string {
  return `No Open Session GitHub App is installed for ${owner}. Add one in Settings → Integrations → GitHub, or install an existing App on ${owner}.`;
}
