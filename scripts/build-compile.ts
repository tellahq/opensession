#!/usr/bin/env bun
/**
 * Build the single-executable `opensession` release artefact with
 * `bun build --compile`. This is the DEFAULT simple-mode artefact; the
 * source install (`install.sh --source`, a git checkout + `bun install`) is
 * the self-development path and is unaffected.
 *
 * src/main.ts is the front controller (server / CLI / runner-host / mcp-proxy /
 * transcript search worker behind one argv), and this script bakes the prebuilt SPA into the binary so
 * it needs no `.frontend-dist` beside it at runtime.
 *
 * Two modes:
 *
 *   bun scripts/build-compile.ts --outfile <path>
 *       Just the binary for the host, for local testing. No sidecar, no seed.
 *
 *   bun scripts/build-compile.ts --os linux --arch arm64 [--out <dir>]
 *       The full release artefact `opensession-<ver>-<os>-<arch>.tar.gz`:
 *         opensession                 the target binary
 *         node_modules/               sharp + @img/sharp-<target> sidecar
 *         opensession*.service        system service and socket templates
 *         opensession.socket          (see scripts/lib/release-artefact.ts)
 *         deploy/                     fixed executor credential/helper policy
 *         LICENSE + notices + SBOM    project and third-party licensing
 *         release.json                version, commit, target, kind
 *       `bun build --compile --target=bun-<os>-<arch>` cross-compiles from any
 *       host, so one runner builds every target.
 *
 * Steps: build the prod frontend into `.frontend-dist`, generate the
 * `embedded-frontend.ts` `import … with { type: "file" }` module so Bun embeds
 * every asset, compile, then restore the stub so the working tree stays clean.
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join, relative, resolve } from "path";
import { generateReleaseMetadata } from "./generate-release-metadata";
import { RELEASE_SERVICE_TEMPLATES } from "./lib/release-artefact";

const REPO_ROOT = resolve(import.meta.dir, "..");
const EMBED_MODULE = join(
  REPO_ROOT,
  "packages",
  "core",
  "opensession-server",
  "src",
  "server",
  "embedded-frontend.ts",
);

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

type Os = "linux" | "darwin";
type Arch = "arm64" | "x64";

const os = arg("os", process.platform === "darwin" ? "darwin" : "linux") as Os;
const arch = arg("arch", process.arch === "arm64" ? "arm64" : "x64") as Arch;
if (!["linux", "darwin"].includes(os) || !["arm64", "x64"].includes(arch)) {
  console.error(`unsupported target ${os}/${arch}`);
  process.exit(2);
}
// The host target needs no cross flag; a cross target does.
const isHost =
  os === (process.platform === "darwin" ? "darwin" : "linux") &&
  arch === (process.arch === "arm64" ? "arm64" : "x64");

const CACHE_HOME =
  process.env.XDG_CACHE_HOME || join(process.env.HOME || "~", ".cache");
const OUT = resolve(arg("out", join(CACHE_HOME, "opensession-release"))!);

async function sh(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
) {
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  if ((await p.exited) !== 0)
    throw new Error(`${cmd.join(" ")} failed\n${out}\n${err}`);
  return out;
}
function dirBytes(p: string): number {
  let st;
  try {
    st = statSync(p);
  } catch {
    return 0;
  } // dangling symlink etc.
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const c of readdirSync(p)) n += dirBytes(join(p, c));
  return n;
}

// The hashed SPA bundle and stable source assets both have to travel inside a
// single-executable install. The latter are requested directly by index.html,
// the sign-in gate, the PWA manifest and the service worker, so treating them
// as optional leaves a clean installation with broken images and HTTP 500s.
const ASSET_RE = /\.(?:js|css|map|wasm)$/;
const STATIC_ASSET_RE = /\.(?:png|webp|mp4)$/;

function staticFrontendAssets(
  shellPath: string,
): Array<{ name: string; path: string }> {
  const sourceDir = dirname(shellPath);
  const assets = readdirSync(sourceDir)
    .filter((name) => STATIC_ASSET_RE.test(name) || name === "sw.js")
    .map((name) => ({ name, path: join(sourceDir, name) }));
  const splashDir = join(sourceDir, "splash");
  if (existsSync(splashDir)) {
    for (const name of readdirSync(splashDir)) {
      if (STATIC_ASSET_RE.test(name))
        assets.push({ name: `splash/${name}`, path: join(splashDir, name) });
    }
  }
  // The web shell uses the desktop icon's transparent-corner variant. It lives
  // with the Mac client rather than src/frontend, but is still a web asset.
  assets.push({
    name: "mac-app-icon.png",
    path: join(
      REPO_ROOT,
      "packages",
      "clients",
      "mac",
      "build",
      "icon-512.png",
    ),
  });
  return assets
    .filter((asset) => existsSync(asset.path))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function buildFrontendDist(): Promise<{
  version: string;
  distDir: string;
  metaPath: string;
  shellPath: string;
}> {
  const fb =
    await import("../packages/core/opensession-server/src/server/frontend-build");
  // Build into a CLEAN dist so only THIS build's hashed assets get embedded.
  rmSync(fb.FRONTEND_DIST, { recursive: true, force: true });
  console.log("[compile] building prod frontend -> .frontend-dist ...");
  const version = await fb.buildFrontend();
  // Embed the instance-NEUTRAL shell (src/frontend/index.html) and the bundle
  // meta, NOT the rendered index.html: the binary stitches ITS OWN instance
  // config (name, public URL, default repo, bot logins) at boot, so one
  // release built anywhere serves any install correctly.
  const shellPath = join(fb.FRONTEND_SRC, "index.html");
  const metaPath = join(fb.FRONTEND_DIST, ".bundle-meta.json");
  if (!existsSync(shellPath))
    throw new Error(`missing frontend shell at ${shellPath}`);
  if (!existsSync(metaPath))
    throw new Error(`frontend build produced no ${metaPath}`);
  return { version, distDir: fb.FRONTEND_DIST, metaPath, shellPath };
}

function generateEmbedModule(
  distDir: string,
  version: string,
  metaPath: string,
  shellPath: string,
): string {
  const names = readdirSync(distDir)
    .filter((n) => !n.startsWith(".") && ASSET_RE.test(n))
    .sort();
  const staticAssets = staticFrontendAssets(shellPath);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  // The shell is inlined as a string rather than a `with { type: "file" }`
  // import: Bun treats a `.html` import as an HTML entry point to bundle, not
  // a file asset, so the import yields no openable path and boot fails. The
  // shell is a few KB of instance-neutral markup, so a string literal is fine.
  const shell = readFileSync(shellPath, "utf8");
  // The embed module lives deep under packages/; the dist assets are elsewhere.
  // Resolve every specifier from the module's own directory so the depth of the
  // module never has to be tracked here by hand.
  const spec = (p: string): string => {
    const s = relative(dirname(EMBED_MODULE), resolve(p)).replaceAll("\\", "/");
    return s.startsWith(".") ? s : `./${s}`;
  };
  const lines: string[] = [
    "// AUTO-GENERATED by scripts/build-compile.ts for `bun build --compile`.",
    "// Do not edit or commit: the build restores the src stub afterwards.",
    "/* eslint-disable */",
  ];
  const assetEntries: string[] = [];
  names.forEach((name, i) => {
    const ident = `__a${i}`;
    lines.push(
      `import ${ident} from ${JSON.stringify(spec(resolve(distDir, name)))} with { type: "file" };`,
    );
    assetEntries.push(`\t\t${JSON.stringify(name)}: ${ident},`);
  });
  const staticAssetEntries: string[] = [];
  staticAssets.forEach((asset, index) => {
    const ident = `__s${index}`;
    lines.push(
      `import ${ident} from ${JSON.stringify(spec(asset.path))} with { type: "file" };`,
    );
    staticAssetEntries.push(`\t\t${JSON.stringify(asset.name)}: ${ident},`);
  });
  // The embedded index.html is the NEUTRAL shell; the running server stitches
  // its own instance config into it at boot via renderIndexHtml(meta).
  lines.push(
    "",
    "export const EMBEDDED_FRONTEND = {",
    `\tversion: ${JSON.stringify(version)},`,
    `\tshell: ${JSON.stringify(shell)},`,
    `\tmeta: ${JSON.stringify(meta)},`,
    "\tassets: {",
    ...assetEntries,
    "\t},",
    "\tstaticAssets: {",
    ...staticAssetEntries,
    "\t},",
    "};",
    "",
  );
  return lines.join("\n");
}

