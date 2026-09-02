import { useState } from "react";
import { Button } from "../ui/button";
import { SettingCard, SettingsHint, SettingsSection } from "../ui/settings";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import { GithubManifestSetup } from "./GithubManifestSetup";
export { GithubManifestSetup } from "./GithubManifestSetup";
import { GithubAccounts, queuePersonalGithubConnect } from "./Connections";
import { IntegrationSetupDialog } from "./IntegrationSetupDialog";
import { IconTile } from "./BrandTile";
import {
  StateChip,
  githubAuthState,
  integrationState,
  setupRequest,
  type SetupGithub,
  type SetupIntegration,
} from "./setup-shared";

// The configuration forms behind the integration registry: paste the
// credentials, flip the enable switch, Save, restart. Rendered both as a Setup
// step and as the Workspace → Integrations settings page, so neither surface
// has its own idea of what an integration card looks like.

const INTEGRATION_DESCRIPTIONS = new Map([
  ["plain", "Support threads, internal notes, and triage webhooks."],
  ["linear", "Assigned issues become scoped coding sessions."],
  ["slack", "DMs, mentions, session channels, and interactive controls."],
  ["stripe", "Dispute webhooks routed into scoped automations."],
  ["grafana", "Loki failure signatures routed into investigation automations."],
  ["github", "Respond to PR webhooks, mentions, labels, and review events."],
  [
    "codestorage",
    "Git hosting with branch-based reviews and local signing keys.",
  ],
]);

function IntegrationCard({
  integration,
  onSaved,
  github,
  onGithubSaved,
}: {
  integration: SetupIntegration;
  onSaved: (updated: SetupIntegration, restartRequired: boolean) => void;
  github?: SetupGithub;
  onGithubSaved?: (updated: SetupGithub, restartRequired: boolean) => void;
}) {
  const state = integrationState(integration);
  const stateLabel =
    integration.id === "github"
      ? state.tone === "on"
        ? "Automation on"
        : state.tone === "warn"
          ? "Automation needs setup"
          : "Automation off"
      : state.label;
  const returnedFromGithub =
    integration.id === "github" &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("github_manifest");
  const [setupOpen, setSetupOpen] = useState(returnedFromGithub);
  const [toggling, setToggling] = useState(false);
  const hasCredentials =
    integration.env.some((envVar) => envVar.present) ||
    (integration.id === "github" && Boolean(github?.appCredentialConfigured));
  const canToggle =
    integration.id !== "codestorage" &&
    (integration.enabled || integration.missingRequired.length === 0);

  async function toggle(enabled: boolean) {
    setToggling(true);
    await (async () => {
      const body = await setupRequest<{
        integration: SetupIntegration;
        restartRequired: boolean;
      }>(`/api/setup/integrations/${encodeURIComponent(integration.id)}`, {
        method: "PUT",
        json: { enabled },
      });
      toast(
        `${integration.label}${integration.id === "github" ? " automation" : ""} ${enabled ? "enabled" : "disabled"}`,
      );
      onSaved(body.integration, body.restartRequired !== false);
    })()
      .catch(async (cause) => {
        toast(
          cause instanceof Error
            ? cause.message
            : `Could not update ${integration.label}`,
          {
            variant: "error",
          },
        );
      })
      .finally(async () => {
        setToggling(false);
      });
  }

  return (
    <>
      <SettingCard>
        <div className="flex flex-wrap items-start gap-3 px-5 py-4">
          <IconTile name={integration.id} size={40} />
          <div className="min-w-[14rem] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-item-title font-semibold text-fg">
                {integration.label}
              </div>
              <StateChip tone={state.tone} label={stateLabel} />
            </div>
            <p className="m-0 mt-1 text-supporting leading-relaxed text-dim">
              {INTEGRATION_DESCRIPTIONS.get(integration.id) ??
                `Connect ${integration.label} to Open Session.`}
            </p>
            {integration.enabled && integration.missingRequired.length > 0 && (
              <div className="mt-2 text-meta text-yellow">
                Missing {integration.missingRequired.join(", ")}
              </div>
            )}
          </div>
          <div className="ml-auto flex min-h-10 shrink-0 items-center gap-2">
            {canToggle && (
              <Switch
                checked={integration.enabled}
                onCheckedChange={(enabled) => void toggle(enabled)}
                disabled={toggling}
                aria-label={`${integration.enabled ? "Disable" : "Enable"} ${integration.label}${integration.id === "github" ? " automation" : ""}`}
              />
            )}
            <Button
              size="sm"
              className="max-sm:min-h-10"
              variant={
                !hasCredentials && integration.env.length > 0
                  ? "primary"
                  : "default"
              }
              onClick={() => setSetupOpen(true)}
            >
              {hasCredentials || integration.enabled ? "Configure" : "Set up"}
            </Button>
          </div>
        </div>
      </SettingCard>
      <IntegrationSetupDialog
        integration={integration}
        open={setupOpen}
        onOpenChange={setSetupOpen}
        onSaved={onSaved}
        github={integration.id === "github" ? github : undefined}
        onGithubSaved={onGithubSaved}
        githubManifestSetup={
          integration.id === "github" && github ? (
            <GithubManifestSetup github={github} returnTo="settings" />
          ) : undefined
        }
      />
    </>
  );
}

