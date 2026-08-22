/** Slack event delivery as presented in setup. The server selects Socket Mode
 * when SLACK_APP_TOKEN is present and falls back to HTTP otherwise. */
export type SlackTransport = "socket" | "http";

type EnvPresence = { name: string; present: boolean };

/** Preserve an existing transport. Prefer Socket Mode for a new setup because
 * it works on an instance with no public ingress. */
export function savedSlackTransport(
	env: readonly EnvPresence[],
): SlackTransport {
	const present = (name: string) =>
		env.some((item) => item.name === name && item.present);
	if (present("SLACK_APP_TOKEN")) return "socket";
	return present("SLACK_SIGNING_SECRET") ? "http" : "socket";
}

/** Whether Slack can POST to the configured webhook URL. Fresh and simple-mode
 * installs resolve to loopback, which only Socket Mode can use. */
export function publicWebhookAvailable(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname;
		return ![
			"127.0.0.1",
			"localhost",
			"::1",
			"[::1]",
			"0.0.0.0",
			"[::]",
		].includes(host);
	} catch {
		return false;
	}
}

/** Resolve transport-specific requirements from the choice currently shown in
 * the UI, rather than the saved transport represented by the API snapshot. */
export function slackCredentialRequired(
	name: string,
	required: boolean,
	transport: SlackTransport,
): boolean {
	if (name === "SLACK_APP_TOKEN") return transport === "socket";
	if (name === "SLACK_SIGNING_SECRET") return transport === "http";
	return required;
}
