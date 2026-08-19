import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import type { UnifiedSession } from "./types";

const scratch = mkdtempSync(join(tmpdir(), "opensession-social-card-"));
const previousStateDir = process.env.OPENSESSION_STATE_DIR;
const previousUiBase = process.env.OPENSESSION_UI_BASE;
const previousCardBase = process.env.OPENSESSION_SESSION_CARD_BASE;
const previousCardSecret = process.env.OPENSESSION_SESSION_CARD_SECRET;
process.env.OPENSESSION_STATE_DIR = scratch;
process.env.OPENSESSION_UI_BASE = "https://os.example.test";
process.env.OPENSESSION_SESSION_CARD_BASE = "https://media.example.test";
process.env.OPENSESSION_SESSION_CARD_SECRET = "test-session-social-card-secret-32-bytes";

const {
	renderSessionSocialCard,
	sessionHtmlWithSocialMeta,
	sessionSocialCardData,
	sessionSocialCardPublicRoutes,
	sessionSocialCardSvg,
	sessionSocialCardUrl,
	fitSocialCardTitle,
	socialSessionIdFromPath,
} = await import("./session-social-card");
const { invalidateSessionsCache } = await import("./session-cache");
const { patchUiPrefs } = await import("./ui-prefs");

const signedRouteSessionId = "slack-C123-1719860000.000000";
const sessionsDir = join(scratch, ".opensession-sessions");
mkdirSync(sessionsDir, { recursive: true });
writeFileSync(
	join(sessionsDir, `${signedRouteSessionId}.json`),
	JSON.stringify({
		id: signedRouteSessionId,
		claudeSessionId: null,
		title: "Signed Slack social card",
		createdBy: "Test Person",
		createdAt: "2026-08-18T12:00:00Z",
		lastActivity: "2026-08-18T12:00:00Z",
		mode: "ask",
	}),
);
invalidateSessionsCache();

afterAll(() => {
	if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
	else process.env.OPENSESSION_STATE_DIR = previousStateDir;
	if (previousUiBase === undefined) delete process.env.OPENSESSION_UI_BASE;
	else process.env.OPENSESSION_UI_BASE = previousUiBase;
	if (previousCardBase === undefined)
		delete process.env.OPENSESSION_SESSION_CARD_BASE;
	else process.env.OPENSESSION_SESSION_CARD_BASE = previousCardBase;
	if (previousCardSecret === undefined)
		delete process.env.OPENSESSION_SESSION_CARD_SECRET;
	else process.env.OPENSESSION_SESSION_CARD_SECRET = previousCardSecret;
	rmSync(scratch, { recursive: true, force: true });
});

function session(patch: Partial<UnifiedSession> = {}): UnifiedSession {
	return {
		id: "sess-social-1",
		title: "Ship dynamic social cards",
		createdBy: "Test Person",
		startedBy: "Test",
		model: "opencode/openai/gpt-5.6-sol",
		repo: "opensession",
		mode: "code",
		lastActivity: "2026-08-18T12:00:00Z",
		...patch,
	} as UnifiedSession;
}