/** Every integration the registry knows about, as configuration cards. */
export function IntegrationsList({
  integrations,
  onSaved,
  github,
  onGithubSaved,
}: {
  integrations: SetupIntegration[];
  onSaved: (updated: SetupIntegration, restartRequired: boolean) => void;
  github?: SetupGithub;
  onGithubSaved?: (updated: SetupGithub, restartRequired: boolean) => void;
}) {
  const githubOnly =
    integrations.length === 1 && integrations[0]?.id === "github";
  return (
    <>
      <div className="grid gap-3">
        {integrations.map((i) => (
          <IntegrationCard
            key={i.id}
            integration={i}
            onSaved={onSaved}
            github={github}
            onGithubSaved={onGithubSaved}
          />
        ))}
      </div>
      <SettingsHint>
        {githubOnly
          ? "GitHub App setup controls repository access. This switch only controls PR automation, and changes apply after you restart."
          : "Credentials stay on this server and are never shown again. Changes apply after you restart."}
      </SettingsHint>
    </>
  );
}

export function GithubAuthCard({
  github,
  onboarding = false,
  onPersonalSignIn,
  onContentSizeChange,
}: {
  github: SetupGithub;
  onSaved: (updated: SetupGithub, restartRequired: boolean) => void;
  onboarding?: boolean;
  onPersonalSignIn?: () => void;
  onContentSizeChange?: () => void;
}) {
  const state = githubAuthState(github);

  return (
    <div className="grid px-4 phone:px-0">
      <div
        className={onboarding ? "w-full" : "mx-auto mt-3 w-full max-w-[34rem]"}
      >
        <SettingsSection className="flex flex-col gap-5">
          <GithubManifestSetup
            github={github}
            returnTo="welcome"
            onContentSizeChange={onContentSizeChange}
            connectionStatus={
              onboarding
                ? {
                    tone: state.tone,
                    label: state.tone === "on" ? "Connected" : state.label,
                  }
                : undefined
            }
          />
        </SettingsSection>
        {onboarding && github.clientIdConfigured && (
          <div className="mt-6 px-5">
            <div className="mb-3 text-dialog-title font-semibold text-fg">
              Sign in to GitHub
            </div>
            <GithubAccounts
              personal
              showHeading={false}
              showHint={false}
              onConnectRequest={
                onPersonalSignIn
                  ? () => {
                      queuePersonalGithubConnect();
                      onPersonalSignIn();
                    }
                  : undefined
              }
              cardClassName="personal-github-card border-line! bg-button! smooth-shadow-xs"
            />
            <p className="m-0 mt-2 text-supporting text-faint">
              You can also sign in to GitHub later.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
