/**
 * Connections: MCP servers (incl. per-user restriction), third-party model providers, the Plain triage-router config.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { getAgents } from "../agents-registry";
import { addMcpServer, getConnections, readMcpConfig, removeMcpServer, setMcpAllowedUsers } from "../connections";
import { refreshPickerModels } from "../models";
import { BRIDGE_PROVIDER_IDS, PROVIDER_ID_RE, addPickerModel, defaultPickerModelsForProvider, maskProviderKey, modelProviders, readModelProviderConfig, removeModelProvider, removePickerModel, setModelProvider } from "../model-providers";
import { isPiModelId, piEngineEnabled, readPiEngineConfig, setPiEnabled, setPiPickerModels } from "../pi-config";

/** Navigate `integrations.github` in a raw parsed config object so the App
 *  routes can set or drop its keys without disturbing anything else the file
 *  holds. `create` mints the objects on the way down; otherwise a missing
 *  section returns undefined. */
function githubIntegrationSection(
	config: Record<string, unknown>,
	create: boolean,
): Record<string, unknown> | undefined {
	const asObj = (v: unknown): Record<string, unknown> | undefined =>
		v && typeof v === "object" && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: undefined;
	let integrations = asObj(config.integrations);
	if (!integrations) {
		if (!create) return undefined;
		integrations = {};
		config.integrations = integrations;
	}
	let github = asObj(integrations.github);
	if (!github) {
		if (!create) return undefined;
		github = {};
		integrations.github = github;
	}
	return github;
}

/**
 * Turn a simple-mode device connect into operator mode, inside the ONE request,
 * when the install or app-setup recorded that intent
 * (integrations.github.authOnConnect). Ordering is the whole safety property:
 * the just-authorized GitHub login is rostered as the first admin BEFORE
 * userPrAuth is flipped, and both land in a single atomic config write, so no
 * persisted state ever has the sign-in gate on with nobody able to pass it. A
 * web session for that login is then minted and returned as the auth cookie
 * (mirrors routes/auth.ts), and the intent is cleared so it never re-runs.
 *
 * `login`/`name` are GitHub ground truth from the device-flow poll
 * (github-auth.ts GET /user), never client-supplied. The token itself is already
 * stored by pollGithubDeviceFlow, so after the flip soleGithubAccount() returns
 * null and githubCredentialForLogin(login) — the same store, keyed by login —
 * silently becomes this person's per-user credential; nothing is deleted.
 *
 * The break-glass recovery is untouched: editing config `userPrAuth:false` on the
 * box restores access (opensession.ts), because webAuthRequired() keys on it.
 */
