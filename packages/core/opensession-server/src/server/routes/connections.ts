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
import { refreshOpencodePickerModels } from "../models";
import { BRIDGE_PROVIDER_IDS, PROVIDER_ID_RE, addPickerModel, defaultPickerModelsForProvider, maskProviderKey, opencodeProviders, readOpencodeBridgeConfig, removeOpencodeProvider, removePickerModel, setBridgeEnabled, setOpencodeProvider } from "../opencode-config";
import { isPiModelId, piEngineEnabled, readPiEngineConfig, setPiEnabled, setPiPickerModels } from "../pi-config";

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
			engines: ["opencode", ...(piEngineEnabled() ? ["pi"] : [])],
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
			const initiatedBy =
				ctx.authUser?.login || ctx.authUser?.name || undefined;
			if (!initiatedBy)
				return Response.json(
					{ error: "Sign in before connecting a personal tool" },
					{ status: 401 },
				);
			const forUser =
				body.scope === "me"
					? initiatedBy
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
				initiatedBy,
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
	// Third-party OpenCode providers (xai, openrouter, groq, …): API key +
	// optional baseURL in ~/.opensession-opencode.json (0600, keys only ever
	// returned masked), plus their picker model ids. anthropic/openai are
	// rejected — they run on the subscription bridges, not raw keys.
	if (
		path === "/api/settings/model-providers" &&
		req.method === "GET"
	) {
		const pickerModels = readOpencodeBridgeConfig()?.pickerModels || [];
		return Response.json({
			providers: Object.entries(opencodeProviders()).map(([id, p]) => ({
				id,
				apiKeyMasked: maskProviderKey(p.apiKey),
				...(p.baseURL ? { baseURL: p.baseURL } : {}),
				models: pickerModels.filter((m) =>
					m.startsWith(`opencode/${id}/`),
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
			setOpencodeProvider(id, { apiKey, baseURL });
			const pickerModels = readOpencodeBridgeConfig()?.pickerModels || [];
			const providerModels =
				models ??
				(pickerModels.some((m) => m.startsWith(`opencode/${id}/`))
					? undefined
					: [...defaultPickerModelsForProvider(id)]);
			if (providerModels) {
				// `models` replaces this provider's picker entries wholesale.
				const prefix = `opencode/${id}/`;
				for (const m of pickerModels) {
					if (m.startsWith(prefix)) removePickerModel(m);
				}
				for (const m of providerModels) {
					// Accept "grok-4", "xai/grok-4" or "opencode/xai/grok-4".
					let tail = m.trim();
					if (tail.startsWith("opencode/"))
						tail = tail.slice("opencode/".length);
					if (tail.startsWith(`${id}/`)) tail = tail.slice(id.length + 1);
					if (tail) addPickerModel(`${prefix}${tail}`);
				}
			}
			refreshOpencodePickerModels();
			const stored = opencodeProviders()[id] || {};
			const savedPickerModels = readOpencodeBridgeConfig()?.pickerModels || [];
			return Response.json({
				provider: {
					id,
					apiKeyMasked: maskProviderKey(stored.apiKey),
					...(stored.baseURL ? { baseURL: stored.baseURL } : {}),
					models: savedPickerModels.filter((m) =>
						m.startsWith(`opencode/${id}/`),
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
			const removed = removeOpencodeProvider(id);
			const prefix = `opencode/${id}/`;
			let cleared = 0;
			for (const m of readOpencodeBridgeConfig()?.pickerModels || []) {
				if (m.startsWith(prefix)) {
					removePickerModel(m);
					cleared++;
				}
			}
			refreshOpencodePickerModels();
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

	// ── OpenCode engine on/off (Settings → Setup "Engine" checklist row) ──
	// The `enabled` flag in ~/.opensession-opencode.json gates the Anthropic
	// bridge AND whether third-party provider models reach the picker. Nothing
	// wrote it before this route, so a fresh install had it absent and every
	// default-model turn failed pointing at a file the operator had never seen.
	if (path === "/api/settings/opencode-engine" && req.method === "GET") {
		const { engineStatus } = await import("../engine-status");
		return Response.json(engineStatus());
	}

	if (path === "/api/settings/opencode-engine" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (!body || typeof body !== "object" || typeof body.enabled !== "boolean") {
			return Response.json(
				{ error: "enabled must be a boolean" },
				{ status: 400 },
			);
		}
		try {
			const { setBridgeEnabled } = await import("../opencode-config");
			const { engineStatus } = await import("../engine-status");
			setBridgeEnabled(body.enabled);
			// Enabling is what makes a configured provider's models resolvable,
			// so refresh the picker rather than making the user re-save a provider.
			refreshOpencodePickerModels();
			return Response.json(engineStatus());
		} catch (e: any) {
			return Response.json(
				{ error: e?.message || "Failed to update the engine config" },
				{ status: 500 },
			);
		}
	}

	// ── Pi engine (Settings → Accounts "Pi engine" card) ──
	// The pi engine's on/off switch, picker model ids and designated bridge
	// accounts in ~/.opensession-pi.json. GET returns the raw-file view (not the
	// enabled-gated getters — an editor needs to see the ids while the engine is
	// off); no secrets in this file, so nothing to mask.
	// ── OpenCode engine (the default engine's on/off switch) ──
	if (path === "/api/settings/opencode-engine" && req.method === "GET") {
		return Response.json({
			enabled: readOpencodeBridgeConfig()?.enabled === true,
		});
	}
	if (path === "/api/settings/opencode-engine" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (!body || typeof body.enabled !== "boolean") {
			return Response.json(
				{ error: "enabled must be a boolean" },
				{ status: 400 },
			);
		}
		try {
			setBridgeEnabled(body.enabled);
			// The picker fold gates opencode/* entries on `enabled`.
			refreshOpencodePickerModels();
			return Response.json({
				enabled: readOpencodeBridgeConfig()?.enabled === true,
			});
		} catch (e: any) {
			return Response.json(
				{ error: e?.message || "Failed to save opencode engine config" },
				{ status: 400 },
			);
		}
	}

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
				{ error: e?.message || "Failed to save pi engine config" },
				{ status: 400 },
			);
		}
	}

	// ── GitHub user auth (PRs as the session owner, opt-in via config) ──
	// Device-flow connect per teammate; tokens live server-side (0600) and are
	// never returned here. See src/server/github-auth.ts.
	if (path === "/api/connections/github" && req.method === "GET") {
		const { githubUserAuthSettings, connectedGithubAccount, connectedGithubAccounts } = await import(
			"../github-auth"
		);
		const { configuredIdentity } = await import("../config");
		const settings = githubUserAuthSettings();
		const all = connectedGithubAccounts();
		const connected = new Set(all.map((a) => a.login.toLowerCase()));
		const stale = new Set(
			all.filter((a) => a.needsReconnect).map((a) => a.login.toLowerCase()),
		);
		const ownLogin = ctx.authUser?.login || "";
		const ownAccount = ownLogin ? connectedGithubAccount(ownLogin) : null;
		return Response.json({
			enabled: settings.enabled,
			clientIdConfigured: !!settings.clientId,
			accounts: ownAccount ? [ownAccount] : [],
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
		if (!ctx.authUser?.login)
			return Response.json({ error: "Sign in to connect GitHub" }, { status: 403 });
		const { startGithubDeviceFlow } = await import("../github-auth");
		const result = await startGithubDeviceFlow();
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	if (
		path === "/api/connections/github/device/poll" &&
		req.method === "POST"
	) {
		if (!ctx.authUser?.login)
			return Response.json({ error: "Sign in to connect GitHub" }, { status: 403 });
		const body = await req.json().catch(() => null);
		const deviceCode =
			typeof body?.deviceCode === "string" ? body.deviceCode : "";
		if (!deviceCode)
			return Response.json({ error: "deviceCode required" }, { status: 400 });
		const { pollGithubDeviceFlow } = await import("../github-auth");
		return Response.json(
			await pollGithubDeviceFlow(deviceCode, ctx.authUser.login),
		);
	}

	const ghAccountMatch = path.match(
		/^\/api\/connections\/github\/account\/([^/]+)$/,
	);
	if (ghAccountMatch && req.method === "DELETE") {
		const login = decodeURIComponent(ghAccountMatch[1]);
		if (!ctx.authUser?.login || ctx.authUser.login.toLowerCase() !== login.toLowerCase()) {
			return Response.json(
				{ error: "You can only disconnect your own GitHub account" },
				{ status: 403 },
			);
		}
		const { removeGithubAccount } = await import("../github-auth");
		const removed = removeGithubAccount(login);
		if (!removed)
			return Response.json({ error: "Not connected" }, { status: 404 });
		return Response.json({ ok: true });
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
