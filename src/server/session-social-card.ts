/**
 * Dynamic social card for session links.
 *
 * The UI normally lives on a private host, so Slack cannot crawl its Open Graph
 * metadata. The same renderer is therefore available on the public webhook
 * origin and is also linked from the session page for clients that can crawl it.
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { chmodSync, readFileSync, writeFileSync } from "fs";
import {
	DEFAULT_ACCENT_THEME,
	getAccentThemeOption,
	isAccentTheme,
} from "../shared/accent-theme";
import {
	configuredIntegration,
	configuredServer,
	productName,
} from "./config";
import { teamDirectory, type DirectoryPerson } from "./people";
import { stateDir } from "./paths";
import { findSession } from "./session-cache";
import type { UnifiedSession } from "./types";
import { getUiPrefs } from "./ui-prefs";

/**
 * sharp is loaded lazily and treated as optional. Its platform `@img/sharp-*`
 * native cannot be embedded into a `bun build --compile` executable (it's
 * resolved at runtime, not bundled), so the top-level import would crash boot
 * there. Load it on first use instead: when it (or its native) is missing, the
 * PNG social-card endpoint degrades to a 501 and the Open Graph meta tags still
 * emit — the server boots and serves the UI either way.
 */
type SharpFactory = typeof import("sharp");
let sharpFactory: SharpFactory | null | undefined; // undefined = not tried yet

async function loadSharp(): Promise<SharpFactory | null> {
	if (sharpFactory !== undefined) return sharpFactory;
	try {
		const mod = await import("sharp");
		// sharp ships as `export = sharp` (a callable). esModuleInterop surfaces
		// it on `.default`; fall back to the namespace for non-interop resolvers.
		sharpFactory = ((mod as { default?: SharpFactory }).default ?? mod) as SharpFactory;
	} catch (e) {
		console.warn(
			"[social-card] sharp unavailable — PNG social cards disabled (Open Graph tags still emit):",
			e instanceof Error ? e.message : e,
		);
		sharpFactory = null;
	}
	return sharpFactory;
}

export const SESSION_CARD_WIDTH = 1200;
export const SESSION_CARD_HEIGHT = 630;
const SESSION_CARD_VERSION = 3;
const TITLE_MAX_WIDTH = 1088;
const TITLE_FONT = "Inter SemiBold 56";
const TITLE_LETTER_SPACING = -2 * 1024;

export interface SessionSocialCardData {
	title: string;
	owner: string;
	repo?: string;
	model?: string;
	person?: DirectoryPerson;
	accent: string;
}

function clean(value: string | null | undefined): string {
	return (value || "").replace(/\s+/g, " ").trim();
}

function samePerson(person: DirectoryPerson, ref: string): boolean {
	const key = ref.trim().replace(/^@/, "").toLowerCase();
	return [person.name, person.fullName, person.github]
		.filter(Boolean)
		.some((value) => value!.toLowerCase() === key);
}

export function sessionCardTitle(
	session: UnifiedSession,
): { title: string } {
	const sessionTitle = clean(session.title) || session.id;
	return { title: sessionTitle };
}

function sessionModelLabel(session: UnifiedSession): string | undefined {
	if (!session.model) return undefined;
	return session.model.split("/").filter(Boolean).at(-1);
}

export function sessionSocialCardData(
	session: UnifiedSession,
): SessionSocialCardData {
	const heading = sessionCardTitle(session);
	const ownerRef = clean(session.createdBy || session.startedBy) || productName();
	const person = teamDirectory().find((candidate) => samePerson(candidate, ownerRef));
	const model = sessionModelLabel(session);
	const savedAccent = getUiPrefs(person?.name || ownerRef).accent;
	const accentTheme = isAccentTheme(savedAccent)
		? savedAccent
		: DEFAULT_ACCENT_THEME;
	return {
		title: heading.title,
		owner: person?.fullName || ownerRef,
		...(session.repo ? { repo: session.repo } : {}),
		...(model ? { model } : {}),
		...(person ? { person } : {}),
		accent: getAccentThemeOption(accentTheme).light,
	};
}

