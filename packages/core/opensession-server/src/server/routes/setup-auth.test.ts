import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleSetupRoutes } from "./setup";
import type { RouteContext } from "./context";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedClientId = process.env.OPENSESSION_GITHUB_CLIENT_ID;
const savedAuthStore = process.env.OPENSESSION_GITHUB_AUTH_STORE;
const dirs: string[] = [];

function context(login: string): RouteContext {
	const url = new URL("http://localhost/api/setup/status");
	return {
		req: new Request(url),
		url,
		path: url.pathname,
		publicPrefix: "",
		authUser: { login, name: login },
	};
}

function roleAwareConfig(): void {
	const dir = mkdtempSync(join(tmpdir(), "opensession-setup-auth-"));
	dirs.push(dir);
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify({
		integrations: { github: { userPrAuth: true, oauthClientId: "test-client" } },
		identity: {
			team: [
				{ name: "Ada", github: "ada", admin: true },
				{ name: "Grace", github: "grace", admin: false },
			],
		},
	}));
	process.env.OPENSESSION_CONFIG = path;
	process.env.OPENSESSION_GITHUB_AUTH_STORE = join(dir, "github-auth.json");
	process.env.OPENSESSION_GITHUB_CLIENT_ID = "test-client";
}

afterEach(() => {
	if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
	else process.env.OPENSESSION_CONFIG = savedConfig;
	if (savedClientId === undefined) delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
	else process.env.OPENSESSION_GITHUB_CLIENT_ID = savedClientId;
	if (savedAuthStore === undefined) delete process.env.OPENSESSION_GITHUB_AUTH_STORE;
	else process.env.OPENSESSION_GITHUB_AUTH_STORE = savedAuthStore;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace setup authorization", () => {
	test("rejects configured non-admin teammates", async () => {
		roleAwareConfig();
		const response = await handleSetupRoutes(context("grace"));
		expect(response?.status).toBe(403);
		expect(await response?.json()).toEqual({
			error: "Workspace administrator access is required",
		});
	});
});

/** A simple-mode config carrying the captured org intent (userPrAuth absent, so
 *  sign-in is off and any caller administers the workspace). */
function orgIntentConfig(): void {
	const dir = mkdtempSync(join(tmpdir(), "opensession-setup-intent-"));
	dirs.push(dir);
	const path = join(dir, "config.json");
	writeFileSync(
		path,
		JSON.stringify({
			integrations: {
				github: { appOrg: "acme-inc", authOnConnect: true },
			},
		}),
	);
	process.env.OPENSESSION_CONFIG = path;
	process.env.OPENSESSION_GITHUB_AUTH_STORE = join(dir, "github-auth.json");
	delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
}

function singleUserConfig(): void {
	const dir = mkdtempSync(join(tmpdir(), "opensession-setup-single-"));
	dirs.push(dir);
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify({ integrations: {} }));
	process.env.OPENSESSION_CONFIG = path;
	process.env.OPENSESSION_GITHUB_AUTH_STORE = join(dir, "github-auth.json");
	delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
}

describe("setup status github snapshot exposes install intent", () => {
	test("appOrg + authOnConnect ride the snapshot", async () => {
		orgIntentConfig();
		const response = await handleSetupRoutes(context("anyone"));
		expect(response?.status).toBe(200);
		const body = await response?.json();
		expect(body.github.appOrg).toBe("acme-inc");
		expect(body.github.authOnConnect).toBe(true);
		// The intent is inert: it must not have flipped the sign-in gate.
		expect(body.github.userPrAuth).toBe(false);
		expect(body.github.webAuthRequired).toBe(false);
		expect(body.github.connectedLogin).toBeNull();
		expect(body.github.needsReconnect).toBe(false);
	});

	test("a single-user install exposes no intent", async () => {
		singleUserConfig();
		const response = await handleSetupRoutes(context("anyone"));
		const body = await response?.json();
		expect(body.github.appOrg).toBe(null);
		expect(body.github.authOnConnect).toBe(false);
		expect(body.github.userPrAuth).toBe(false);
		expect(body.github.webAuthRequired).toBe(false);
		expect(body.github.connectAvailable).toBe(false);
		expect(body.github.connectedLogin).toBeNull();
		expect(body.github.needsReconnect).toBe(false);
	});
});
