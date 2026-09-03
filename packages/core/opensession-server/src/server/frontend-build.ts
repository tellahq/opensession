/**
 * In-process prod SPA bundle: build (or rebuild) the frontend without a
 * process restart, so a CSS/frontend change never interrupts a live run.
 * Serving stays in the HTTP layer; this module owns the bundle state
 * (globalThis-parked, mutated in place) and the debounced rebuild.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "path";
import type { BunFile, BunPlugin } from "bun";
import { EMBEDDED_FRONTEND } from "./embedded-frontend";
import { activeRunRecords } from "./run-journal";
import { writeFileAtomic } from "./shared/atomic-write";
import { publishStableFrontendSnapshot } from "./stable-frontend";
import { stateDir } from "./paths";
import { gitIdentityFor } from "./shared/user-mappings";
import { broadcastToAll } from "./ws-hub";
import {
  configuredServer,
  defaultRepo,
  githubBotLogins,
  personaName,
  plainWorkspaceId,
  productMark,
  productName,
} from "./config";

const g = globalThis as any;

export const IS_DEV = process.env.OPENSESSION_DEV === "1";
const SERVER_ROOT = join(import.meta.dir, "..", "..");
export const REPO_ROOT = resolve(SERVER_ROOT, "../../..");
export const FRONTEND_DIST = join(REPO_ROOT, ".frontend-dist");
export const FRONTEND_SRC = join(SERVER_ROOT, "src", "frontend");
const FRONTEND_REL = "packages/core/opensession-server/src/frontend";

export type FrontendReleasePointer = {
  sha: string;
  baseSha: string;
  releaseRoot: string;
  promotedAt: string;
};

function frontendDeployStateDir(): string {
  return process.env.OPENSESSION_DEPLOY_STATE || stateDir("deploy");
}

export function frontendReleasePointerPath(): string {
  return join(frontendDeployStateDir(), "frontend-current.json");
}

/** The release whose SPA shell/assets are currently served. Backend modules
 * remain pinned to REPO_ROOT; only this root can advance without a restart. */
export function activeFrontendReleaseRoot(): string {
  return (
    (g.__opensessionFrontendReleaseRoot as string | undefined) ?? REPO_ROOT
  );
}

export function frontendSourcePath(name: string): string {
  return join(activeFrontendReleaseRoot(), FRONTEND_REL, name);
}

export function activeFrontendDist(): string {
  return join(activeFrontendReleaseRoot(), ".frontend-dist");
}

function frontendAssetRoots(): string[] {
  return [
    activeFrontendReleaseRoot(),
    ...((g.__opensessionFrontendFallbackRoots as string[] | undefined) ?? []),
    REPO_ROOT,
  ].filter((root, index, roots) => roots.indexOf(root) === index);
}

export type FrontendBundle = {
  indexHtml: string;
  gzip: Map<string, Blob>;
  version: string;
};

/** True when the SPA is served from assets baked into the compiled binary
 *  rather than a `.frontend-dist` checkout (no in-process build is possible). */
/**
 * A built SPA asset by its served name (e.g. `App-abc123.js`, `ghostty-vt.wasm`)
 * — from the embedded set in the compiled binary, or `.frontend-dist` on disk.
 * Null when the compiled binary has no such asset (source mode returns a
 * BunFile whose `.exists()` the caller still checks).
 */
export function frontendDistFile(name: string): BunFile | null {
  if (EMBEDDED_FRONTEND) {
    const path = EMBEDDED_FRONTEND.assets[name];
    return path ? Bun.file(path) : null;
  }
  for (const root of frontendAssetRoots()) {
    const path = join(root, ".frontend-dist", name);
    if (existsSync(path)) return Bun.file(path);
  }
  return Bun.file(join(activeFrontendDist(), name));
}

/**
 * A stable asset served directly from src/frontend in source installs, or from
 * the compiled binary's embedded static set in one-command installs.
 */
export function frontendStaticFile(
  name: string,
  sourcePath?: string,
): BunFile | null {
  if (EMBEDDED_FRONTEND) {
    const path = EMBEDDED_FRONTEND.staticAssets[name];
    return path ? Bun.file(path) : null;
  }
  return Bun.file(sourcePath ?? frontendSourcePath(name));
}

/**
 * Name of the newest Tailwind sheet that compiled successfully, so a failed
 * rebuild can keep serving it rather than shipping the app with no utilities
 * at all (see the Tailwind pass in buildFrontend). Parked on globalThis with
 * the rest of the bundle state, and seeded from disk on first use so the
 * fallback survives a server restart as well as a hot reload.
 */
function lastGoodTailwind(): string | null {
  if (g.__opensessionLastGoodTailwind === undefined) {
    let newest: string | null = null;
    let newestAt = 0;
    try {
      for (const f of readdirSync(FRONTEND_DIST)) {
        if (!/^tailwind-.+\.css$/.test(f)) continue;
        const at = statSync(join(FRONTEND_DIST, f)).mtimeMs;
        if (at >= newestAt) [newest, newestAt] = [f, at];
      }
    } catch {}
    g.__opensessionLastGoodTailwind = newest;
  }
  return g.__opensessionLastGoodTailwind ?? null;
}

/**
 * Compile src/frontend/styles/tailwind.css with the real Tailwind CLI. Bun
 * cannot compile Tailwind, so this subprocess (~100ms) is the only way to get
 * the utilities layer — in the prod bundle AND in dev, where the UI is served
 * by Bun's HMR server and therefore had NO utilities at all until 2026-08-05
 * (Home, the composer and every Tailwind-styled component rendered unstyled,
 * which reads as a broken app rather than a missing stylesheet).
 * Throws on a failed compile; callers decide how to fail soft.
 */
