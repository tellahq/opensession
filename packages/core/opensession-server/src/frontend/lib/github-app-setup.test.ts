import { describe, expect, test } from "bun:test";
import {
  githubAppCreateOwner,
  githubAppCreateUrlForOwner,
  githubAppInstallUrlForSlug,
  githubAppSettingsUrlForSlug,
  githubAppSetupOwner,
  githubManifestAction,
  shouldReloadAfterGithubAuthEnabled,
} from "./github-app-setup";

describe("GitHub App manifest action", () => {
  test("allows only GitHub's HTTPS registration endpoint", () => {
    expect(
      githubManifestAction(
        "https://github.com/organizations/acme/settings/apps/new?state=one",
      ),
    ).toBe("https://github.com/organizations/acme/settings/apps/new?state=one");
    expect(
      githubManifestAction("http://github.com/settings/apps/new"),
    ).toBeNull();
    expect(
      githubManifestAction("https://github.example/settings/apps/new"),
    ).toBeNull();
    expect(githubManifestAction("not a url")).toBeNull();
  });
});

describe("GitHub App installation URL", () => {
  test("opens the repository installation picker for the configured App", () => {
    expect(githubAppInstallUrlForSlug(" open-session-9lld ")).toBe(
      "https://github.com/apps/open-session-9lld/installations/new",
    );
    expect(githubAppInstallUrlForSlug(null)).toBeNull();
  });
});

describe("GitHub App settings URL", () => {
  test("opens the owner-specific settings page for Device Flow", () => {
    expect(
      githubAppSettingsUrlForSlug(" open-session-9lld ", " acme inc "),
    ).toBe(
      "https://github.com/organizations/acme%20inc/settings/apps/open-session-9lld",
    );
    expect(githubAppSettingsUrlForSlug("open-session-personal")).toBe(
      "https://github.com/settings/apps/open-session-personal",
    );
    expect(githubAppSettingsUrlForSlug(null, "acme")).toBeNull();
  });
});

describe("GitHub authentication transition", () => {
  test("reloads only when settings enable the sign-in gate", () => {
    expect(shouldReloadAfterGithubAuthEnabled(false, true)).toBe(true);
    expect(shouldReloadAfterGithubAuthEnabled(true, true)).toBe(false);
    expect(shouldReloadAfterGithubAuthEnabled(true, false)).toBe(false);
    expect(shouldReloadAfterGithubAuthEnabled(false, true, true)).toBe(false);
  });
});

describe("GitHub App creation owner", () => {
  test("reads an organization from a prefilled creation URL", () => {
    expect(
      githubAppCreateOwner(
        "https://github.com/organizations/acme%20inc/settings/apps/new?name=Open+Session",
      ),
    ).toEqual({ type: "organization", login: "acme inc" });
    expect(
      githubAppCreateOwner(
        "https://github.com/settings/apps/new?name=Open+Session",
      ),
    ).toEqual({ type: "personal", login: "" });
  });

  test("does not confuse a personal App's organization installation with App ownership", () => {
    expect(
      githubAppSetupOwner({
        appSlug: "open-session-uzag",
        clientIdConfigured: true,
        appOrg: null,
        appCreateUrl:
          "https://github.com/organizations/happylinks/settings/apps/new",
      }),
    ).toBe("personal");
    expect(
      githubAppSetupOwner({
        appSlug: null,
        clientIdConfigured: false,
        appOrg: null,
        appCreateUrl:
          "https://github.com/organizations/happylinks/settings/apps/new",
      }),
    ).toBe("organization");
  });

  test("switches account level without dropping prefilled App settings", () => {
    const original =
      "https://github.com/settings/apps/new?name=Open+Session&webhook_url=https%3A%2F%2Fingress.example.test%2Fgithub%2Fwebhook";
    const organization = new URL(
      githubAppCreateUrlForOwner(original, "organization", "acme inc"),
    );
    expect(organization.pathname).toBe(
      "/organizations/acme%20inc/settings/apps/new",
    );
    expect(organization.searchParams.get("name")).toBe("Open Session");
    expect(organization.searchParams.get("webhook_url")).toBe(
      "https://ingress.example.test/github/webhook",
    );

    const personal = new URL(
      githubAppCreateUrlForOwner(
        organization.toString(),
        "personal",
        "ignored",
      ),
    );
    expect(personal.pathname).toBe("/settings/apps/new");
    expect(personal.search).toBe(organization.search);
  });
});