function xml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function html(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function initials(name: string): string {
	return name
		.split(/\s+/)
		.slice(0, 2)
		.map((part) => part[0] || "")
		.join("")
		.toUpperCase();
}

async function titleWidth(sharp: SharpFactory, title: string): Promise<number> {
	const metadata = await sharp({
		text: {
			text: `<span letter_spacing="${TITLE_LETTER_SPACING}">${xml(title)}</span>`,
			font: TITLE_FONT,
			rgba: true,
			dpi: 72,
		},
	}).metadata();
	return metadata.width ?? 0;
}

/** Fit one 56 px Inter Semi Bold line inside the card's 1088 px measure.
 *  Without sharp the title can't be measured, so it's returned untrimmed. */
export async function fitSocialCardTitle(title: string): Promise<string> {
	const value = clean(title) || productName();
	const sharp = await loadSharp();
	if (!sharp) return value;
	if ((await titleWidth(sharp, value)) <= TITLE_MAX_WIDTH) return value;

	const characters = Array.from(value);
	let low = 1;
	let high = characters.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const candidate = `${characters.slice(0, middle).join("").trimEnd()}...`;
		if ((await titleWidth(sharp, candidate)) <= TITLE_MAX_WIDTH) low = middle;
		else high = middle - 1;
	}
	return `${characters.slice(0, low).join("").trimEnd()}...`;
}

const avatarCache = new Map<string, string>();
const AVATAR_CACHE_LIMIT = 100;

function rememberAvatar(key: string, data: string): void {
	avatarCache.delete(key);
	avatarCache.set(key, data);
	if (avatarCache.size <= AVATAR_CACHE_LIMIT) return;
	const oldest = avatarCache.keys().next().value;
	if (oldest) avatarCache.delete(oldest);
}

async function compactAvatar(bytes: ArrayBuffer): Promise<string> {
	const sharp = await loadSharp();
	if (!sharp) return "";
	const png = await sharp(Buffer.from(bytes), { limitInputPixels: 16_000_000 })
		.resize(160, 160, { fit: "cover" })
		.png()
		.toBuffer();
	return `data:image/png;base64,${png.toString("base64")}`;
}

async function avatarDataUrl(person?: DirectoryPerson): Promise<string> {
	if (!person) return "";
	const cacheKey = person.image || person.github || "";
	if (!cacheKey) return "";
	const cached = avatarCache.get(cacheKey);
	if (cached) return cached;
	try {
		if (person.image) {
			const mediaUrl = new URL(person.image, "http://local");
			const path = mediaUrl.searchParams.get("path");
			if (path) {
				const data = await compactAvatar(await Bun.file(path).arrayBuffer());
				rememberAvatar(cacheKey, data);
				return data;
			}
		}
		if (person.github) {
			const response = await fetch(`https://github.com/${encodeURIComponent(person.github)}.png?size=160`, {
				signal: AbortSignal.timeout(5_000),
			});
			if (response.ok) {
				const data = await compactAvatar(await response.arrayBuffer());
				rememberAvatar(cacheKey, data);
				return data;
			}
		}
	} catch {}
	return "";
}

function footerLabel(value: string): string {
	return value.length > 28 ? `${value.slice(0, 27).trimEnd()}…` : value;
}