async function compileTailwind(outPath: string): Promise<string> {
  mkdirSync(dirname(outPath), { recursive: true });
  const proc = Bun.spawn(
    [
      `${REPO_ROOT}/node_modules/.bin/tailwindcss`,
      "-i",
      `${FRONTEND_SRC}/styles/tailwind.css`,
      "-o",
      outPath,
      "--minify",
    ],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if ((await proc.exited) !== 0) {
    throw new Error(await new Response(proc.stderr).text());
  }
  return await Bun.file(outPath).text();
}

// Dev-mode utilities sheet, compiled on first request and cached until a
// frontend edit invalidates it (scheduleFrontendRebuild). Prod never uses
// this path — there the hashed sheet is part of the built bundle.
let devTailwind: string | null = null;

/** The dev-mode Tailwind sheet, or null in prod / on a failed compile. */
export async function devTailwindCss(): Promise<string | null> {
  if (!IS_DEV) return null;
  if (devTailwind !== null) return devTailwind;
  try {
    devTailwind = await compileTailwind(`${FRONTEND_DIST}/.tailwind-dev.css`);
    return devTailwind;
  } catch (e) {
    console.error("[frontend] Tailwind (dev) build FAILED:", e);
    return null;
  }
}

// ── Prebuilt mode ────────────────────────────────────────────────────────────
// A release artefact (scripts/build-release.ts) ships .frontend-dist compiled
// on the build host and installs dependencies with --production, so the box
// has no Tailwind compiler and never bundles. It is detected by the
// release.json the artefact writes at the repo root, or forced with
// OPENSESSION_PREBUILT_FRONTEND=1 (=0 forces source mode). In this mode boot
// only rehydrates the shipped bundle and renders index.html; every rebuild
// trigger is a no-op.

const RELEASE_MANIFEST = join(REPO_ROOT, "release.json");

/** True when the frontend is served from a fixed prebuilt bundle rather than
 *  built in-process: the compiled binary's embedded assets, or a release
 *  tarball's shipped .frontend-dist. Either way there is no source rebuild. */
export function isPrebuiltFrontend(): boolean {
  if (EMBEDDED_FRONTEND) return true;
  if (process.env.OPENSESSION_PREBUILT_FRONTEND === "1") return true;
  if (process.env.OPENSESSION_PREBUILT_FRONTEND === "0") return false;
  return existsSync(RELEASE_MANIFEST);
}

/**
 * What compileAssets() leaves behind in .frontend-dist/.bundle-meta.json:
 * the hashed asset names index.html links to and the portable inputs hash
 * that says which sources they were compiled from. Everything else the
 * served bundle needs (index.html, version) is derived from it at boot.
 */
export type BundleMeta = {
  inputsHash: string;
  entryName: string;
  cssName: string;
  twName: string | null;
  /** Every servable file compileAssets wrote (entry, chunks, sheets). */
  assets: string[];
  bunVersion?: string;
  builtAt?: string;
};

const BUNDLE_META = join(FRONTEND_DIST, ".bundle-meta.json");

function frontendStore(): FrontendBundle {
  return (g.__opensessionFrontend ??= {
    indexHtml: "",
    gzip: new Map<string, Blob>(),
    version: "",
  }) as FrontendBundle;
}

/** The meta the served bundle was rendered from (globalThis-parked so a hot
 *  reload and the identity-settings re-render see the same one). */
function currentMeta(): BundleMeta | null {
  return (g.__opensessionFrontendMeta as BundleMeta | undefined) ?? null;
}

// ── React Compiler ──────────────────────────────────────────────────────────
// The oxc Rust port of the React Compiler runs over every file in
// src/frontend before bundling, auto-memoizing components and hooks. This is
// why the frontend convention is "no useMemo/useCallback unless measured":
// the compiler supplies the memoization. A compiler diagnostic fails the build
// rather than silently shipping a function whose identities are unstable.
// Dev mode serves through Bun's HMR server, which has no plugin hook, so the
// compiler only runs here (prod bundle + release artefact).
type TransformSync = typeof import("oxc-transform-react").transformSync;

function reactCompilerPlugin(
  count: { n: number },
  transformSync: TransformSync,
): BunPlugin {
  return {
    name: "oxc-react-compiler",
    setup(build) {
      build.onLoad({ filter: /\.[jt]sx?$/ }, (args) => {
        // Only our own sources: vendored deps ship pre-built and must keep
        // their exact published output.
        if (!args.path.startsWith(FRONTEND_SRC)) return undefined;
        const sourceText = readFileSync(args.path, "utf8");
        const lang = args.path.endsWith(".tsx")
          ? "tsx"
          : args.path.endsWith(".ts")
            ? "ts"
            : args.path.endsWith(".jsx")
              ? "jsx"
              : "js";
        const result = transformSync(args.path, sourceText, {
          lang,
          // Lower TS + JSX here so the bundled loader can be plain js.
          jsx: { development: false },
          reactCompiler: { target: "19", panicThreshold: "none" },
        });
        if (result.fatal || !result.code || result.errors.length > 0) {
          const details =
            result.errors
              .map(
                (error) =>
                  `${error.severity}: ${error.message}${error.codeframe ? `\n${error.codeframe}` : ""}`,
              )
              .join("\n") || "unknown compiler failure";
          throw new Error(
            `React Compiler failed on ${relative(FRONTEND_SRC, args.path)}:\n${details}`,
          );
        }
        count.n++;
        return { contents: result.code, loader: "js" };
      });
    },
  };
}

// Lowered + compiler-memoized file counter, shared with the plugin below so
// compileAssets can report one summary line per build.
const compilerCount = { n: 0 };

/**
 * Compile the SPA assets into .frontend-dist: the split JS bundle, the
 * hand-concatenated global stylesheet, the Tailwind sheet and the ghostty
 * wasm. Writes .bundle-meta.json and returns it. Touches no served state;
 * buildFrontend() and the release build both sit on top of this.
 *
 * Nothing here depends on the instance (name, mark, persona, URLs): those
 * are stitched into index.html by renderIndexHtml at boot, which is what
 * makes a dist compiled on one machine reusable on any other.
 */
export async function compileAssets(): Promise<BundleMeta> {
  // The compiler is a build-only native dependency. Loading it at module scope
  // makes a compiled release try to resolve its unshipped .node binding during
  // server boot, even though embedded releases never rebuild the frontend.
  const { transformSync } = await import("oxc-transform-react");
  // Stamped before the build so edits landing mid-build hash as "changed" on
  // the next boot rather than being masked by a post-build stamp.
  const inputsHash = frontendInputsHash();
  compilerCount.n = 0;
  const result = await Bun.build({
    entrypoints: [`${FRONTEND_SRC}/App.tsx`],
    outdir: FRONTEND_DIST,
    minify: true,
    splitting: true,
    sourcemap: "none",
    // Root-relative assets: the app is served at the bare domain root
    // (the instance host); old /opensession + /backstage page URLs 301 there, and
    // prefixed asset requests still normalize in the fetch preamble.
    publicPath: "/",
    naming: {
      entry: "[name]-[hash].[ext]",
      chunk: "[name]-[hash].[ext]",
      asset: "[name]-[hash].[ext]",
    },
    plugins: [reactCompilerPlugin(compilerCount, transformSync)],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "frontend build failed");
  }
  console.log(`React Compiler memoized ${compilerCount.n} frontend files`);
  // Bun's HTML-entry splitting mis-points the bootstrap <script> at a leaf
  // chunk, so we build the JS entry and stitch index.html ourselves: keep the
  // source shell (icons, splash, manifest links) and point it at the hashed
  // entry + the extracted CSS.
  const entry = result.outputs.find((o) => o.kind === "entry-point");
  if (!entry) throw new Error("frontend build produced no entry point");
  const entryName = entry.path.split("/").pop()!;
  const outputNames = result.outputs.map((o) => o.path.split("/").pop()!);

  // Bun 1.3.14's CSS minifier strips the space after var(...) and breaks the
  // .panel-overlay / .sidebar-overlay inset (and a few color-mix percentages),
  // which knocks out the mobile overlay layer. Bypass it: write the source CSS
  // unmodified with a content-hashed name and serve it ourselves.
  // base.css is the permanent foundation (tokens, reset, platform chrome);
  // legacy.css is the component styling being migrated to Tailwind and is
  // meant to reach zero. Bun's CSS build resolves base.css's local imports,
  // but the unminified source path below bypasses that output. Inline those
  // modules here in the same order before appending legacy.css, so every rule
  // keeps its cascade position.
  const baseCss = await Bun.file(`${FRONTEND_SRC}/styles/base.css`).text();
  const localImportPattern = /^@import "\.\/([^"]+)";$/gm;
  const importedCss = await Promise.all(
    [...baseCss.matchAll(localImportPattern)].map((match) =>
      Bun.file(`${FRONTEND_SRC}/styles/${match[1]}`).text(),
    ),
  );
  let nextImport = 0;
  let cssSrc = baseCss.replace(
    /^@import "\.\/([^"]+)";$/gm,
    () => importedCss[nextImport++] ?? "",
  );
  cssSrc += `\n${await Bun.file(`${FRONTEND_SRC}/styles/legacy.css`).text()}`;
  // xterm stylesheet (the Shell tab) rides along in the same file, vendored
  // straight from the installed package so it can't drift from the JS.
  try {
    const xtermCss = await Bun.file(
      `${REPO_ROOT}/node_modules/@xterm/xterm/css/xterm.css`,
    ).text();
    cssSrc += `\n\n/* ── vendored @xterm/xterm/css/xterm.css (Shell tab) ── */\n${xtermCss}`;
  } catch {}
  const cssHash = Bun.hash(cssSrc).toString(36);
  const cssName = `global-${cssHash}.css`;
  // Atomic: a mid-write bundle file has shipped corrupt before ("useState is
  // not defined") — never serve a torn asset.
  writeFileAtomic(`${FRONTEND_DIST}/${cssName}`, cssSrc);

  // ghostty-web's WASM VT engine (the Shell tab's terminal) rides along too:
  // the bundled chunk can't resolve the package-relative wasm, so it's copied
  // out and served at a stable name (static-assets.ts; the shell passes the
  // explicit path to Ghostty.load, with an xterm.js fallback if this fails).
  try {
    const tmp = `${FRONTEND_DIST}/.ghostty-vt.wasm.tmp`;
    await Bun.write(
      tmp,
      Bun.file(`${REPO_ROOT}/node_modules/ghostty-web/dist/ghostty-vt.wasm`),
    );
    renameSync(tmp, `${FRONTEND_DIST}/ghostty-vt.wasm`);
  } catch (e) {
    console.error(
      "[frontend] ghostty-vt.wasm copy failed — Shell falls back to xterm.js:",
      e,
    );
  }

  // Tailwind pass (see styles/tailwind.css). Bun can't compile Tailwind, so
  // the real compiler runs as a subprocess (~50ms); its lightningcss minifier
  // doesn't have the var() bug above. Linked after the stylesheets so utilities win
  // source-order ties against legacy rules.
  //
  // Fail-soft, but NOT by dropping the sheet: as components migrate off
  // legacy.css the utilities stop being a garnish and start carrying the
  // layout, so "serve without utilities" degrades from a cosmetic loss to a
  // destroyed page. Fall back to the last sheet that compiled instead — it is
  // stale by exactly the edit that broke the build, which is survivable, and
  // the watcher replaces it on the next good compile. Only a failure with no
  // previous sheet at all (a broken first build at boot) ships bare.
  let twName: string | null = null;
  try {
    const twCss = await compileTailwind(`${FRONTEND_DIST}/.tailwind-build.css`);
    twName = `tailwind-${Bun.hash(twCss).toString(36)}.css`;
    writeFileAtomic(`${FRONTEND_DIST}/${twName}`, twCss);
    g.__opensessionLastGoodTailwind = twName;
  } catch (e) {
    const prev = lastGoodTailwind();
    if (prev && existsSync(`${FRONTEND_DIST}/${prev}`)) {
      twName = prev;
      console.error(
        `[frontend] Tailwind build FAILED — reusing last good sheet (${prev}):`,
        e,
      );
    } else {
      console.error(
        "[frontend] Tailwind build FAILED and no previous sheet exists — serving without utilities:",
        e,
      );
    }
  }

  const meta: BundleMeta = {
    inputsHash,
    entryName,
    cssName,
    twName,
    assets: [...outputNames, cssName, ...(twName ? [twName] : [])],
    bunVersion: Bun.version,
    builtAt: new Date().toISOString(),
  };
  writeFileAtomic(BUNDLE_META, JSON.stringify(meta));
  console.log(
    `Frontend compiled: ${result.outputs.length} files → ${FRONTEND_DIST} (v=${bundleVersion(meta)})`,
  );
  pruneFrontendDist(meta.assets);
  return meta;
}

