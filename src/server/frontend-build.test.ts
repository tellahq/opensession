import { describe, expect, it, afterEach } from "bun:test";
import { bundleVersion, editorName, frontendInputsHash, isPrebuiltFrontend, renderIndexHtml } from "./frontend-build";
import { __setIdentitiesForTest } from "./shared/user-mappings";

let restore: (() => void) | null = null;
afterEach(() => {
	restore?.();
	restore = null;
});

function roster() {
	restore = __setIdentitiesForTest([
		{ name: "Kent de Bruin", email: "kent@example.test", slackId: "U08S8B3P83X", github: "kentdebruin" },
		{ name: "Michiel Westerbeek", email: "michiel@example.test", aliases: ["michiel"] },
	]);
}

describe("editorName", () => {
	it("resolves a Slack run's raw user id to the person's name", () => {
		roster();
		expect(editorName("U08S8B3P83X")).toBe("Kent");
	});

	it("keeps a web run's display name", () => {
		roster();
		expect(editorName("Michiel")).toBe("Michiel");
	});

	it("names one person once, whichever id each of their runs carries", () => {
		roster();
		expect(editorName("kentdebruin")).toBe(editorName("U08S8B3P83X"));
	});

	it("drops a Slack id that resolves to nobody, rather than printing it", () => {
		roster();
		expect(editorName("U0NOTONROSTER")).toBeNull();
	});

	it("keeps a label that was never an id, like an agent loop", () => {
		roster();
		expect(editorName("Michael (loops)")).toBe("Michael (loops)");
	});

	it("has nothing to say about an empty user", () => {
		expect(editorName("")).toBeNull();
		expect(editorName(null)).toBeNull();
	});
});

describe("frontendInputsHash", () => {
	it("is stable across calls and reads as a portable content hash", () => {
		const a = frontendInputsHash();
		expect(a).toBe(frontendInputsHash());
		expect(a).toMatch(/^[0-9a-z]+$/);
	});
});

describe("renderIndexHtml", () => {
	const meta = {
		inputsHash: "x",
		entryName: "App-abc.js",
		cssName: "global-def.css",
		twName: "tailwind-ghi.css",
		assets: ["App-abc.js", "global-def.css", "tailwind-ghi.css"],
	};

	it("points the source shell at the compiled assets and fills the instance blob", () => {
		const html = renderIndexHtml(meta);
		expect(html).toContain(`<script type="module" crossorigin src="/App-abc.js"></script>`);
		expect(html).toContain(`<link rel="stylesheet" href="/global-def.css">`);
		expect(html).toContain(`<link rel="stylesheet" href="/tailwind-ghi.css">`);
		expect(html).toMatch(/window\.__OPENSESSION_INSTANCE__ = \{"productName":/);
		expect(html).not.toContain("window.__OPENSESSION_INSTANCE__ || {}");
	});

	it("omits the Tailwind link when no sheet compiled", () => {
		const html = renderIndexHtml({ ...meta, twName: null });
		expect(html).not.toContain('href="/tailwind-');
		expect(bundleVersion({ ...meta, twName: null })).toBe("App-abc.js|global-def.css|no-tw");
	});
});

describe("isPrebuiltFrontend", () => {
	const prev = process.env.OPENSESSION_PREBUILT_FRONTEND;
	afterEach(() => {
		if (prev === undefined) delete process.env.OPENSESSION_PREBUILT_FRONTEND;
		else process.env.OPENSESSION_PREBUILT_FRONTEND = prev;
	});

	it("follows the env override in both directions", () => {
		process.env.OPENSESSION_PREBUILT_FRONTEND = "1";
		expect(isPrebuiltFrontend()).toBe(true);
		process.env.OPENSESSION_PREBUILT_FRONTEND = "0";
		expect(isPrebuiltFrontend()).toBe(false);
	});
});