/** SVG source is exported so the visual can be inspected without PNG decoding. */
export function sessionSocialCardSvg(
	data: SessionSocialCardData,
	avatar = "",
	jetBrainsMono = "",
	displayTitle = clean(data.title) || productName(),
): string {
	const repo = footerLabel(clean(data.repo));
	const model = footerLabel(clean(data.model));
	const avatarMarkup = avatar
		? `<image href="${avatar}" x="56" y="123" width="48" height="48" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>`
		: `<rect x="56" y="123" width="48" height="48" rx="8" fill="${xml(data.accent)}"/><text x="80" y="148" text-anchor="middle" dominant-baseline="middle" fill="#FFFFFF" font-size="18" font-weight="600">${xml(initials(data.owner))}</text>`;
	const fontFace = jetBrainsMono
		? `<style>@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 500; src: url('${jetBrainsMono}') format('truetype'); }</style>`
		: "";

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${SESSION_CARD_WIDTH}" height="${SESSION_CARD_HEIGHT}" viewBox="0 0 ${SESSION_CARD_WIDTH} ${SESSION_CARD_HEIGHT}" font-family="Inter, Arial, sans-serif">
<defs>
  ${fontFace}
  <linearGradient id="artGradient" x1="199.5" y1="0" x2="199.5" y2="630" gradientUnits="userSpaceOnUse">
    <stop stop-color="#000000" stop-opacity="0.01"/>
    <stop offset="1" stop-color="#000000" stop-opacity="0.08"/>
  </linearGradient>
  <clipPath id="avatarClip"><rect x="56" y="123" width="48" height="48" rx="8"/></clipPath>
</defs>
<rect width="1200" height="630" fill="#FFFFFF"/>
<rect width="8" height="630" fill="${xml(data.accent)}"/>
<g transform="translate(801 0)">
  <path d="M68.8375 226.509C-37.3322 147.543 -7.34262 36.0198 68.8375 0H399V630H84.0041C208.443 571.121 289.104 390.338 68.8375 226.509Z" fill="url(#artGradient)"/>
</g>
<text x="56" y="40" dominant-baseline="hanging" fill="#000000" font-size="56" font-weight="600" letter-spacing="-2">${xml(displayTitle)}</text>
${avatarMarkup}
<rect x="56.5" y="123.5" width="47" height="47" rx="7.5" fill="none" stroke="#000000" stroke-opacity="0.25"/>
<text x="120" y="147" dominant-baseline="middle" fill="#000000" font-size="36" font-weight="500">${xml(data.owner)}</text>
<text x="56" y="542" dominant-baseline="hanging" fill="#000000" fill-opacity="0.5" font-family="JetBrains Mono, monospace" font-size="36" font-weight="500">${xml(repo)}</text>
<text x="1144" y="542" dominant-baseline="hanging" text-anchor="end" fill="#000000" fill-opacity="0.5" font-family="JetBrains Mono, monospace" font-size="36" font-weight="500">${xml(model)}</text>
</svg>`;
}

let jetBrainsMonoDataUrl = "";

async function socialCardMonoFont(): Promise<string> {
	if (jetBrainsMonoDataUrl) return jetBrainsMonoDataUrl;
	const bytes = await Bun.file(
		new URL("./fonts/JetBrainsMono-Medium.ttf", import.meta.url),
	).arrayBuffer();
	jetBrainsMonoDataUrl = `data:font/ttf;base64,${Buffer.from(bytes).toString("base64")}`;
	return jetBrainsMonoDataUrl;
}

/** The rasterised card, or null when sharp is unavailable (the route answers
 *  501 in that case; the meta-tag path never needs the bitmap). */
export async function renderSessionSocialCard(
	data: SessionSocialCardData,
): Promise<Buffer | null> {
	const sharp = await loadSharp();
	if (!sharp) return null;
	const [avatar, monoFont, title] = await Promise.all([
		avatarDataUrl(data.person),
		socialCardMonoFont(),
		fitSocialCardTitle(data.title),
	]);
	return sharp(Buffer.from(sessionSocialCardSvg(data, avatar, monoFont, title)))
		.png()
		.toBuffer();
}

function publicBase(): string {
	const media = configuredIntegration("media").publicBaseUrl;
	return (
		process.env.OPENSESSION_SESSION_CARD_BASE ||
		(typeof media === "string" ? media : configuredServer().publicBaseUrl)
	).replace(/\/+$/, "");
}

export function sessionSocialCardUrl(sessionId: string): string {
	return `${publicBase()}/session-card/${encodeURIComponent(sessionId)}/${cardToken(sessionId)}.png?v=${SESSION_CARD_VERSION}`;
}

let cachedCardSecret = "";

function cardSecret(): string {
	const configured = process.env.OPENSESSION_SESSION_CARD_SECRET?.trim();
	if (configured) return configured;
	if (cachedCardSecret) return cachedCardSecret;
	const path = stateDir("social-card-secret");
	try {
		const stored = readFileSync(path, "utf8").trim();
		if (stored.length >= 32) return (cachedCardSecret = stored);
	} catch {}
	const created = randomBytes(32).toString("hex");
	writeFileSync(path, `${created}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {}
	return (cachedCardSecret = created);
}

function cardToken(sessionId: string): string {
	return createHmac("sha256", cardSecret())
		.update(`session-social-card:${sessionId}`)
		.digest("base64url")
		.slice(0, 32);
}

function validCardToken(sessionId: string, token: string): boolean {
	const expected = Buffer.from(cardToken(sessionId));
	const presented = Buffer.from(token);
	return (
		expected.length === presented.length && timingSafeEqual(expected, presented)
	);
}

function socialDescription(data: SessionSocialCardData): string {
	return [data.owner, data.repo, data.model].filter(Boolean).join(" · ");
}

function replaceMeta(htmlSource: string, key: string, value: string): string {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`(<meta\\s+(?:property|name)="${escaped}"\\s+content=")[^"]*("\\s*/?>)`);
	return htmlSource.replace(pattern, `$1${html(value)}$2`);
}

