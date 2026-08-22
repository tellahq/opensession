import { expect, test } from "bun:test";
import { githubAuthState, type SetupGithub } from "./setup-shared";

function github(overrides: Partial<SetupGithub> = {}): SetupGithub {
	return {
		userPrAuth: false,
		clientIdConfigured: false,
		connectAvailable: false,
		webAuthRequired: false,
		connectedLogin: null,
		needsReconnect: false,
		appOrg: null,
		authOnConnect: false,
		...overrides,
	};
}

test("GitHub onboarding state follows connection truth", () => {
	expect(githubAuthState(github())).toEqual({ tone: "off", label: "Not connected" });
	expect(githubAuthState(github({ connectAvailable: true }))).toEqual({
		tone: "warn",
		label: "Ready to connect",
	});
	expect(githubAuthState(github({ connectedLogin: "kent" }))).toEqual({
		tone: "on",
		label: "Connected",
	});
	expect(
		githubAuthState(github({ connectedLogin: "kent", needsReconnect: true })),
	).toEqual({ tone: "warn", label: "Reconnect needed" });
	expect(
		githubAuthState(
			github({ webAuthRequired: true, userPrAuth: true, clientIdConfigured: true }),
		),
	).toEqual({ tone: "on", label: "Active" });
});