/** Changes whenever the entry or a stylesheet hash changes, so clients know to refresh. */
export function bundleVersion(meta: BundleMeta): string {
  return `${meta.entryName}|${meta.cssName}|${meta.twName ?? "no-tw"}`;
}

/**
 * The served index.html: the source shell from src/frontend/index.html with
 * the instance blob (name, mark, persona, URLs) and the <title> stitched in,
 * pointed at the compiled assets. Pure over (meta, source shell, config);
 * runs at boot and again when identity settings change, without recompiling.
 */
/** The per-instance blob stitched into index.html: identity, URLs, and the ids
 *  the SPA needs before its first fetch. Kept as one helper so the boot render
 *  and any inputs it feeds never drift on which fields the instance carries. */
function frontendInstance() {
  return {
    productName: productName(),
    productMark: productMark(),
    personaName: personaName(),
    publicBaseUrl: configuredServer().publicBaseUrl,
    webhookBaseUrl: configuredServer().webhookBaseUrl,
    githubBotLogins: githubBotLogins(),
    defaultRepoId: defaultRepo().id,
    plainWorkspaceId: plainWorkspaceId() || undefined,
    agentationEnabled: process.env.OPENSESSION_AGENTATION === "1" || undefined,
  };
}

export function renderIndexHtml(
  meta: BundleMeta,
  sourceRoot: string = join(activeFrontendReleaseRoot(), FRONTEND_REL),
): string {
  // A compiled binary has no src tree, so the neutral index.html shell is
  // embedded and parked here at boot; otherwise read it from src/frontend.
  // Either way the instance blob below is stitched from the LIVE config, so
  // the served page reflects THIS install, not the machine that built it.
  const embeddedShell = g.__opensessionFrontendShell as string | undefined;
  let indexHtml =
    embeddedShell ?? readFileSync(join(sourceRoot, "index.html"), "utf8");
  const instance = JSON.stringify(frontendInstance()).replace(/</g, "\\u003c");
  const htmlProductName = productName()
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  indexHtml = indexHtml.replace(
    "window.__OPENSESSION_INSTANCE__ = window.__OPENSESSION_INSTANCE__ || {};",
    `window.__OPENSESSION_INSTANCE__ = ${instance};`,
  );
  // The literals below are the default wordmark as it appears in
  // src/frontend/index.html (title + apple-mobile-web-app/og/twitter titles).
  // Keep them byte-identical to that file: a mismatch silently ships the
  // default name instead of the instance's configured one.
  indexHtml = indexHtml
    .replaceAll(
      "<title>Open Session</title>",
      `<title>${htmlProductName}</title>`,
    )
    .replaceAll('content="Open Session"', `content="${htmlProductName}"`);
  indexHtml = indexHtml.replace(
    '<script type="module" src="./App.tsx"></script>',
    `<script type="module" crossorigin src="/${meta.entryName}"></script>`,
  );
  const twLink = meta.twName
    ? `\n  <link rel="stylesheet" href="/${meta.twName}">`
    : "";
  // Inject before the LAST head close: the first "</head>" in the source can
  // legitimately appear inside inline-script comment text (2026-08-05: a
  // comment literal ate the stylesheet links and broke the boot script).
  const headClose = indexHtml.lastIndexOf("</head>");
  return (
    indexHtml.slice(0, headClose) +
    `  <link rel="stylesheet" href="/${meta.cssName}">${twLink}\n` +
    indexHtml.slice(headClose)
  );
}

