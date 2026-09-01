import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SetupGithub, SetupIntegration } from "./setup-shared";
import {
  GithubAuthCard,
  GithubManifestSetup,
  IntegrationsList,
} from "./SetupIntegrations";

const integration: SetupIntegration = {
  id: "linear",
  label: "Linear",
  doc: "",
  enabled: false,
  env: [],
  links: [],
  missingRequired: ["LINEAR_API_KEY"],
};

function renderIntegration(enabled: boolean): string {
  return renderToStaticMarkup(
    <IntegrationsList
      integrations={[{ ...integration, enabled }]}
      onSaved={() => {}}
    />,
  );
}

describe("integration credential warnings", () => {
  test("hides missing credentials while the integration is off", () => {
    expect(renderIntegration(false)).not.toContain("Missing LINEAR_API_KEY");
  });

  test("shows missing credentials while the integration is on", () => {
    expect(renderIntegration(true)).toContain("Missing LINEAR_API_KEY");
  });
});

describe("GitHub integration status", () => {
  const githubIntegration: SetupIntegration = {
    id: "github",
    label: "GitHub",
    doc: "",
    enabled: false,
    env: [],
    links: [],
    missingRequired: [],
  };

  test("separates App access from optional PR automation", () => {
    const markup = renderToStaticMarkup(
      <IntegrationsList
        integrations={[githubIntegration]}
        onSaved={() => {}}
      />,
    );
    expect(markup).toContain("Automation off");
    expect(markup).toContain(
      "Respond to PR webhooks, mentions, labels, and review events.",
    );
    expect(markup).toContain(
      "GitHub App setup controls repository access. This switch only controls PR automation",
    );
  });

  test("labels the enabled state as automation", () => {
    const markup = renderToStaticMarkup(
      <IntegrationsList
        integrations={[{ ...githubIntegration, enabled: true }]}
        onSaved={() => {}}
      />,
    );
    expect(markup).toContain("Automation on");
  });
});

const github: SetupGithub = {
  userPrAuth: false,
  clientIdConfigured: false,
  clientSecretConfigured: false,
  mentionHandle: "opensession",
  appCredentialConfigured: false,
  privateKeyConfigured: false,
  appSlug: null,
  installationOwner: "acme",
  appCreateUrl: "https://github.com/organizations/acme/settings/apps/new",
};

function renderGithub(appSlug: string | null): string {
  return renderToStaticMarkup(
    <GithubAuthCard
      github={{ ...github, appSlug }}
      onSaved={() => {}}
      onboarding
    />,
  );
}

describe("GitHub App onboarding actions", () => {
  test("shows clickable setup steps and disables unavailable actions", () => {
    const markup = renderGithub(null);
    expect(markup).toContain("Create GitHub app");
    expect(markup).toContain("Enable Device Flow");
    expect(markup).toContain("Install GitHub app");
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).toContain("Organization ID");
    expect(markup).toContain("<mask");
    expect(markup).toContain('fill="currentColor"');
    expect(markup).toContain('aria-label="Show help for create github app"');
    expect(markup).toContain('aria-label="Show help for enable device flow"');
    expect(markup).toContain('aria-label="Show help for install github app"');
    expect(markup).not.toMatch(/>\d\. /);
  });

  test("links personal App settings independently from its organization installation", () => {
    const markup = renderGithub("open-session-acme");
    expect(markup).toContain(
      'href="https://github.com/settings/apps/open-session-acme"',
    );
    expect(markup).not.toContain(
      "/organizations/acme/settings/apps/open-session-acme",
    );
    expect(markup).toContain("Enable Device Flow");
    expect(markup).toContain(
      'href="https://github.com/apps/open-session-acme/installations/new"',
    );
    expect(markup).toContain("Install GitHub app");
  });

  test("links organization App settings only when appOrg identifies the owner", () => {
    const markup = renderToStaticMarkup(
      <GithubManifestSetup
        github={{ ...github, appSlug: "open-session-acme", appOrg: "acme" }}
        returnTo="welcome"
      />,
    );
    expect(markup).toContain(
      'href="https://github.com/organizations/acme/settings/apps/open-session-acme"',
    );
  });

  test("shows only manifest setup during onboarding", () => {
    const markup = renderGithub(null);
    expect(markup).not.toContain("Use an existing GitHub App");
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain("Client secret");
  });

  test("marks the completed App creation step green", () => {
    const markup = renderToStaticMarkup(
      <GithubAuthCard
        github={{
          ...github,
          appSlug: "open-session-acme",
          clientIdConfigured: true,
        }}
        onSaved={() => {}}
        onboarding
      />,
    );
    expect(markup).toContain('class="text-green"');
    expect(markup).toContain("Install Open Session for GitHub");
    expect(markup).toContain("/mac-app-icon.png");
    expect(markup).toContain("Sign in to GitHub");
    expect(markup).toContain("You can also sign in to GitHub later.");
  });

  test("uses the same manifest-only setup in Settings", () => {
    const markup = renderToStaticMarkup(
      <GithubManifestSetup github={github} returnTo="settings" />,
    );
    expect(markup).toContain("Create GitHub app");
    expect(markup).toContain("Enable Device Flow");
    expect(markup).toContain("Install GitHub app");
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain("Client secret");
  });
});
