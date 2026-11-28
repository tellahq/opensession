import { useSetupStatus } from "../../hooks/useSetupStatus";
import { SettingCardSkeleton, SettingsGroupLabel } from "../../ui/settings";
import { InlineAlert } from "../../ui/state";
import { AppleMobileIntegration } from "../AppleMobileIntegration";
import { IntegrationsList } from "../SetupIntegrations";
import { SetupRestart } from "../SetupRestart";

/** The built-in integrations at the top of Settings → Connections: the
 *  services this instance listens to and acts in, configured with credentials
 *  that stay on the server. */
export function IntegrationsSection() {
  const setup = useSetupStatus();
  const { status, failed } = setup;
  return (
    <div className="relative">
      <SettingsGroupLabel className="mt-0">Apps</SettingsGroupLabel>
      {!status ? (
        failed ? (
          <InlineAlert>Couldn&rsquo;t load the integrations.</InlineAlert>
        ) : (
          <SettingCardSkeleton
            rows={3}
            icon={30}
            label="Loading integrations"
          />
        )
      ) : (
        <IntegrationsList
          integrations={status.integrations}
          onSaved={setup.applyIntegration}
          github={status.github}
          onGithubSaved={setup.applyGithub}
        >
          <AppleMobileIntegration teamNames={status.team.names} />
        </IntegrationsList>
      )}
      <SetupRestart setup={setup} />
    </div>
  );
}