/** Point the served bundle at `meta`: render index.html and swap the store
 *  contents in place (never reassigned; routes hold the one reference). */
function publishStableShell(activated = false): void {
  if (process.env.OPENSESSION_GATEWAY_ROLE === "standby" && !activated) return;
  const store = frontendStore();
  if (!store.indexHtml || !store.version) return;
  try {
    const published = publishStableFrontendSnapshot(frontendDeployStateDir(), {
      releaseRoot: activeFrontendReleaseRoot(),
      fallbackRoots:
        (g.__opensessionFrontendFallbackRoots as string[] | undefined) ?? [],
      version: store.version,
      indexHtml: store.indexHtml,
    });
    // Full backend deploys start a fresh process, so their in-memory fallback
    // list is empty. The stable snapshot carries the preceding release chain
    // across that restart and keeps old content-hashed chunks lazy-loadable.
    g.__opensessionFrontendFallbackRoots = published.fallbackRoots;
  } catch (error) {
    console.error("[frontend] could not publish stable ingress shell", error);
  }
}

function applyBundle(meta: BundleMeta): string {
  const store = frontendStore();
  store.indexHtml = renderIndexHtml(meta);
  store.gzip.clear(); // stale gzipped blobs were keyed by the old hashed names
  store.version = bundleVersion(meta);
  g.__opensessionFrontendMeta = meta;
  publishStableShell();
  return store.version;
}