export async function bootstrapUserAuthOnConnect(
	login: string,
	name: string | undefined,
): Promise<{ token: string; cookie: string; name: string } | { error: string }> {
	const { rawTeam } = await import("./setup-team");
	const { rawConfig, persistRawConfig, withConfigMutationLock } = await import(
		"../config-mutation"
	);
	const { createWebSession, webAuthSetCookie } = await import("../web-auth");
	const key = login.trim().toLowerCase();

	const flip = await withConfigMutationLock(
		async (): Promise<{ ok: true } | { error: string }> => {
			const config = rawConfig();
			// (a) Re-check the intent INSIDE the lock. The route checked
			// githubAuthOnConnect() before acquiring it, but a concurrent device
			// poll may have already consumed authOnConnect (rostered its own admin,
			// flipped the gate). Without this the queued second poll would roster a
			// second admin and mint a session against an already-enabled instance.
			const github = githubIntegrationSection(config, true)!;
			if (github.authOnConnect !== true)
				return {
					error: "GitHub sign-in was already enabled by another connection",
				};
			// The token was stored by pollGithubDeviceFlow BEFORE this lock, and
			// simple mode keeps only one account. A concurrent poll that authorized
			// a DIFFERENT account would have replaced the store, so flipping sign-in
			// for `login` now would roster an admin whose token is gone
			// (githubCredentialForLogin(login) would be null). Confirm the stored
			// sole identity still matches before enabling the gate.
			const { soleGithubLogin } = await import("../github-auth");
			if (soleGithubLogin()?.toLowerCase() !== key)
				return {
					error:
						"A different GitHub account connected before setup finished; reconnect to enable sign-in",
				};
			const team = rawTeam(config);
			// (b) roster-upsert the login as admin, matched by github login.
			const existing = team.find(
				(m) => typeof m.github === "string" && m.github.toLowerCase() === key,
			);
			if (existing) {
				existing.github = login;
				existing.admin = true;
				if (typeof existing.name !== "string" || !existing.name.trim())
					existing.name = name?.trim() || login;
			} else {
				team.push({ name: name?.trim() || login, github: login, admin: true });
			}
			(config.identity as Record<string, unknown>).team = team;
			// Preflight: refuse to flip the gate unless a rostered admin github
			// login now exists. Ground-truth login is non-empty so this should
			// always hold — it is the guarantee that step (c) never runs without
			// step (b) having produced a sign-in-capable admin, and it fails closed
			// (no persist) on an empty/unusable login rather than gating the app
			// on a member nobody can sign in as.
			const rostered =
				!!key &&
				team.some(
					(m) =>
						m.admin === true &&
						typeof m.github === "string" &&
						m.github.trim().toLowerCase() === key,
				);
			if (!rostered)
				return {
					error: "Could not roster the connected GitHub account as admin",
				};
			// (c) flip the sign-in gate — atomically with the roster write above.
			github.userPrAuth = true;
			// The process-wide org webhook forwarder needs one stable stored
			// credential after operator mode makes soleGithubAccount() unavailable.
			github.webhookForwardLogin = login;
			// Consumed — clear the intent so a later connect is a plain reconnect.
			delete github.authOnConnect;
			persistRawConfig(config);
			return { ok: true };
		},
	);
	if ("error" in flip) return flip;

	// (d) mint the session for the just-rostered login. getConfig() re-reads on
	// the file change (mtime+size guard), so teamMemberForLogin inside
	// createWebSession sees the fresh roster.
	const session = createWebSession(login);
	if (!session)
		return { error: "Signed in with GitHub but could not create a session" };
	return {
		token: session.token,
		cookie: webAuthSetCookie(session.token),
		name: session.name,
	};
}

async function syncGithubWebhookForwarder(): Promise<void> {
	try {
		const { syncGithubWebhookForwardCredential } = await import(
			"../../agents/github/webhook-forward"
		);
		await syncGithubWebhookForwardCredential();
	} catch (error) {
		// The account mutation succeeded. The old process was stopped before a
		// replacement was attempted, so log startup failures without lying to the UI.
		console.warn("[github-forward] could not synchronize the connected account:", error);
	}
}

