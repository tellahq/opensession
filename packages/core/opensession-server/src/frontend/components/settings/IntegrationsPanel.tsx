import { useSetupStatus } from "../../hooks/useSetupStatus";
import {
  SettingCardSkeleton,
  SettingsHeader,
  SettingsPanel,
} from "../../ui/settings";
import { InlineAlert } from "../../ui/state";
import { IntegrationsList } from "../SetupIntegrations";
import { SetupRestart } from "../SetupRestart";
import { AppleMobileIntegration } from "../AppleMobileIntegration";

// Organization → Integrations: credentials used by tools and automation.
// Workspace authentication lives on its own page beside Members.

export function IntegrationsPanel() {
  const setup = useSetupStatus();
  const { status, failed } = setup;
  return (
    <SettingsPanel className="relative">
      <SettingsHeader title="Integrations" />
      {!status ? (
        // A failure is an alert, not a quiet label under a spinner: it used
        // to render in the loading register, so the sentence saying the
        // page had given up sat beside a mark saying it was still trying.
        failed ? (
          <InlineAlert>Couldn&rsquo;t load the integrations.</InlineAlert>
        ) : (
          // One plate of rows rather than one plate per integration. The
          // cards land as separate blocks, but repeating a single-row ghost
          // draws a column of identical shapes, and that reads as a
          // component stuck mid-render rather than as rows on their way.
          <SettingCardSkeleton
            rows={3}
            icon={40}
            label="Loading integrations"
          />
        )
      ) : (
        <IntegrationsList
          integrations={status.integrations}
          onSaved={setup.applyIntegration}
          github={status.github}
          onGithubSaved={setup.applyGithub}
        />
      )}
      <div className="mt-3">
        <AppleMobileIntegration teamNames={status?.team.names ?? []} />
      </div>
      <SetupRestart setup={setup} />
    </SettingsPanel>
  );
}
