/**
 * Canonical GitHub connection projection shared by setup and Connections.
 * Request-scoped identity and roster fields stay in the route that owns them.
 */
import {
	connectedGithubAccounts,
	githubAppConfigSource,
	githubAppInstallUrl,
	githubAppOrg,
	githubAuthOnConnect,
	githubConnectAvailable,
	githubUserAuthSettings,
} from "./github-auth";
import { webAuthRequired } from "./web-auth";

export function githubConnectionState() {
	const settings = githubUserAuthSettings();
	const accounts = connectedGithubAccounts();
	const simpleMode = !webAuthRequired();
	const personalAccount =
		simpleMode && accounts.length === 1 ? accounts[0] : null;
	return {
		settings,
		accounts,
		simpleMode,
		personalAccount,
		connectAvailable: githubConnectAvailable(),
		appConfigSource: githubAppConfigSource(),
		appInstallUrl: githubAppInstallUrl(),
		appOrg: githubAppOrg(),
		authOnConnect: githubAuthOnConnect(),
		soleLogin:
			personalAccount && !personalAccount.needsReconnect
				? personalAccount.login
				: null,
	};
}
