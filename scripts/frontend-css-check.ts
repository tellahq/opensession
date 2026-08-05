import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileTailwindCss, validateTailwindCss } from "../src/server/frontend-css";
import { assembleFrontendShell } from "../src/server/frontend-shell";

const root = join(import.meta.dir, "..");
const globalCss = join(root, "src", "frontend", "styles", "global.css");

if (existsSync(globalCss)) {
	throw new Error("global.css must remain deleted; authored residual CSS belongs in the Tailwind entry");
}

await compileTailwindCss();

const preflightSignature =
	"*,:after,:before,::backdrop{box-sizing:border-box;border:0 solid;margin:0;padding:0}";
let rejectedPreflight = false;
try {
	validateTailwindCss(
		`.bg-raised{}.text-fg{}.rounded-md{}.focus-ring:focus-visible{}${preflightSignature}`,
	);
} catch (error) {
	if (!(error instanceof Error) || !error.message.includes("Preflight reset")) throw error;
	rejectedPreflight = true;
}
if (!rejectedPreflight) throw new Error("Tailwind validation accepted the universal reset");

const source = readFileSync(join(root, "src", "frontend", "index.html"), "utf8");
const html = assembleFrontendShell(source, {
	instance: "{}",
	productName: "OpenSession",
	entryName: "App-test.js",
	tailwindCssName: "tailwind-test.css",
});
for (const expected of ["/App-test.js", "/tailwind-test.css"]) {
	if (!html.includes(expected)) throw new Error(`assembled production shell is missing ${expected}`);
}

console.log("frontend CSS checks passed");