export async function handleConnectionsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// ── Connections ──
	if (path === "/api/connections" && req.method === "GET") {
		const force = url.searchParams.get("refresh") === "1";
		const mcpServers = await getConnections(force);
		const agentHealth: Record<string, unknown> = {};
		for (const a of getAgents()) agentHealth[a.name] = a.health();
		return Response.json({
			mcpServers,
			agents: agentHealth,
			engines: piEngineEnabled() ? ["pi"] : [],
		});
	}

	if (path === "/api/connections/mcp" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		if (!body)
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		const result = addMcpServer(body);
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	// ── MCP OAuth (browser flow — src/server/mcp-oauth.ts) ──
	// Callback first: AuthKit-style redirects land here with ?code&state. The
	// signed-in cookie rides along (same-site), so the auth gate passes.
	if (
		path === "/api/connections/mcp-oauth/callback" &&
		req.method === "GET"
	) {
		const code = url.searchParams.get("code") || "";
		const state = url.searchParams.get("state") || "";
		const { connectedPage, connectFailedPage } = await import(
			"../connect-result-page"
		);
		if (!code || !state)
			return connectFailedPage(
				undefined,
				"The redirect came back without a code, so nothing was connected.",
			);
		const { completeMcpOauthFlow, pendingFlowServer } = await import(
			"../mcp-oauth"
		);
		// Read the server name before completing: the flow is consumed either
		// way, and the failure page wants the same brand mark as the success one.
		const server = pendingFlowServer(state);
		try {
			const done = await completeMcpOauthFlow(
				state,
				code,
				ctx.authUser?.login || ctx.authUser?.name || undefined,
			);
			return connectedPage(done.name, done.teamName);
		} catch (e: any) {
			return connectFailedPage(server, e?.message || String(e));
		}
	}

	// The Account list, in one request that never touches the network:
	// which tools offer a personal sign-in, and who is signed in on each. Both
	// answers are local (mcp-config.json + the grant store), so the panel draws
	// its rows immediately instead of waiting on GET /api/connections to probe
	// every configured server just to learn their names. A capability nobody
	// has probed yet comes back null, and `pending` is the client's cue to ask
	// again once the background probe lands.
	if (path === "/api/connections/mcp-oauth" && req.method === "GET") {
		const { cachedOauthCapable, mcpOauthStatus, oauthPresetFor } = await import(
			"../mcp-oauth"
		);
		const servers = Object.entries(readMcpConfig().mcpServers).map(
			([name, cfg]: [string, any]) => {
				const status = mcpOauthStatus(name);
				// An existing grant is proof of capability, and a stronger one than
				// the probe: without this a momentary network failure would drop a
				// tool somebody is signed in to out of their own list.
				const connected = !!status.shared || status.users.length > 0;
				// oauthUrl: a stdio server's HTTP OAuth home (see the per-server
				// route below).
				const oauthTarget = cfg?.url || cfg?.oauthUrl;
				const capable =
					connected || oauthPresetFor(name)
						? true
						: oauthTarget
							? cachedOauthCapable(oauthTarget)
							: false;
				return { name, capable: capable ?? null, ...status };
			},
		);
		return Response.json({
			servers,
			pending: servers.some((s) => s.capable === null),
		});
	}

	// Tool catalog of an HTTP MCP server (New-project tool picker).
	const mcpToolsMatch = path.match(
		/^\/api\/connections\/mcp\/([^/]+)\/tools$/,
	);
	if (mcpToolsMatch && req.method === "GET") {
		try {
			const { listMcpTools } = await import("../mcp-client");
			const tools = await listMcpTools(
				decodeURIComponent(mcpToolsMatch[1]),
				ctx.authUser?.login || ctx.authUser?.name || undefined,
			);
			return Response.json({ tools });
		} catch (e: any) {
			return Response.json(
				{ error: e?.message || String(e) },
				{ status: 502 },
			);
		}
	}

	const mcpOauthMatch = path.match(
		/^\/api\/connections\/mcp\/([^/]+)\/oauth$/,
	);
	if (mcpOauthMatch && req.method === "GET") {
		const { mcpOauthStatus, isOauthCapable, oauthPresetFor } = await import(
			"../mcp-oauth"
		);
		const name = decodeURIComponent(mcpOauthMatch[1]);
		const status = mcpOauthStatus(name);
		const cfg = (await import("../connections")).readMcpConfig().mcpServers[
			name
		] as { url?: string; oauthUrl?: string } | undefined;
		// oauthUrl: a stdio server's HTTP OAuth home (e.g. plain runs a local
		// stdio MCP but per-user grants come from Plain's hosted MCP).
		const oauthTarget = cfg?.url || cfg?.oauthUrl;
		const capable =
			!!oauthPresetFor(name) ||
			(oauthTarget ? await isOauthCapable(oauthTarget) : false);
		return Response.json({ ...status, capable });
	}
	if (mcpOauthMatch && req.method === "DELETE") {
		const { removeMcpOauthGrant } = await import("../mcp-oauth");
		const me = url.searchParams.get("scope") === "me";
		const ok = removeMcpOauthGrant(
			decodeURIComponent(mcpOauthMatch[1]),
			me ? ctx.authUser?.login || ctx.authUser?.name || undefined : undefined,
		);
		return Response.json(ok ? { ok: true } : { error: "No such grant" }, {
			status: ok ? 200 : 404,
		});
	}
	const mcpOauthStartMatch = path.match(
		/^\/api\/connections\/mcp\/([^/]+)\/oauth\/start$/,
	);
	if (mcpOauthStartMatch && req.method === "POST") {
		const name = decodeURIComponent(mcpOauthStartMatch[1]);
		const body = (await req.json().catch(() => ({}))) as { scope?: string };
		const cfg = (await import("../connections")).readMcpConfig().mcpServers[
			name
		] as { url?: string; oauthUrl?: string } | undefined;
		const { startMcpOauthFlow, oauthPresetFor } = await import("../mcp-oauth");
		const oauthTarget = cfg?.url || cfg?.oauthUrl;
		if (!oauthTarget && !oauthPresetFor(name))
			return Response.json(
				{ error: "Not an OAuth-capable MCP server" },
				{ status: 400 },
			);
		try {
			const forUser =
				body.scope === "me"
					? ctx.authUser?.login || ctx.authUser?.name || undefined
					: undefined;
			if (body.scope === "me" && !forUser)
				return Response.json(
					{ error: "Sign in to connect your own account" },
					{ status: 401 },
				);
			const { url: authorizeUrl } = await startMcpOauthFlow(
				name,
				oauthTarget || `stdio://${name}`,
				forUser,
			);
			return Response.json({ url: authorizeUrl });
		} catch (e: any) {
			return Response.json(
				{ error: e?.message || String(e) },
				{ status: 502 },
			);
		}
	}

	const mcpDelMatch = path.match(
		/^\/api\/connections\/mcp\/([^/]+)$/,
	);
	if (mcpDelMatch && req.method === "DELETE") {
		const result = removeMcpServer(decodeURIComponent(mcpDelMatch[1]));
		if ("error" in result) return Response.json(result, { status: 404 });
		return Response.json(result);
	}

	// Restrict an existing MCP server to specific users (or clear the
	// restriction with an empty/absent list).
	if (mcpDelMatch && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		const allowedUsers = Array.isArray(body?.allowedUsers)
			? body.allowedUsers
			: undefined;
		const result = setMcpAllowedUsers(
			decodeURIComponent(mcpDelMatch[1]),
			allowedUsers,
		);
		if ("error" in result) return Response.json(result, { status: 404 });
		return Response.json(result);
	}

	// ── Model providers (Settings → Model providers) ──
	// Third-party Pi providers (xai, openrouter, groq, …): API key +
	// optional baseURL in ~/.opensession-pi.json (0600, keys only ever
	// returned masked), plus their picker model ids. anthropic/openai are
	// rejected — they run on the subscription bridges, not raw keys.
	if (
		path === "/api/settings/model-providers" &&
		req.method === "GET"
	) {
		const pickerModels = readModelProviderConfig()?.pickerModels || [];
		return Response.json({
			providers: Object.entries(modelProviders()).map(([id, p]) => ({
				id,
				apiKeyMasked: maskProviderKey(p.apiKey),
				...(p.baseURL ? { baseURL: p.baseURL } : {}),
				models: pickerModels.filter((m) =>
					m.startsWith(`pi/${id}/`),
				),
			})),
			pickerModels,
		});
	}

	const modelProviderMatch = path.match(
		/^\/api\/settings\/model-providers\/([^/]+)$/,
	);
	if (modelProviderMatch && req.method === "PUT") {
		const id = decodeURIComponent(modelProviderMatch[1]);
		if (!PROVIDER_ID_RE.test(id)) {
			return Response.json(
				{
					error:
						"Provider id must be lowercase letters, digits and dashes (e.g. xai, openrouter)",
				},
				{ status: 400 },
			);
		}
		if (BRIDGE_PROVIDER_IDS.has(id)) {
			return Response.json(
				{
					error: `"${id}" runs on the subscription bridges (Settings → Usage), not a raw API key`,
				},
				{ status: 400 },
			);
		}
		const body = await req.json().catch(() => null);
		if (!body || typeof body !== "object") {
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		}
		const apiKey =
			typeof body.apiKey === "string"
				? // Strip all whitespace — pasted keys often carry line-wrap newlines.
					body.apiKey.replace(/\s+/g, "")
				: undefined;
		const baseURL =
			typeof body.baseURL === "string" ? body.baseURL.trim() : undefined;
		const models = Array.isArray(body.models)
			? body.models.filter(
					(m: unknown): m is string => typeof m === "string",
				)
			: undefined;
		try {
			setModelProvider(id, { apiKey, baseURL });
			const pickerModels = readModelProviderConfig()?.pickerModels || [];
			const providerModels =
				models ??
				(pickerModels.some((m) => m.startsWith(`pi/${id}/`))
					? undefined
					: [...defaultPickerModelsForProvider(id)]);
			if (providerModels) {
				// `models` replaces this provider's picker entries wholesale.
				const prefix = `pi/${id}/`;
				for (const m of pickerModels) {
					if (m.startsWith(prefix)) removePickerModel(m);
				}
				for (const m of providerModels) {
					// Accept "grok-4", "xai/grok-4" or "pi/xai/grok-4".
					let tail = m.trim();
					if (tail.startsWith("pi/"))
						tail = tail.slice("pi/".length);
					if (tail.startsWith(`${id}/`)) tail = tail.slice(id.length + 1);
					if (tail) addPickerModel(`${prefix}${tail}`);
				}
			}
			refreshPickerModels();
			const stored = modelProviders()[id] || {};
			const savedPickerModels = readModelProviderConfig()?.pickerModels || [];
			return Response.json({
				provider: {
					id,
					apiKeyMasked: maskProviderKey(stored.apiKey),
					...(stored.baseURL ? { baseURL: stored.baseURL } : {}),
					models: savedPickerModels.filter((m) =>
						m.startsWith(`pi/${id}/`),
					),
				},
			});
		} catch (e: any) {
			return Response.json(
				{ error: e?.message || "Failed to save provider" },
				{ status: 400 },
			);
		}
	}

	if (modelProviderMatch && req.method === "DELETE") {
		const id = decodeURIComponent(modelProviderMatch[1]);
		try {
			const removed = removeModelProvider(id);
			const prefix = `pi/${id}/`;
			let cleared = 0;
			for (const m of readModelProviderConfig()?.pickerModels || []) {
				if (m.startsWith(prefix)) {
					removePickerModel(m);
					cleared++;
				}
			}
			refreshPickerModels();
			if (!removed && !cleared) {
				return Response.json({ error: "Not found" }, { status: 404 });
			}
			return Response.json({ ok: true });
		} catch (e: any) {
			return Response.json(
				{ error: e?.message || "Failed to remove provider" },
				{ status: 500 },
			);
		}
	}

	// ── Pi engine settings ──


	if (path === "/api/settings/pi-engine" && req.method === "GET") {
		return Response.json(
			readPiEngineConfig() ?? { enabled: false, pickerModels: [] },
		);
	}

	if (path === "/api/settings/pi-engine" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (!body || typeof body !== "object") {
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		}
		if ("enabled" in body && typeof body.enabled !== "boolean") {
			return Response.json(
				{ error: "enabled must be a boolean" },
				{ status: 400 },
			);
		}
		// Each present field replaces its stored value wholesale (mirrors the
		// model-providers `models` semantics). Validate everything before the
		// first write so a bad id can't leave a half-applied update.
		let pickerModels: string[] | undefined;
		if ("pickerModels" in body) {
			if (!Array.isArray(body.pickerModels)) {
				return Response.json(
					{ error: "pickerModels must be an array of model ids" },
					{ status: 400 },
				);
			}
			pickerModels = [];
			for (const m of body.pickerModels) {
				if (typeof m !== "string" || !m.trim()) {
					return Response.json(
						{ error: "pickerModels entries must be non-empty strings" },
						{ status: 400 },
					);
				}
				// Accept "pi/anthropic/claude-opus-5" or the bare
				// "anthropic/claude-opus-5" — normalize onto the pi/ prefix.
				const tail = m.trim();
				const id = tail.startsWith("pi/") ? tail : `pi/${tail}`;
				if (!isPiModelId(id)) {
					return Response.json(
						{
							error: `Invalid pi model id "${tail}" (expected pi/<provider>/<model>)`,
						},
						{ status: 400 },
					);
				}
				if (!pickerModels.includes(id)) pickerModels.push(id);
			}
		}
		try {
			if (typeof body.enabled === "boolean") setPiEnabled(body.enabled);
			// pickerModels is vestigial (the model list is engine-agnostic; every
			// entry routes to pi by prefix) but the write path stays tolerant.
			if (pickerModels) setPiPickerModels(pickerModels);
			return Response.json(
				readPiEngineConfig() ?? { enabled: false, pickerModels: [] },
			);
		} catch (e: any) {
			return Response.json(
				{ error: e?.message || "Failed to save Pi engine config" },
				{ status: 400 },
			);
		}
	}

	// ── GitHub user auth (PRs as the session owner, opt-in via config) ──
	// Device-flow connect per teammate; tokens live server-side (0600) and are
	// never returned here. See src/server/github-auth.ts.
	if (path === "/api/connections/github" && req.method === "GET") {
		const { connectedGithubAccount } = await import("../github-auth");
		const { githubConnectionState } = await import("../github-connection-state");
		const { configuredIdentity } = await import("../config");
		const state = githubConnectionState();
		const { settings, accounts: all, simpleMode } = state;
		const connected = new Set(all.map((a) => a.login.toLowerCase()));
		const stale = new Set(
			all.filter((a) => a.needsReconnect).map((a) => a.login.toLowerCase()),
		);
		const ownLogin = ctx.authUser?.login || "";
		const ownAccount = ownLogin ? connectedGithubAccount(ownLogin) : null;
		// Simple mode (no web sign-in): there is no authUser to scope by, so the
		// card shows the single connected account directly.
		return Response.json({
			enabled: settings.enabled,
			clientIdConfigured: !!settings.clientId,
			connectAvailable: state.connectAvailable,
			appConfigSource: state.appConfigSource,
			webAuthRequired: !simpleMode,
			appInstallUrl: state.appInstallUrl,
			// Captured install/app-setup intent, so the wizard can prefill the org
			// owner and show it is finishing sign-in setup. Inert until a connect
			// consumes authOnConnect.
			appOrg: state.appOrg,
			authOnConnect: state.authOnConnect,
			soleLogin: state.soleLogin,
			accounts: simpleMode ? all : ownAccount ? [ownAccount] : [],
			team: configuredIdentity()
				.team.filter((m) => m.github)
				.map((m) => ({
					name: m.name,
					github: m.github,
					connected: connected.has(m.github!.toLowerCase()),
					needsReconnect: stale.has(m.github!.toLowerCase()),
					canManage:
						!!ownLogin && m.github!.toLowerCase() === ownLogin.toLowerCase(),
				})),
		});
	}

	if (
		path === "/api/connections/github/device" &&
		req.method === "POST"
	) {
		const { startGithubDeviceFlow, githubConnectAvailable } = await import(
			"../github-auth"
		);
		const { webAuthRequired } = await import("../web-auth");
		if (!githubConnectAvailable())
			return Response.json({ error: "GitHub connect is not configured" }, { status: 400 });
		// Operator mode stores the token under the signed-in identity, so it
		// still needs a session. Simple mode has neither session nor authUser —
		// the sole install user connects the one account, and GitHub's /user tells
		// us who that is (identifyAndStoreToken), never the client.
		if (webAuthRequired() && !ctx.authUser?.login)
			return Response.json({ error: "Sign in to connect GitHub" }, { status: 403 });
		const result = await startGithubDeviceFlow();
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	if (
		path === "/api/connections/github/device/poll" &&
		req.method === "POST"
	) {
		const { pollGithubDeviceFlow, githubConnectAvailable } = await import(
			"../github-auth"
		);
		const { webAuthRequired } = await import("../web-auth");
		const simpleMode = !webAuthRequired();
		if (!githubConnectAvailable())
			return Response.json({ error: "GitHub connect is not configured" }, { status: 400 });
		if (webAuthRequired() && !ctx.authUser?.login)
			return Response.json({ error: "Sign in to connect GitHub" }, { status: 403 });
		const body = await req.json().catch(() => null);
		const deviceCode =
			typeof body?.deviceCode === "string" ? body.deviceCode : "";
		if (!deviceCode)
			return Response.json({ error: "deviceCode required" }, { status: 400 });
		// Simple mode passes no expected login (authUser is null): the token is
		// stored under whichever login GitHub reports authorized it.
		const result = await pollGithubDeviceFlow(
			deviceCode,
			ctx.authUser?.login ?? undefined,
		);
		// The auth bootstrap: a simple-mode connect the install/app-setup marked
		// as also turning on sign-in (authOnConnect). This is the first moment a
		// real GitHub login exists to become the admin and hold a session, so it
		// is the only safe moment to flip the gate — never at install, where doing
		// so would lock the operator out. webAuthRequired() is still false here
		// (userPrAuth not yet set); once this runs, later connects are operator
		// mode and take the branch above. authOnConnect absent ⇒ this is skipped
		// and the simple-mode path is byte-identical.
		if (result.status === "ok" && !webAuthRequired()) {
			const { githubAuthOnConnect } = await import("../github-auth");
			if (githubAuthOnConnect()) {
				const boot = await bootstrapUserAuthOnConnect(result.login, result.name);
				if ("error" in boot) {
					await syncGithubWebhookForwarder();
					return Response.json({ status: "error", error: boot.error });
				}
				// Native clients can't hold the HttpOnly cookie — they ask for the
				// token in the body (native:true) and send it back as Bearer.
				const native = body?.native === true;
				await syncGithubWebhookForwarder();
				return Response.json(
					{
						...result,
						// The workspace is now behind sign-in and the browser holds the
						// session cookie; the client reloads to reflect operator mode.
						authEnabled: true,
						admin: true,
						...(native ? { token: boot.token } : {}),
					},
					{ headers: { "Set-Cookie": boot.cookie } },
				);
			}
		}
		if (result.status === "ok" && simpleMode)
			await syncGithubWebhookForwarder();
		return Response.json(result);
	}

	const ghAccountMatch = path.match(
		/^\/api\/connections\/github\/account\/([^/]+)$/,
	);
	if (ghAccountMatch && req.method === "DELETE") {
		const login = decodeURIComponent(ghAccountMatch[1]);
		const { removeGithubAccount, soleGithubLogin } = await import("../github-auth");
		const { webAuthRequired } = await import("../web-auth");
		const simpleMode = !webAuthRequired();
		if (!simpleMode) {
			// Operator mode: you manage only your own signed-in account.
			if (!ctx.authUser?.login || ctx.authUser.login.toLowerCase() !== login.toLowerCase()) {
				return Response.json(
					{ error: "You can only disconnect your own GitHub account" },
					{ status: 403 },
				);
			}
		} else {
			// Simple mode: the only manageable account is the single connected one.
			const sole = soleGithubLogin();
			if (!sole || sole.toLowerCase() !== login.toLowerCase()) {
				return Response.json(
					{ error: "You can only disconnect the connected GitHub account" },
					{ status: 403 },
				);
			}
		}
		const removed = removeGithubAccount(login);
		if (!removed)
			return Response.json({ error: "Not connected" }, { status: 404 });
		// The child keeps a copied process environment. Stop it immediately
		// after every removal so a deleted operator credential cannot keep
		// receiving deliveries until restart or process exit.
		await syncGithubWebhookForwarder();
		return Response.json({ ok: true });
	}

	// ── Bring-your-own GitHub App (simple mode) ──────────────────────────────
	// Persist the App's public client id + slug to config.json so the device
	// flow lights up with no env var and no restart: githubAppIdentity() reads
	// getConfig() per call, and getConfig() re-reads on the file's mtime change.
	// Deliberately never writes userPrAuth — configuring the repo App must not
	// flip the sign-in gate. Gated to simple mode; an env-set App can't be
	// overridden here (env wins), so it is refused with the reason.
	if (path === "/api/connections/github/app" && req.method === "POST") {
		const { webAuthRequired } = await import("../web-auth");
		if (webAuthRequired())
			return Response.json(
				{ error: "Not available while GitHub sign-in is on" },
				{ status: 403 },
			);
		const { githubAppConfigSource } = await import("../github-auth");
		if (githubAppConfigSource() === "env")
			return Response.json(
				{
					error:
						"A GitHub App is set via OPENSESSION_GITHUB_CLIENT_ID; unset it to configure one here",
				},
				{ status: 409 },
			);
		const body = (await req.json().catch(() => null)) as {
			clientId?: unknown;
			slug?: unknown;
			secret?: unknown;
			appOrg?: unknown;
		} | null;
		const clientId =
			typeof body?.clientId === "string" ? body.clientId.trim() : "";
		const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
		const secret = typeof body?.secret === "string" ? body.secret.trim() : "";
		// Present ⇒ the App is owned by an org (owner=Organization); empty/absent ⇒
		// a personal App (single-user).
		const appOrg = typeof body?.appOrg === "string" ? body.appOrg.trim() : "";
		// The secret is required on the UI config path: the device-flow token
		// expires and Open Session refreshes it with the secret, so without one
		// the connection would silently stop working after ~8h. (Env-configured
		// Apps are governed separately and may omit it — an ops choice.)
		if (!clientId || !slug || !secret)
			return Response.json(
				{ error: "clientId, slug and secret are required" },
				{ status: 400 },
			);
		const { rawConfig, persistRawConfig, withConfigMutationLock } =
			await import("../config-mutation");
		return withConfigMutationLock(async () => {
			const config = rawConfig();
			const github = githubIntegrationSection(config, true)!;
			github.oauthClientId = clientId;
			github.appSlug = slug;
			github.oauthClientSecret = secret;
			// An org-owned App also records the intent to turn on per-user sign-in
			// at the first connect; a personal App is single-user, so any stale
			// intent is cleared. Deliberately never writes userPrAuth — the gate is
			// flipped only when someone actually connects (device/poll below), so a
			// box carrying authOnConnect set-but-unconsumed still behaves as simple
			// mode.
			if (appOrg) {
				github.appOrg = appOrg;
				github.authOnConnect = true;
			} else {
				delete github.appOrg;
				delete github.authOnConnect;
				delete github.webhookForwardLogin;
				delete github.webhookForwardLogin;
			}
			persistRawConfig(config);
			return Response.json({ ok: true });
		});
	}

	if (path === "/api/connections/github/app" && req.method === "DELETE") {
		const { webAuthRequired } = await import("../web-auth");
		if (webAuthRequired())
			return Response.json(
				{ error: "Not available while GitHub sign-in is on" },
				{ status: 403 },
			);
		const { githubAppConfigSource } = await import("../github-auth");
		if (githubAppConfigSource() === "env")
			return Response.json(
				{
					error:
						"The GitHub App is set via OPENSESSION_GITHUB_CLIENT_ID; unset the variable and restart to remove it",
				},
				{ status: 409 },
			);
		const { rawConfig, persistRawConfig, withConfigMutationLock } =
			await import("../config-mutation");
		return withConfigMutationLock(async () => {
			const config = rawConfig();
			const github = githubIntegrationSection(config, false);
			if (github) {
				// Drop the repo-App keys and the captured sign-in intent
				// (appOrg/authOnConnect) — removing the App is also how the wizard
				// clears the org intent when the owner is switched back to "You".
				// userPrAuth and anything else the github integration holds survive.
				delete github.oauthClientId;
				delete github.appSlug;
				delete github.oauthClientSecret;
				delete github.appOrg;
				delete github.authOnConnect;
			}
			persistRawConfig(config);
			return Response.json({ ok: true });
		});
	}

	// ── Plain triage router (spam gate + model routing for new tickets) ──
	// The prompt is editable so routing can be tweaked without a deploy;
	// the JSON output contract is appended in code and can't be broken here.
	if (
		path === "/api/connections/plain-router" &&
		req.method === "GET"
	) {
		const { getRouterConfig, DEFAULT_ROUTER_PROMPT, DEFAULT_BASIC_MODEL } =
			await import("../../agents/plain/ticket-router");
		return Response.json({
			...getRouterConfig(),
			defaultPrompt: DEFAULT_ROUTER_PROMPT,
			defaultBasicModel: DEFAULT_BASIC_MODEL,
		});
	}

	if (
		path === "/api/connections/plain-router" &&
		req.method === "PUT"
	) {
		const body = (await req.json().catch(() => null)) as {
			prompt?: string;
			basicModel?: string;
		} | null;
		if (!body)
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		const { setRouterConfig } = await import(
			"../../agents/plain/ticket-router"
		);
		const result = setRouterConfig(body);
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	return undefined;
}