export function sessionHtmlWithSocialMeta(
	htmlSource: string,
	session: UnifiedSession,
	pathname: string,
): string {
	const data = sessionSocialCardData(session);
	const image = sessionSocialCardUrl(session.id);
	const page = `${configuredServer().publicBaseUrl.replace(/\/+$/, "")}${pathname}`;
	const documentTitle = `${data.title} · ${productName()}`;
	let output = htmlSource.replace(/<title>[^<]*<\/title>/, `<title>${html(documentTitle)}</title>`);
	output = replaceMeta(output, "og:title", data.title);
	output = replaceMeta(output, "og:image", image);
	output = replaceMeta(output, "twitter:card", "summary_large_image");
	output = replaceMeta(output, "twitter:title", data.title);
	output = replaceMeta(output, "twitter:image", image);
	const description = socialDescription(data);
	const extra = `
  <meta property="og:description" content="${html(description)}" />
  <meta property="og:url" content="${html(page)}" />
  <meta property="og:image:width" content="${SESSION_CARD_WIDTH}" />
  <meta property="og:image:height" content="${SESSION_CARD_HEIGHT}" />
  <meta property="og:image:alt" content="${html(`${data.title}, an Open Session by ${data.owner}`)}" />
  <meta name="twitter:description" content="${html(description)}" />
  <meta name="twitter:image:alt" content="${html(`${data.title}, an Open Session by ${data.owner}`)}" />`;
	return output.replace(/(<meta property="og:type"[^>]*>)/, `$1${extra}`);
}

export function socialSessionIdFromPath(pathname: string): string | null {
	const match =
		pathname.match(/^\/session\/([^/?#]+)/) ||
		pathname.match(/^\/workspace\/[^/?#]+\/session\/([^/?#]+)/);
	if (!match) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return null;
	}
}

const cardCache = new Map<string, { fingerprint: string; bytes: Buffer; at: number }>();
const CARD_CACHE_MS = 60_000;
const CARD_CACHE_LIMIT = 100;

function rememberCard(
	sessionId: string,
	entry: { fingerprint: string; bytes: Buffer; at: number },
): void {
	cardCache.delete(sessionId);
	cardCache.set(sessionId, entry);
	if (cardCache.size <= CARD_CACHE_LIMIT) return;
	const oldest = cardCache.keys().next().value;
	if (oldest) cardCache.delete(oldest);
}

export function sessionSocialCardPublicRoutes(): Map<
	string,
	(req: Request, url: URL) => Promise<Response>
> {
	const routes = new Map<string, (req: Request, url: URL) => Promise<Response>>();
	routes.set("GET /session-card/*", async (_req, url) => {
		const match = url.pathname.match(
			/^\/session-card\/([^/]{1,600})\/([A-Za-z0-9_-]{32})\.png$/,
		);
		if (!match) return Response.json({ error: "Not found" }, { status: 404 });
		let sessionId: string;
		try {
			sessionId = decodeURIComponent(match[1]);
		} catch {
			return Response.json({ error: "Not found" }, { status: 404 });
		}
		if (!validCardToken(sessionId, match[2]))
			return Response.json({ error: "Not found" }, { status: 404 });
		const session = await findSession(sessionId);
		if (!session) return Response.json({ error: "Not found" }, { status: 404 });
		const data = sessionSocialCardData(session);
		const fingerprint = JSON.stringify(data, (key, value) => (key === "person" ? data.person?.image || data.person?.github : value));
		const cached = cardCache.get(session.id);
		const now = Date.now();
		let bytes: Buffer;
		if (cached && cached.fingerprint === fingerprint && now - cached.at < CARD_CACHE_MS) {
			bytes = cached.bytes;
		} else {
			const rendered = await renderSessionSocialCard(data);
			if (!rendered)
				return Response.json(
					{ error: "Social card rendering unavailable (sharp not installed)" },
					{ status: 501 },
				);
			bytes = rendered;
			rememberCard(session.id, { fingerprint, bytes, at: now });
		}
		return new Response(bytes.slice().buffer as ArrayBuffer, {
			headers: {
				"Content-Type": "image/png",
				"Cache-Control": "public, max-age=60, stale-while-revalidate=300",
				"X-Content-Type-Options": "nosniff",
				"X-Robots-Tag": "noindex",
			},
		});
	});
	return routes;
}