/** Compile src/main.ts to `outfile` for the target, embedding the built SPA. */
async function compileBinary(
  outfile: string,
  version: string,
  distDir: string,
  metaPath: string,
  shellPath: string,
): Promise<void> {
  const stub = await Bun.file(EMBED_MODULE).text();
  mkdirSync(dirname(outfile), { recursive: true });
  // `bun build --compile` appends to an existing outfile, so remove any prior.
  rmSync(outfile, { force: true });
  writeFileSync(
    EMBED_MODULE,
    generateEmbedModule(distDir, version, metaPath, shellPath),
  );
  try {
    const cmd = [
      "bun",
      "build",
      "--compile",
      ...(isHost ? [] : [`--target=bun-${os}-${arch}`]),
      join(
        REPO_ROOT,
        "packages",
        "core",
        "opensession-server",
        "src",
        "main.ts",
      ),
      "--outfile",
      outfile,
      // Native dependencies cannot be embedded. Sharp ships as a runtime
      // sidecar; the React compiler is build-only and compileAssets loads it
      // lazily, a path embedded releases never execute.
      "--external",
      "sharp",
      "--external",
      "@img/*",
      "--external",
      "oxc-transform-react",
    ];
    console.log(`[compile] ${cmd.join(" ")}`);
    const proc = Bun.spawn(cmd, {
      cwd: REPO_ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await proc.exited) !== 0)
      throw new Error("bun build --compile failed");
  } finally {
    writeFileSync(EMBED_MODULE, stub);
  }
  if (!existsSync(outfile)) throw new Error(`expected binary at ${outfile}`);
}

