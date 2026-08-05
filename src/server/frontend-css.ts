import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const TAILWIND_INPUT = join(REPO_ROOT, "src", "frontend", "styles", "tailwind.css");
const TAILWIND_BIN = join(REPO_ROOT, "node_modules", ".bin", "tailwindcss");
const XTERM_CSS = join(REPO_ROOT, "node_modules", "@xterm", "xterm", "css", "xterm.css");

// Keep production and the standalone dev server on the exact same compiler
// command. Bun can bundle CSS, but it cannot expand Tailwind's CSS directives.
export async function compileTailwindCss(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "opensession-tailwind-"));
	const output = join(dir, "tailwind.css");
	try {
		const proc = Bun.spawn(
			[TAILWIND_BIN, "-i", TAILWIND_INPUT, "-o", output, "--minify"],
			{ cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
		);
		if ((await proc.exited) !== 0) {
			throw new Error(await new Response(proc.stderr).text());
		}
		const css = await readFile(output, "utf8");
		validateTailwindCss(css);
		const xtermCss = await readFile(XTERM_CSS, "utf8");
		if (!xtermCss.includes(".xterm")) {
			throw new Error("xterm fallback stylesheet is missing its root selector");
		}
		return `${css}\n/* vendored @xterm/xterm/css/xterm.css */\n${xtermCss}`;
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
}

export function validateTailwindCss(css: string): void {
	// These utilities are used throughout the app and prove that @source scanning
	// and the design-token theme both made it through the real compiler.
	for (const utility of [
		".bg-raised{",
		".text-fg{",
		".rounded-md{",
		".focus-ring:focus-visible{",
	]) {
		if (!css.includes(utility)) {
			throw new Error(`Tailwind output is missing required utility ${utility}`);
		}
	}
	for (const directive of ["@source", "@theme", '@import "tailwindcss']) {
		if (css.includes(directive)) {
			throw new Error(`Tailwind output contains unresolved directive ${directive}`);
		}
	}
	// The app foundation intentionally owns box-sizing. Preflight also zeroes
	// every element's margin, padding, and border in one universal rule; that
	// broader reset is what would change the existing no-Preflight contract.
	if (/\*,:after,:before,::backdrop\{[^}]*box-sizing:border-box;[^}]*border:0 solid;[^}]*margin:0;[^}]*padding:0/.test(css)) {
		throw new Error("Tailwind output unexpectedly includes the Preflight reset");
	}
}
