import { basename, extname, resolve } from "node:path";
import { isCompiledBinary } from "../runner-host/exe";
import {
  EMBEDDED_SIMULATOR_VIEWER,
  type EmbeddedSimulatorViewer,
} from "./embedded-viewer";

/** The viewer shell. It is a string rather than an embedded `.html` file
 * because Bun bundles a `.html` import as an HTML entry point, not a file. */
export const SIMULATOR_VIEWER_INDEX_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>iOS simulator</title><link rel="stylesheet" href="/main.css"><link rel="stylesheet" href="/utilities.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>`;

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".map": "application/json;charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

/** Content type for a served viewer asset path. Bun.build outputs carry their
 * own type; embedded files are typed here so a compiled install serves the
 * same headers as a source install. */
export function viewerContentType(path: string): string {
  return (
    CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"
  );
}

/** argv for the Tailwind CLI. The `node_modules/.bin` shim carries a `node`
 * shebang, so a Bun-only host cannot exec it directly; running it under the
 * current Bun runtime needs no `node` on PATH. Source mode only: a compiled
 * binary serves the embedded viewer and never compiles styles. */
export function tailwindArgv(root: string, input: string): string[] {
  return [
    process.execPath,
    resolve(root, "node_modules/.bin/tailwindcss"),
    "-i",
    input,
    "--minify",
  ];
}

function indexHtml(): Blob {
  return new Blob([SIMULATOR_VIEWER_INDEX_HTML], {
    type: "text/html;charset=utf-8",
  });
}

/** The asset map for a viewer that travels inside the compiled binary. */
export function embeddedSimulatorViewerAssets(
  embedded: EmbeddedSimulatorViewer,
): Map<string, Blob> {
  const files = new Map<string, Blob>();
  for (const [served, path] of Object.entries(embedded.assets)) {
    if (!served.startsWith("/") || served === "/")
      throw new Error(`Invalid embedded simulator viewer asset: ${served}`);
    files.set(served, Bun.file(path, { type: viewerContentType(served) }));
  }
  files.set("/", indexHtml());
  return files;
}

/**
 * Bundle the viewer from the source checkout: Bun builds the app and the
 * Tailwind CLI compiles the utilities sheet. Used by source installs at Portal
 * start and by scripts/build-compile.ts to produce the embedded set.
 */
export async function buildSimulatorViewerFromSource(): Promise<
  Map<string, Blob>
> {
  const frontend = resolve(import.meta.dir, "../frontend");
  const root = resolve(import.meta.dir, "../../../../..");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
  };
  const css = Bun.spawn(
    tailwindArgv(root, resolve(frontend, "styles/tailwind.css")),
    {
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
  );
  const [bundle, stylesheet, diagnostics, code] = await Promise.all([
    Bun.build({
      entrypoints: [resolve(frontend, "simulator/main.tsx")],
      target: "browser",
      minify: true,
      naming: "[name].[ext]",
      define: { "process.env.NODE_ENV": '"production"' },
    }),
    new Response(css.stdout).text(),
    new Response(css.stderr).text(),
    css.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `Simulator viewer styles failed: ${diagnostics.slice(-2_000)}`,
    );
  if (!bundle.success)
    throw new Error(`Simulator viewer build failed: ${bundle.logs.join("\n")}`);
  const files = new Map<string, Blob>();
  for (const output of bundle.outputs)
    files.set(`/${basename(output.path)}`, output);
  files.set(
    "/utilities.css",
    new Blob([stylesheet], { type: viewerContentType("/utilities.css") }),
  );
  files.set("/", indexHtml());
  return files;
}

/** Built inside the supervised viewer process, never on the gateway thread. */
export async function buildSimulatorViewer(): Promise<Map<string, Blob>> {
  if (EMBEDDED_SIMULATOR_VIEWER)
    return embeddedSimulatorViewerAssets(EMBEDDED_SIMULATOR_VIEWER);
  if (isCompiledBinary())
    throw new Error(
      "This compiled Open Session build has no embedded simulator viewer. Rebuild the release with scripts/build-compile.ts or use a source installation.",
    );
  return buildSimulatorViewerFromSource();
}