/** Install the sharp sidecar for the target into `<stage>/node_modules`. */
async function buildSharpSidecar(
  stage: string,
  sharpVersion: string,
): Promise<void> {
  const tmp = join(OUT, "sharp-sidecar", `${os}-${arch}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ dependencies: { sharp: sharpVersion } }, null, 2) + "\n",
  );
  // `bun install --os/--cpu` fetches the target's optional @img/sharp-<target>
  // natives (npm's --os/--cpu does not resolve cross-platform optionals here).
  await sh(
    ["bun", "install", "--ignore-scripts", `--os=${os}`, `--cpu=${arch}`],
    { cwd: tmp },
  );
  // Prune other platforms' natives, matching build-release: keep only the
  // target's @img/sharp-<target> (glibc) family.
  const foreign = (d: string) =>
    /musl/.test(d) ||
    (os === "linux" && /darwin|win32/.test(d)) ||
    (os === "darwin" && /linux|win32/.test(d));
  const imgDir = join(tmp, "node_modules", "@img");
  if (existsSync(imgDir)) {
    for (const d of readdirSync(imgDir))
      if (foreign(d)) rmSync(join(imgDir, d), { recursive: true, force: true });
  }
  cpSync(join(tmp, "node_modules"), join(stage, "node_modules"), {
    recursive: true,
  });
  console.log(
    `[compile] sharp sidecar: ${(dirBytes(join(stage, "node_modules")) / 1e6).toFixed(0)} MB`,
  );
}

/**
 * Ship the session-kernel Worker as an on-disk `.js` sidecar. `bun build
 * --compile` does not embed Worker entry points, so a compiled binary loads
 * this file from beside the executable (actor-runtime.ts resolves it via
 * process.execPath). Plain bundled JS the embedded Bun runs, so it is platform-
 * neutral and needs no cross-target flag.
 */
/**
 * Web Workers do not embed into `bun build --compile` binaries, so each worker
 * ships as an on-disk `.js` sidecar beside the executable and is resolved from
 * process.execPath's dir at runtime (workerEntry in runner-host/exe.ts). Keep
 * this list in sync with those workerEntry sidecar names.
 */
const WORKER_SIDECARS: Array<{ entry: string; name: string }> = [
  {
    entry: "packages/core/opensession-server/src/session-kernel-worker.ts",
    name: "session-kernel-worker.js",
  },
  {
    entry:
      "packages/core/opensession-server/src/session-kernel-transport-worker.ts",
    name: "session-kernel-transport-worker.js",
  },
  {
    entry: "packages/core/opensession-server/src/server/workflow-worker.ts",
    name: "workflow-worker.js",
  },
  {
    entry: "packages/core/opensession-server/src/server/code-flow-worker.ts",
    name: "code-flow-worker.js",
  },
];

async function buildWorkerSidecars(destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  for (const { entry, name } of WORKER_SIDECARS) {
    const out = join(destDir, name);
    // A worker's server-only import graph may retain frontend-build's
    // dev-only HTML import until runtime DCE. Keep HTML external so Bun does
    // not promote it to a second entry point that collides with --outfile.
    const proc = Bun.spawn(
      [
        "bun",
        "build",
        "--target=bun",
        "--external",
        "*.html",
        join(REPO_ROOT, entry),
        "--outfile",
        out,
      ],
      {
        cwd: REPO_ROOT,
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    if ((await proc.exited) !== 0)
      throw new Error(`${name} sidecar build failed`);
    console.log(
      `[compile] ${name} sidecar: ${(statSync(out).size / 1e3).toFixed(0)} KB`,
    );
  }
}

async function main(): Promise<void> {
  const {
    version: fver,
    distDir,
    metaPath,
    shellPath,
  } = await buildFrontendDist();

  // Bare-binary mode: --outfile with no artefact assembly (local testing).
  const bareOut = arg("outfile");
  if (bareOut && !has("out") && !has("os") && !has("arch")) {
    const outfile = resolve(bareOut);
    await compileBinary(outfile, fver, distDir, metaPath, shellPath);
    await buildWorkerSidecars(dirname(outfile));
    const mb = (statSync(outfile).size / 1e6).toFixed(1);
    console.log(`\n[compile] built ${outfile} (${mb} MB, v=${fver})`);
    return;
  }

  // Artefact mode.
  const pkg = JSON.parse(
    await Bun.file(join(REPO_ROOT, "package.json")).text(),
  ) as {
    version?: string;
    dependencies?: Record<string, string>;
  };
  const commit = (
    await sh(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT })
  ).trim();
  const version = arg("version", `${pkg.version ?? "0.0.0"}+${commit}`)!;
  const sharpVersion = pkg.dependencies?.sharp ?? "latest";
  const name = `opensession-${version}-${os}-${arch}`;
  const stage = join(OUT, "stage", name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  console.log(`\n== compile ${name}`);
  await compileBinary(
    join(stage, "opensession"),
    fver,
    distDir,
    metaPath,
    shellPath,
  );
  // System scope is optional, but it must be fully installable from the same
  // binary artifact. These root-owned policy files are inputs to the installer,
  // never caller-controlled argv passed across the executor boundary.
  for (const rel of RELEASE_SERVICE_TEMPLATES) {
    const source = join(REPO_ROOT, rel);
    const destination = join(stage, rel);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
    chmodSync(destination, statSync(source).mode & 0o777);
  }
  console.log("\n== worker sidecars");
  await buildWorkerSidecars(stage);
  console.log("\n== sharp sidecar");
  await buildSharpSidecar(stage, sharpVersion);

  console.log("\n== licenses and SBOM");
  for (const rel of [
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "THIRD-PARTY-LICENSES",
  ]) {
    cpSync(join(REPO_ROOT, rel), join(stage, rel), { recursive: true });
  }
  generateReleaseMetadata({
    lockPath: join(REPO_ROOT, "bun.lock"),
    nodeModules: join(REPO_ROOT, "node_modules"),
    outDir: stage,
    name: "opensession",
    version,
  });

  writeFileSync(
    join(stage, "release.json"),
    JSON.stringify(
      {
        name,
        version,
        commit,
        os,
        arch,
        kind: "binary",
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );

  const tarball = join(OUT, `${name}.tar.gz`);
  rmSync(tarball, { force: true });
  await sh(
    ["tar", "--no-xattrs", "-C", join(OUT, "stage"), "-czf", tarball, name],
    { env: { COPYFILE_DISABLE: "1" } },
  );
  const mb = (statSync(tarball).size / 1e6).toFixed(0);
  console.log(`\n[compile] ${tarball} (${mb} MB)`);
  console.log(`Install: install.sh --artifact ${tarball}`);
}

await main();
