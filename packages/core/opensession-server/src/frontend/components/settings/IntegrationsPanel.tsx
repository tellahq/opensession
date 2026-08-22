import { useSetupStatus } from "../../hooks/useSetupStatus";
import {
	SettingCardSkeleton,
	SettingsHeader,
	SettingsPanel,
} from "../../ui/settings";
import { InlineAlert } from "../../ui/state";
import { GithubAccounts } from "../Connections";
import { IntegrationsList } from "../SetupIntegrations";
import { SetupRestart } from "../SetupRestart";

// Workspace → Integrations: the credentials the agent reaches other tools
// with, plus GitHub sign-in. Same cards the Setup wizard shows, including its
// restart banner — a credential saved here needs the same reboot to take
// effect as one saved there.

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
					<SettingCardSkeleton rows={3} icon={40} label="Loading integrations" />
				)
			) : (
				<>
					<IntegrationsList
						integrations={status.integrations}
						onSaved={setup.applyIntegration}
					/>

					<GithubAccounts onChanged={setup.refetch} />
				</>
			)}
			<SetupRestart setup={setup} />
		</SettingsPanel>
	);
}
