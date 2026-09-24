import { useState } from "react";
import { useSetupStatus } from "../../hooks/useSetupStatus";
import { shouldReloadAfterGithubAuthEnabled } from "../../lib/github-app-setup";
import { Segmented, SegmentedOption } from "../../ui/segmented";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
} from "../../ui/settings";
import { InlineAlert } from "../../ui/state";
import { toast } from "../../ui/toast";
import { setupRequest, type SetupGithub } from "../setup-shared";
import { SetupRestart } from "../SetupRestart";

function AuthenticationMethod({
  github,
  onSaved,
}: {
  github: SetupGithub;
  onSaved: (updated: SetupGithub, restartRequired: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function select(provider: string) {
    const enabled = provider === "github";
    if (saving || enabled === github.userPrAuth) return;
    setSaving(true);
    setError(null);
    await setupRequest<{
      github: SetupGithub;
      restartRequired: boolean;
    }>("/api/setup/github", {
      method: "PUT",
      json: { userPrAuth: enabled },
    })
      .then((body) => {
        toast(`GitHub sign-in ${enabled ? "enabled" : "disabled"}`);
        onSaved(body.github, body.restartRequired === true);
        if (
          shouldReloadAfterGithubAuthEnabled(
            github.userPrAuth,
            body.github.userPrAuth,
          )
        ) {
          window.location.reload();
        }
      })
      .catch((cause) => {
        const message =
          cause instanceof Error
            ? cause.message
            : "Could not update authentication";
        setError(message);
        toast(message, { variant: "error" });
      });
    setSaving(false);
  }

  return (
    <>
      <SettingCard>
        <div className="flex items-center gap-4 px-5 py-4 phone:flex-col phone:items-stretch phone:px-3">
          <div className="min-w-0 flex-1">
            <div className="text-item-title font-medium text-fg">
              Sign-in method
            </div>
            <div className="mt-0.5 text-supporting leading-relaxed text-dim">
              Anyone who can reach this server can join with GitHub and manage
              the workspace.
            </div>
          </div>
          <Segmented
            label="Sign-in method"
            value={github.userPrAuth ? "github" : "none"}
            onValueChange={(value) => void select(value)}
            className="phone:w-full"
          >
            <SegmentedOption
              value="none"
              disabled={saving}
              className="phone:min-h-11 phone:flex-1 phone:justify-center"
            >
              None
            </SegmentedOption>
            <SegmentedOption
              value="github"
              disabled={saving}
              className="phone:min-h-11 phone:flex-1 phone:justify-center"
            >
              GitHub
            </SegmentedOption>
          </Segmented>
        </div>
      </SettingCard>
      {error && <InlineAlert>{error}</InlineAlert>}
    </>
  );
}

// Organization → Authentication controls only the workspace sign-in gate.
// Provider credentials belong to Organization → Integrations.
export function AuthenticationPanel() {
  const setup = useSetupStatus();
  const { status, failed } = setup;
  return (
    <SettingsPanel className="relative">
      <SettingsHeader
        title="Authentication"
        description="Choose how teammates sign in to this workspace."
      />
      {!status ? (
        failed ? (
          <InlineAlert>
            Couldn&rsquo;t load authentication settings.
          </InlineAlert>
        ) : (
          <SettingCardSkeleton rows={1} label="Loading authentication" />
        )
      ) : (
        <>
          <SettingsGroupLabel>Workspace access</SettingsGroupLabel>
          <AuthenticationMethod
            github={status.github}
            onSaved={setup.applyGithub}
          />
          <SettingsHint>
            Configure the GitHub App and its credentials under Integrations.
          </SettingsHint>
        </>
      )}
      <SetupRestart setup={setup} />
    </SettingsPanel>
  );
}