function readReleaseSha(releaseRoot: string): string | null {
  try {
    const sha = readFileSync(
      join(releaseRoot, ".opensession-release"),
      "utf8",
    ).trim();
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function parseFrontendReleasePointer(
  raw: string,
): FrontendReleasePointer | null {
  try {
    const pointer = JSON.parse(raw) as Partial<FrontendReleasePointer>;
    if (
      typeof pointer.sha !== "string" ||
      typeof pointer.baseSha !== "string" ||
      typeof pointer.releaseRoot !== "string" ||
      typeof pointer.promotedAt !== "string"
    )
      return null;
    return pointer as FrontendReleasePointer;
  } catch {
    return null;
  }
}

function validatedFrontendRelease(pointer: FrontendReleasePointer): {
  root: string;
  meta: BundleMeta;
  indexHtml: string;
} {
  const root = resolve(pointer.releaseRoot);
  const releases = resolve(frontendDeployStateDir(), "releases");
  if (
    root !== join(releases, pointer.sha) ||
    !root.startsWith(`${releases}${sep}`)
  ) {
    throw new Error(
      "frontend release path is outside the immutable releases directory",
    );
  }
  if (readReleaseSha(root) !== pointer.sha) {
    throw new Error(
      `frontend release ${pointer.sha.slice(0, 10)} is not prepared`,
    );
  }
  const dist = join(root, ".frontend-dist");
  const meta = readBundleMeta(dist);
  if (!meta) throw new Error(`frontend bundle metadata is missing in ${dist}`);
  const missing = meta.assets.filter((asset) => !existsSync(join(dist, asset)));
  if (missing.length)
    throw new Error(`frontend bundle is incomplete (missing ${missing[0]})`);
  const indexHtml = renderIndexHtml(meta, join(root, FRONTEND_REL));
  return { root, meta, indexHtml };
}

/** Atomically publish a bundle that was compiled in a prepared immutable
 * release. The pointer is persisted before the synchronous in-memory swap, so
 * a crash sees either the old complete release or the new complete release. */
export function activateFrontendRelease(
  pointer: FrontendReleasePointer,
): string {
  if (EMBEDDED_FRONTEND || IS_DEV) {
    throw new Error(
      "frontend release promotion is unavailable in this install mode",
    );
  }
  const prepared = validatedFrontendRelease(pointer);
  writeFileAtomic(
    frontendReleasePointerPath(),
    `${JSON.stringify(pointer, null, 2)}\n`,
    0o600,
  );
  const previousRoot = activeFrontendReleaseRoot();
  g.__opensessionFrontendFallbackRoots = [
    previousRoot,
    ...((g.__opensessionFrontendFallbackRoots as string[] | undefined) ?? []),
  ]
    .filter((root, index, roots) => roots.indexOf(root) === index)
    .slice(0, 3);
  g.__opensessionFrontendReleaseRoot = prepared.root;
  const store = frontendStore();
  store.indexHtml = prepared.indexHtml;
  store.gzip.clear();
  store.version = bundleVersion(prepared.meta);
  g.__opensessionFrontendMeta = prepared.meta;
  publishStableShell();
  console.log(
    `[frontend] promoted immutable release ${pointer.sha.slice(0, 10)} (v=${store.version})`,
  );
  return store.version;
}

/** Test-only restoration seam for the global bundle/root state. */
export function __setFrontendReleaseRootForTest(root: string): () => void {
  const previousRoot = g.__opensessionFrontendReleaseRoot;
  const previousFallbacks = g.__opensessionFrontendFallbackRoots;
  const previousMeta = g.__opensessionFrontendMeta;
  const store = frontendStore();
  const previousStore = {
    indexHtml: store.indexHtml,
    gzip: new Map(store.gzip),
    version: store.version,
  };
  g.__opensessionFrontendReleaseRoot = root;
  return () => {
    g.__opensessionFrontendReleaseRoot = previousRoot;
    g.__opensessionFrontendFallbackRoots = previousFallbacks;
    g.__opensessionFrontendMeta = previousMeta;
    store.indexHtml = previousStore.indexHtml;
    store.gzip = previousStore.gzip;
    store.version = previousStore.version;
  };
}

/** Load a restart-free frontend promotion only while its backend base is still
 * the running release. A later full deploy or rollback changes that base and
 * automatically reunifies the frontend with the backend release. */
function tryLoadPromotedFrontend(): boolean {
  try {
    const pointer = parseFrontendReleasePointer(
      readFileSync(frontendReleasePointerPath(), "utf8"),
    );
    if (!pointer) return false;
    const backendSha = readReleaseSha(REPO_ROOT);
    if (
      !backendSha ||
      pointer.baseSha !== backendSha ||
      pointer.sha === backendSha
    )
      return false;
    activateFrontendRelease(pointer);
    return true;
  } catch (error) {
    if (existsSync(frontendReleasePointerPath())) {
      console.warn("[frontend] ignoring invalid promoted release:", error);
    }
    return false;
  }
}

// Build (or rebuild) the prod SPA bundle in-process. The result object on
// globalThis is MUTATED in place (never reassigned) so the long-lived `frontend`
// reference + route closures pick up a rebuild without a process restart,
// which is the whole point: a CSS/frontend change no longer needs a `systemctl
// restart` that would interrupt every in-flight Claude run. `version` changes
// whenever the entry or CSS hash changes, so clients know to refresh.
export async function buildFrontend(): Promise<string> {
  if (isPrebuiltFrontend()) {
    throw new Error(
      "frontend is prebuilt (release.json / OPENSESSION_PREBUILT_FRONTEND): rebuilding is not available",
    );
  }
  if (activeFrontendReleaseRoot() !== REPO_ROOT) {
    throw new Error(
      "a promoted immutable frontend is active; publish another release with deploy_self",
    );
  }
  return applyBundle(await compileAssets());
}

/**
 * Re-stitch index.html from the current bundle after an identity change
 * (product name, mark, persona). Nothing compiled depends on those values,
 * so no rebuild: the served shell is swapped in place. No-op in dev (Bun's
 * HMR server serves the source shell) and before the first build.
 */
export function refreshIndexHtml(reason: string): void {
  if (!frontend) return;
  const meta = currentMeta();
  if (!meta) return;
  applyBundle(meta);
  console.log(`[frontend] index.html re-rendered (${reason})`);
}

// Hashed bundles accumulate forever without this (the dist hit 8.6 GB /
// 47k files before 2026-08-07). Old chunks stay servable for a grace window
// so long-open tabs can still lazy-load their build's chunks; anything older
// only fails into a page refresh, which those tabs need anyway.
const DIST_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function pruneFrontendDist(keep: string[]): void {
  try {
    const cutoff = Date.now() - DIST_RETENTION_MS;
    for (const name of readdirSync(FRONTEND_DIST)) {
      if (keep.includes(name)) continue;
      if (!/\.(js|css|map)$/.test(name)) continue;
      try {
        const p = join(FRONTEND_DIST, name);
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {}
    }
  } catch (e) {
    console.error("[frontend] dist prune failed (non-fatal):", e);
  }
}

// ── Boot-time build skip ─────────────────────────────────────────────────────
// The bundle only depends on src/frontend/**, bun.lock (vendored xterm css /
// ghostty wasm / the tailwind compiler all live in node_modules) and the Bun
// version — verified: no frontend import reaches outside src/frontend. When
// none of that changed since the last build, boot reuses .frontend-dist
// instead of paying the ~3.5s rebuild; every restart used to eat it even with
// zero frontend changes. The in-process watcher still rebuilds on any edit.
//
// The hash is portable: paths relative to src/frontend, content hashes rather
// than mtimes, and nothing about the instance. The same sources produce the
// same hash on any machine, which is what lets a release artefact ship the
// dist compiled elsewhere (compileAssets) and have boot accept it as current.

export function frontendInputsHash(): string {
  const parts: string[] = [`bun:${Bun.version}`];
  try {
    parts.push(
      `lock:${Bun.hash(readFileSync(join(REPO_ROOT, "bun.lock"))).toString(36)}`,
    );
  } catch {}
  const entries = readdirSync(FRONTEND_SRC, {
    recursive: true,
    withFileTypes: true,
  });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const dir =
      (e as { parentPath?: string }).parentPath ??
      String((e as { path?: string }).path ?? FRONTEND_SRC);
    const p = join(dir, e.name);
    try {
      const rel = relative(FRONTEND_SRC, p).split(sep).join("/");
      parts.push(`${rel}:${Bun.hash(readFileSync(p)).toString(36)}`);
    } catch {}
  }
  parts.sort();
  return Bun.hash(parts.join("\n")).toString(36);
}

function readBundleMeta(dist: string = FRONTEND_DIST): BundleMeta | null {
  try {
    const meta = JSON.parse(
      readFileSync(join(dist, ".bundle-meta.json"), "utf8"),
    ) as Partial<BundleMeta>;
    if (
      !meta.inputsHash ||
      !meta.entryName ||
      !meta.cssName ||
      !Array.isArray(meta.assets)
    )
      return null;
    return { ...meta, twName: meta.twName ?? null } as BundleMeta;
  } catch {
    return null;
  }
}

/** Rehydrate the served bundle from an unchanged .frontend-dist. False on any
 *  doubt (missing meta, hash drift, missing asset file) → caller rebuilds. */
function tryReuseFrontendDist(): boolean {
  const meta = readBundleMeta();
  if (!meta) return false;
  if (meta.inputsHash !== frontendInputsHash()) return false;
  for (const a of meta.assets) {
    if (!existsSync(join(FRONTEND_DIST, a))) return false;
  }
  const version = applyBundle(meta);
  console.log(
    `Frontend bundle unchanged, reusing ${FRONTEND_DIST} (v=${version})`,
  );
  return true;
}

/**
 * Prebuilt mode's only boot path: serve the shipped dist as is. The hash is
 * checked but only warned about (someone edited src/frontend on the box);
 * missing meta or assets fail boot with a pointer at the fix, since nothing
 * here can rebuild.
 */
function loadPrebuiltFrontendDist(): void {
  const meta = readBundleMeta();
  if (!meta) {
    throw new Error(
      `Prebuilt frontend expected but ${BUNDLE_META} is missing or invalid. ` +
        "The release artefact ships .frontend-dist compiled by scripts/build-release.ts; " +
        "reinstall the release, or unset OPENSESSION_PREBUILT_FRONTEND / remove release.json to build from source.",
    );
  }
  const missing = meta.assets.filter(
    (a) => !existsSync(join(FRONTEND_DIST, a)),
  );
  if (missing.length) {
    throw new Error(
      `Prebuilt frontend is incomplete: ${missing.length} asset(s) listed in ${BUNDLE_META} are missing ` +
        `(first: ${missing[0]}). Reinstall the release.`,
    );
  }
  if (meta.inputsHash !== frontendInputsHash()) {
    console.warn(
      "[frontend] Prebuilt bundle does not match src/frontend on this box (sources edited after the release was built); serving the shipped bundle anyway",
    );
  }
  const version = applyBundle(meta);
  console.log(
    `Frontend prebuilt: serving ${FRONTEND_DIST} as shipped (v=${version})`,
  );
}

/**
 * The served bundle, or null under OPENSESSION_DEV=1 (where Bun's HMR server
 * serves the app instead).
 *
 * Allocated at import, FILLED by ensureFrontendBuilt(). Allocating an empty
 * object is not a resource; a Bun.build plus a Tailwind subprocess plus ~480
 * written files are, and this module sits on the import chain of every route,
 * so building here compiled the whole SPA for any script or test that reached
 * it (scripts/check-module-side-effects.ts). The object has to exist before
 * the build rather than replace it after: routes hold this one reference for
 * the life of the process and read `indexHtml` fresh per request, which is
 * exactly what lets a rebuild land without a restart.
 */
export const frontend: FrontendBundle | null = IS_DEV ? null : frontendStore();

/**
 * Fill the bundle: rehydrate an unchanged .frontend-dist, or build it.
 *
 * opensession.ts awaits this before the server binds a port, so no request
 * can arrive at an empty shell. Idempotent — a `bun --hot` reload re-evaluates
 * this module and finds the globalThis store already filled — and concurrent
 * callers share one build. It throws when the build fails with no reusable
 * dist, which fails the boot loudly rather than serving an app with no JS.
 * In prebuilt mode it never builds: the shipped dist is served or boot fails.
 */
export function preloadPreparedFrontend(): void {
  if (!frontend || frontend.version) return;
  const meta = readBundleMeta(FRONTEND_DIST);
  if (!meta) throw new Error("prepared frontend metadata is missing");
  const missing = meta.assets.find(
    (asset) => !existsSync(join(FRONTEND_DIST, asset)),
  );
  if (missing)
    throw new Error(`prepared frontend asset is missing: ${missing}`);
  applyBundle(meta);
}

export function ensureFrontendBuilt(): Promise<void> {
  if (!frontend) return Promise.resolve();
  // A coordinated gateway handoff keeps this process and its built frontend
  // store alive while loading the next release. Republish the stable ingress
  // snapshot for that release even though there is nothing left to build.
  if (frontend.version) {
    // Standby gateways reach this point only after their activation fence.
    publishStableShell(true);
    return Promise.resolve();
  }
  if (!g.__opensessionFrontendBuild) {
    g.__opensessionFrontendBuild = (async () => {
      // Compiled binary: the bundle is baked in, no source tree or Tailwind
      // CLI to build from — fill from the embedded assets.
      if (EMBEDDED_FRONTEND) {
        // The embedded index.html is the instance-NEUTRAL shell; park it so
        // renderIndexHtml stitches THIS install's config (product name,
        // public URL, default repo, bot logins…) at boot instead of the
        // build machine's, exactly as the on-disk prebuilt path does.
        g.__opensessionFrontendShell = EMBEDDED_FRONTEND.shell;
        applyBundle(EMBEDDED_FRONTEND.meta);
        console.log(
          `Frontend served from embedded assets (v=${EMBEDDED_FRONTEND.version}); instance stitched at boot`,
        );
        return;
      }
      if (tryLoadPromotedFrontend()) return;
      // A promotion is tied to one exact backend base. A later full deploy
      // changes that base and reunifies the UI with the backend release.
      g.__opensessionFrontendReleaseRoot = REPO_ROOT;
      // Release tarball: the prebuilt .frontend-dist is on disk.
      if (isPrebuiltFrontend()) {
        loadPrebuiltFrontendDist();
        return;
      }
      if (tryReuseFrontendDist()) return;
      console.log("Building frontend (split + minified)…");
      await buildFrontend();
    })().finally(() => {
      g.__opensessionFrontendBuild = undefined;
    });
  }
  return g.__opensessionFrontendBuild as Promise<void>;
}

export const SPA_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  // The service worker owns the offline shell. The browser's separate HTTP
  // cache must never pin an older content-hashed bundle name, especially in an
  // installed iOS PWA where reloads still pass through the worker.
  "Cache-Control": "no-store",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
};

// SPA entry: the HMR bundle in dev, the prebuilt index.html in prod. Reads
// `frontend.indexHtml` fresh on each request so an in-process rebuild is served
// immediately (the object is mutated, not replaced).
const homepage = IS_DEV
  ? (await import("../frontend/index.html")).default
  : null;

export const spaEntry = frontend
  ? () =>
      // Unbuilt is unreachable in the server (boot awaits
      // ensureFrontendBuilt before binding); saying so out loud beats
      // serving an empty document to whatever got here another way.
      frontend.version
        ? new Response(frontend.indexHtml, { headers: SPA_HEADERS })
        : new Response("Frontend is still building", { status: 503 })
  : (homepage ??
    (() => new Response("Hosted frontend unavailable", { status: 503 })));

/**
 * A run's user as a name a reader recognises. A run carries whatever id its
 * entry point identifies people by: the web sends a display name, but a Slack
 * run sends the raw Slack id, because that is what `filterMcpServers` gates
 * on. An id names nobody, so it resolves through the same identity table as
 * commit attribution, and an unknown one is dropped rather than printed.
 */
export function editorName(user?: string | null): string | null {
  const key = (user || "").trim();
  if (!key) return null;
  const person = gitIdentityFor(key);
  if (person) return person.name.split(" ")[0];
  return /^U[A-Z0-9]{6,}$/.test(key) ? null : key;
}

/**
 * Best-effort "who caused this" label for update/restart notices. These
 * notices are broadcast globally, so attribution is limited to user names and
 * never includes private session titles. Edits from a CLI/tmux Claude or a
 * human editor aren't journaled here, so no candidates means undefined, never
 * a guess. `writeCapableOnly` skips ask-mode runs (they have no Write/Edit, so
 * they can't have fired the file-watch).
 */
export function sharedCheckoutEditors(
  writeCapableOnly = false,
): string | undefined {
  try {
    const checkout = resolve(REPO_ROOT);
    const labels: string[] = [];
    const seen = new Set<string>();
    for (const run of activeRunRecords()) {
      if (!run.cwd || resolve(run.cwd) !== checkout) continue;
      if (writeCapableOnly && run.mode === "ask") continue;
      const label = editorName(run.user);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      labels.push(label);
    }
    if (!labels.length) return undefined;
    const shown = labels.slice(0, 2).join(", ");
    return labels.length > 2 ? `${shown} +${labels.length - 2}` : shown;
  } catch {
    return undefined;
  }
}

// Debounced in-process rebuild + client nudge. Triggered by the frontend
// file watcher or POST /api/rebuild-frontend, replacing the "systemctl restart
// to see my CSS change" habit that interrupted every live Claude run. Lifecycle
// signals stay exclusively owned by graceful shutdown so a gateway handoff can
// never start build work in the process it is trying to drain. Clients get a
// non-intrusive refresh toast; the bundle is served from the mutated `frontend`
// object with no restart.
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let rebuildInFlight = false;
// The shared checkout means agents save half-finished edits constantly; every
// save while the tree is broken re-fails the build. Broadcasting each failure
// storms every connected client with identical toasts, so failures are keyed
// by their error text and only a NEW error is announced; success clears the key.
let lastBuildErrorKey: string | null = null;
let lastAutoInstallAt = 0;
const AUTO_INSTALL_COOLDOWN_MS = 5 * 60_000;

/** Pull the human-readable cause out of Bun.build's AggregateError. */
function buildFailureSummary(e: unknown): {
  key: string;
  summary: string;
  needsInstall: boolean;
} {
  const msgs: string[] = [];
  let file: string | undefined;
  if (e instanceof AggregateError) {
    for (const err of e.errors ?? []) {
      const m = String((err as { message?: string })?.message ?? err).trim();
      if (m) msgs.push(m);
      const pos = (err as { position?: { file?: string } })?.position;
      if (!file && pos?.file) file = String(pos.file);
    }
  }
  if (!msgs.length) msgs.push(String(e).split("\n")[0] ?? "unknown error");
  const needsInstall = msgs.some((m) => m.includes('"bun install"'));
  const shortFile = file?.split("/").pop();
  const summary = `${shortFile ? `${shortFile}: ` : ""}${msgs[0]}${msgs.length > 1 ? ` (+${msgs.length - 1} more)` : ""}`;
  return { key: msgs.join("\n"), summary, needsInstall };
}

/** Missing-package failures (a session touched package.json without installing,
 *  or a dep gained a new subpath) are self-healable: install once, rebuild. */
async function autoInstallAndRetry(): Promise<void> {
  console.log(
    "[frontend] Build failed on unresolved imports — running bun install, then retrying",
  );
  try {
    const proc = Bun.spawn(["bun", "install"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await proc.exited) === 0) {
      scheduleFrontendRebuild("post-bun-install", 100);
    } else {
      console.error(
        "[frontend] bun install failed:",
        await new Response(proc.stderr).text(),
      );
    }
  } catch (e) {
    console.error("[frontend] bun install failed:", e);
  }
}

export function scheduleFrontendRebuild(
  reason: string,
  debounceMs = 300,
): void {
  if (IS_DEV) {
    // Dev serves JS/CSS through Bun's HMR server; only the Tailwind sheet is
    // ours to keep fresh, so drop it and let the next request recompile.
    devTailwind = null;
    return;
  }
  if (!frontend) return;
  if (isPrebuiltFrontend()) {
    // A shipped dist has no compiler behind it; say so once and move on.
    if (!g.__opensessionPrebuiltRebuildNoted) {
      g.__opensessionPrebuiltRebuildNoted = true;
      console.log(
        `[frontend] Rebuild requested (${reason}) but the frontend is prebuilt; ignoring this and later requests`,
      );
    }
    return;
  }
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    rebuildTimer = null;
    if (rebuildInFlight) return scheduleFrontendRebuild(reason, 300); // coalesce
    rebuildInFlight = true;
    const before = frontend.version;
    try {
      const version = await buildFrontend();
      lastBuildErrorKey = null;
      if (version !== before) {
        const by = sharedCheckoutEditors(true);
        console.log(
          `[frontend] Rebuilt (${reason}); notifying clients (v=${version}${by ? `, by ${by}` : ""})`,
        );
        broadcastToAll({
          type: "frontend_updated",
          version,
          ...(by ? { by } : {}),
        });
      }
    } catch (e) {
      console.error(`[frontend] Rebuild failed (${reason}):`, e);
      const fail = buildFailureSummary(e);
      if (fail.key !== lastBuildErrorKey) {
        lastBuildErrorKey = fail.key;
        broadcastToAll({
          type: "notice",
          message: "App update paused. No action needed.",
        });
      }
      if (
        fail.needsInstall &&
        Date.now() - lastAutoInstallAt > AUTO_INSTALL_COOLDOWN_MS
      ) {
        lastAutoInstallAt = Date.now();
        void autoInstallAndRetry();
      }
    } finally {
      rebuildInFlight = false;
    }
  }, debounceMs);
}
