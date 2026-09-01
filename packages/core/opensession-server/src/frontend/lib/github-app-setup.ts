export type GithubAppOwnerType = "personal" | "organization";

export interface GithubAppCreateOwner {
  type: GithubAppOwnerType;
  login: string;
}

interface GithubAppSetupOwnerInput {
  appSlug?: string | null;
  clientIdConfigured: boolean;
  appOrg?: string | null;
  appCreateUrl: string;
}

/** Accept only GitHub's HTTPS registration endpoint before a setup response is
 * turned into a top-level form submission. */
export function githubManifestAction(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** Enabling the sign-in gate changes the current page's auth contract. Settings
 * must reload so the root gate can immediately start the device-code flow;
 * onboarding stays on /welcome until its own finish transition. */
export function shouldReloadAfterGithubAuthEnabled(
  previous: boolean,
  next: boolean,
  onboarding = false,
): boolean {
  return !onboarding && !previous && next;
}

/** GitHub's installation picker for an App that has already been created. */
export function githubAppInstallUrlForSlug(
  slug?: string | null,
): string | null {
  const normalized = slug?.trim();
  return normalized
    ? `https://github.com/apps/${encodeURIComponent(normalized)}/installations/new`
    : null;
}

/** Settings page where the owner can manually enable Device Flow. */
export function githubAppSettingsUrlForSlug(
  slug?: string | null,
  organization?: string | null,
): string | null {
  const normalizedSlug = slug?.trim();
  if (!normalizedSlug) return null;
  const normalizedOrganization = organization?.trim();
  return normalizedOrganization
    ? `https://github.com/organizations/${encodeURIComponent(normalizedOrganization)}/settings/apps/${encodeURIComponent(normalizedSlug)}`
    : `https://github.com/settings/apps/${encodeURIComponent(normalizedSlug)}`;
}

/** Read the account choice already encoded in GitHub's new-App URL. */
export function githubAppCreateOwner(value: string): GithubAppCreateOwner {
  try {
    const url = new URL(value);
    const match = url.pathname.match(
      /^\/organizations\/([^/]+)\/settings\/apps\/new$/,
    );
    if (match) {
      return {
        type: "organization",
        login: decodeURIComponent(match[1] || ""),
      };
    }
  } catch {}
  return { type: "personal", login: "" };
}

/** Resolve the actual owner of an existing App independently from the account
 * suggested for creating a new one. An installation owner can be an
 * organization even when the App itself belongs to a personal account. */
export function githubAppSetupOwner(
  github: GithubAppSetupOwnerInput,
): GithubAppOwnerType {
  const appExists = Boolean(
    github.appSlug?.trim() || github.clientIdConfigured,
  );
  if (appExists) return github.appOrg?.trim() ? "organization" : "personal";
  return github.appOrg?.trim()
    ? "organization"
    : githubAppCreateOwner(github.appCreateUrl).type;
}

/** Keep all prefilled App settings while changing who creates the App. */
export function githubAppCreateUrlForOwner(
  value: string,
  type: GithubAppOwnerType,
  login: string,
): string {
  try {
    const url = new URL(value);
    url.pathname =
      type === "organization"
        ? `/organizations/${encodeURIComponent(login.trim())}/settings/apps/new`
        : "/settings/apps/new";
    return url.toString();
  } catch {
    return value;
  }
}
