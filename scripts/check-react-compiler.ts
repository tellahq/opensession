/**
 * CI gate: every frontend source must compile with the React Compiler.
 *
 * A bailout silently loses compiler-managed identity and can turn a harmless
 * re-render into an effect loop or a torn connection. There is deliberately no
 * baseline or opt-out: any diagnostic fails lint and prints its codeframe.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "oxc-transform-react";

const REPO = join(import.meta.dir, "..");
const FRONTEND = join(REPO, "packages/core/opensession-server/src/frontend");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.(tsx|ts)$/.test(entry.name) && !entry.name.includes(".test."))
      out.push(path);
  }
  return out;
}

let diagnostics = 0;
for (const file of sources(FRONTEND)) {
  const source = readFileSync(file, "utf8");
  const result = transformSync(file, source, {
    lang: file.endsWith(".tsx") ? "tsx" : "ts",
    jsx: { development: false },
    reactCompiler: { target: "19", panicThreshold: "none" },
  });
  if (!result.errors.length) continue;
  const relative = file.slice(FRONTEND.length + 1);
  for (const error of result.errors) {
    diagnostics++;
    console.error(`\n${relative}: ${error.message}`);
    if (error.codeframe) console.error(error.codeframe);
  }
}

if (diagnostics > 0) {
  console.error(
    `\nReact Compiler failed with ${diagnostics} diagnostic${diagnostics === 1 ? "" : "s"}.`,
  );
  process.exit(1);
}
console.log("React Compiler: every frontend source compiled successfully.");
