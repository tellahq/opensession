import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  py4: {
    paddingBlock: "calc(4px * 4)",
  },
  minW14rem: {
    minWidth: "14rem",
  },
  flex1: {
    flex: "1",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  m0: {
    margin: "0",
  },
  mt1: {
    marginTop: "4px",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  textYellow: {
    color: "var(--yellow)",
  },
  mlAuto: {
    marginLeft: "auto",
  },
  minH10: {
    minHeight: "calc(4px * 10)",
  },
  shrink0: {
    flexShrink: "0",
  },
  maxSmMinH10: {
    "@media (max-width: 39.999rem)": {
      minHeight: "calc(4px * 10)",
    },
  },
  grid: {
    display: "grid",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  phonePx0: {
    "@media (max-width: 720px)": {
      paddingInline: "0",
    },
  },
  flexCol: {
    flexDirection: "column",
  },
  gap5: {
    gap: "calc(4px * 5)",
  },
  mt6: {
    marginTop: "calc(4px * 6)",
  },
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
});

// The configuration forms behind the integration registry: paste the
// credentials, flip the enable switch, Save, restart. Rendered both as a Setup
// step and as the Workspace → Integrations settings page, so neither surface
// has its own idea of what an integration card looks like.

const INTEGRATION_DESCRIPTIONS: Record<string, string> = {
  plain: "Support threads, internal notes, and triage webhooks.",
  linear: "Assigned issues become scoped coding sessions.",
  slack: "DMs, mentions, session channels, and interactive controls.",
  stripe: "Dispute webhooks routed into scoped automations.",
  grafana: "Loki failure signatures routed into investigation automations.",
  github: "Respond to PR webhooks, mentions, labels, and review events.",
  codestorage: "Git hosting with branch-based reviews and local signing keys.",
};

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
        <div
          {...stylex.props(
            sx.flex,
            sx.flexWrap,
            sx.itemsStart,
            sx.gap3,
            sx.px5,
            sx.py4,
          )}
        >
          <IconTile name={integration.id} size={40} />
          <div {...stylex.props(sx.minW14rem, sx.flex1)}>
            <div
              {...stylex.props(sx.flex, sx.flexWrap, sx.itemsCenter, sx.gap2)}
            >
              <div
                {...stylex.props(
                  sx.fontSemibold,
                  sx.textFg,
                  typography.itemTitle,
                )}
              >
                {integration.label}
              </div>
              <StateChip tone={state.tone} label={stateLabel} />
            </div>
            <p
              {...stylex.props(
                sx.m0,
                sx.mt1,
                sx.leadingRelaxed,
                sx.textDim,
                typography.supporting,
              )}
            >
              {INTEGRATION_DESCRIPTIONS[integration.id] ??
                `Connect ${integration.label} to Open Session.`}
            </p>
            {integration.enabled && integration.missingRequired.length > 0 && (
              <div {...stylex.props(sx.mt2, sx.textYellow, typography.meta)}>
                Missing {integration.missingRequired.join(", ")}
              </div>
            )}
          </div>
          <div
            {...stylex.props(
              sx.mlAuto,
              sx.flex,
              sx.minH10,
              sx.shrink0,
              sx.itemsCenter,
              sx.gap2,
            )}
          >
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
              className={mergeStylexOverrideClassName("", sx.maxSmMinH10)}
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
      <div {...stylex.props(sx.grid, sx.gap3)}>
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
    <div {...stylex.props(sx.grid, sx.px4, sx.phonePx0)}>
      <div
        className={
          onboarding
            ? utilityClassName("w-full")
            : utilityClassName("mx-auto mt-3 w-full max-w-[34rem]")
        }
      >
        <SettingsSection
          className={mergeStylexOverrideClassName(
            "",
            sx.flex,
            sx.flexCol,
            sx.gap5,
          )}
        >
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
          <div {...stylex.props(sx.mt6, sx.px5)}>
            <div
              {...stylex.props(
                sx.mb3,
                sx.fontSemibold,
                sx.textFg,
                typography.dialogTitle,
              )}
            >
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
              cardClassName={utilityClassName(
                "personal-github-card border-line! bg-button! smooth-shadow-xs",
              )}
            />
            <p
              {...stylex.props(
                sx.m0,
                sx.mt2,
                sx.textFaint,
                typography.supporting,
              )}
            >
              You can also sign in to GitHub later.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
