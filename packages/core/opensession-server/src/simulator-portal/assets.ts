import { resolve, basename } from "node:path";

/** Built inside the supervised viewer process, never on the gateway thread. */
export async function buildSimulatorViewer(): Promise<Map<string, Blob>> {
  const frontend = resolve(import.meta.dir, "../frontend");
  const root = resolve(import.meta.dir, "../../../../..");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
  };
  const css = Bun.spawn(
    [
      resolve(root, "node_modules/.bin/tailwindcss"),
      "-i",
      resolve(frontend, "styles/tailwind.css"),
      "--minify",
    ],
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
  files.set("/utilities.css", new Blob([stylesheet], { type: "text/css" }));
  files.set(
    "/",
    new Blob(
      [
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>iOS simulator</title><link rel="stylesheet" href="/main.css"><link rel="stylesheet" href="/utilities.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>`,
      ],
      { type: "text/html" },
    ),
  );
  return files;
}