describe("session social card", () => {
	test("normalizes the session fields shown on the card", () => {
		expect(sessionSocialCardData(session())).toMatchObject({
			title: "Ship dynamic social cards",
			owner: "Test Person",
			repo: "opensession",
			model: "gpt-5.6-sol",
			accent: "#1d82bc",
		});
	});

	test("uses the creator's published accent", () => {
		patchUiPrefs("Test Person", { accent: "coral" });
		expect(sessionSocialCardData(session()).accent).toBe("#dd233a");
		patchUiPrefs("Test Person", { accent: null });
	});

	test("uses the model slug for the footer", () => {
		expect(
			sessionSocialCardData(
				session({ model: "workspace-preset/ws-gone/opus-fable" }),
			).model,
		).toBe("opus-fable");
	});

	test("uses the full 1088px title measure before truncating", async () => {
		const fitting = "Make Open Session links feel alive";
		expect(await fitSocialCardTitle(fitting)).toBe(fitting);
		const truncated = await fitSocialCardTitle("W".repeat(80));
		expect(truncated.endsWith("...")).toBe(true);
		expect(truncated.length).toBeLessThan(80);
	});

	test("matches the card geometry and escapes dynamic text", () => {
		const svg = sessionSocialCardSvg({
			title: "Fix <cards> & links",
			owner: 'Test "Person"',
			repo: "opensession",
			model: "gpt-5.6-sol",
			accent: "#dd233a",
		});
		expect(svg).toContain('<rect width="8" height="630" fill="#dd233a"/>');
		expect(svg).toContain('x="56" y="40"');
		expect(svg).toContain('x="56" y="542"');
		expect(svg).toContain('x="1144" y="542"');
		expect(svg).toContain('stop-opacity="0.08"');
		expect(svg).toContain("M68.8375 226.509C-37.3322 147.543");
		expect(svg).toContain("Fix &lt;cards&gt; &amp; links");
		expect(svg).not.toContain("Fix <cards>");
	});

	test("renders a 1200 by 630 PNG", async () => {
		const png = await renderSessionSocialCard(sessionSocialCardData(session()));
		expect(png).not.toBeNull();
		const metadata = await sharp(png!).metadata();
		expect(metadata.format).toBe("png");
		expect(metadata.width).toBe(1200);
		expect(metadata.height).toBe(630);
	});

	test("injects large-image metadata into the session HTML", () => {
		const source = `<head>
<title>Open Session</title>
<meta property="og:type" content="website" />
<meta property="og:title" content="Open Session" />
<meta property="og:image" content="/icon.png" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="Open Session" />
<meta name="twitter:image" content="/icon.png" />
</head>`;
		const output = sessionHtmlWithSocialMeta(
			source,
			session(),
			"/session/sess-social-1",
		);
		expect(output).toContain("<title>Ship dynamic social cards · Open Session</title>");
		expect(output).toContain('content="summary_large_image"');
		expect(output).toMatch(
			/content="https:\/\/media\.example\.test\/session-card\/sess-social-1\/[A-Za-z0-9_-]{32}\.png\?v=3"/,
		);
		expect(output).toContain(
			'property="og:url" content="https://os.example.test/session/sess-social-1"',
		);
	});

	test("parses both session link shapes", () => {
		expect(socialSessionIdFromPath("/session/sess-social-1")).toBe("sess-social-1");
		expect(
			socialSessionIdFromPath("/workspace/ws-1/session/sess-social-1"),
		).toBe("sess-social-1");
		expect(socialSessionIdFromPath("/settings")).toBeNull();
		expect(sessionSocialCardUrl("sess-social-1")).toMatch(
			/^https:\/\/media\.example\.test\/session-card\/sess-social-1\/[A-Za-z0-9_-]{32}\.png\?v=3$/,
		);
	});

	test("signs ids containing Slack timestamp dots", () => {
		expect(sessionSocialCardUrl("slack-C123-1719860000.000000")).toMatch(
			/^https:\/\/media\.example\.test\/session-card\/slack-C123-1719860000\.000000\/[A-Za-z0-9_-]{32}\.png\?v=3$/,
		);
	});

	test("public image routes reject malformed capability paths", async () => {
		const route = sessionSocialCardPublicRoutes().get("GET /session-card/*");
		expect(route).toBeDefined();
		const response = await route!(
			new Request("https://media.example.test/session-card/not-valid.svg"),
			new URL("https://media.example.test/session-card/not-valid.svg"),
		);
		expect(response.status).toBe(404);
	});

	test("serves a signed Slack-style session id", async () => {
		const route = sessionSocialCardPublicRoutes().get("GET /session-card/*")!;
		const url = new URL(sessionSocialCardUrl(signedRouteSessionId));
		const response = await route(new Request(url), url);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		const metadata = await sharp(await response.arrayBuffer()).metadata();
		expect(metadata.width).toBe(1200);
		expect(metadata.height).toBe(630);
	});

	test("rejects an invalid HMAC before resolving the session", async () => {
		const route = sessionSocialCardPublicRoutes().get("GET /session-card/*")!;
		const valid = new URL(sessionSocialCardUrl(signedRouteSessionId));
		const invalid = new URL(
			valid.href.replace(
				/[A-Za-z0-9_-]{32}\.png(?=\?)/,
				`${"A".repeat(32)}.png`,
			),
		);
		const response = await route(new Request(invalid), invalid);
		expect(response.status).toBe(404);
	});
});
