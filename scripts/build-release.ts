/**
 * Build the release artefact simple mode installs (adrs/simple-mode.md, R1.3).
 *
 *   bun scripts/build-release.ts --os linux --arch arm64 [--out ~/.cache/opensession-release]
 *
 * Produces `opensession-<version>-<os>-<arch>.tar.gz`, a runtime-inclusive
 * tarball a box unpacks and runs with no git, no Bun on PATH and no install
 * step:
 *
 *   bin/bun              pinned Bun for the target (this build's Bun.version)
 *   <source tree>        tracked files minus clients, docs, tests, website
 *   .frontend-dist/      the SPA compiled here (frontend-build.ts compileAssets)
 *                        plus its .bundle-meta.json; the box only stitches
 *                        index.html at boot and never bundles or runs Tailwind
 *   node_modules/        `bun install --production --os --cpu` for the target,
 *                        pruned of foreign-platform and musl binaries, and of
 *                        the bundled Claude Code binaries (below)
 *   release.json         version, commit, target, bun version,
 *                        built-at; its presence puts the server in
 *                        prebuilt-frontend mode
 *
 * No bundled Claude Code. The Agent SDK and @anthropic-ai/claude-code (both
 * pulled in through @rynfar/meridian) carry a per-platform binary package
 * each, ~220-240 MB apiece, and Open Session never runs them: every SDK call
 * passes `pathToClaudeCodeExecutable` and Meridian gets MERIDIAN_CLAUDE_PATH,
 * both the installed `claude` CLI from config `paths.claudeBin` /
 * OPENSESSION_CLAUDE_BIN / PATH. The install script puts that CLI on the box;
 * engine-status.ts `claudeCliStatus` reports at boot, in doctor and on
 * /api/health when it is missing. Only the binary packages are pruned (plus
 * packages stay so their imports still resolve. The platform's own @img/sharp
 * native is kept — the server loads sharp at runtime (session social cards) —
 * while other platforms' sharp variants go with the foreign-platform prune.
 *
 * Runs on any host with Bun and git; cross-target is fine because nothing
 * here executes target binaries and the frontend bundle is platform-neutral.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import {
  FRONTEND_DIST,
  compileAssets,
} from "../packages/core/opensession-server/src/server/frontend-build";

const ROOT = resolve(import.meta.dir, "..");

type Target = { os: "linux" | "darwin"; arch: "arm64" | "x64" };

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const os = arg(
  "os",
  process.platform === "darwin" ? "darwin" : "linux",
) as Target["os"];
const arch = arg(
  "arch",
  process.arch === "arm64" ? "arm64" : "x64",
) as Target["arch"];
// Default output lives OUTSIDE the repo: a staged release tree inside the
// checkout (tens of thousands of files, a nested node_modules) breaks
// `bun test <filter>` for the whole repo (Bun 1.3.13: child stdout capture
// goes empty once the test scanner has walked such a tree). Keep it in the
// user cache and copy the tarball wherever it is needed.
const CACHE_HOME =
  process.env.XDG_CACHE_HOME || join(process.env.HOME || "~", ".cache");
const OUT = resolve(arg("out", join(CACHE_HOME, "opensession-release"))!);
const BUN_VERSION = arg("bun", Bun.version)!;
if (!["linux", "darwin"].includes(os) || !["arm64", "x64"].includes(arch)) {
  console.error(`unsupported target ${os}/${arch}`);
  process.exit(2);
}

/** Paths never shipped: clients, docs, tests, site, CI, build outputs. */
const EXCLUDE_PREFIXES = [
  "os1-chrome/",
  "os1-ios/",
  "os1-mac/",
  "os1-tui/",
  "website/",
  "docs/",
  "adrs/",
  "test/",
  ".github/",
  "output/",
  "dist/",
  ".vscode/",
  "mac-app-icon.png",
];

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
  const code = await p.exited;
  if (code !== 0)
    throw new Error(`${cmd.join(" ")} failed (${code})\n${out}\n${err}`);
  return out;
}

const t0 = Date.now();
function step(s: string) {
  console.log(`\n== ${s}  (+${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

const commit = (
  await sh(["git", "rev-parse", "--short", "HEAD"], { cwd: ROOT })
).trim();
const pkg = JSON.parse(await Bun.file(join(ROOT, "package.json")).text()) as {
  version?: string;
};
const version = arg("version", `${pkg.version ?? "0.0.0"}+${commit}`)!;
const name = `opensession-${version}-${os}-${arch}`;
const STAGE = join(OUT, "stage", name);

step(`release ${name}`);
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

step("source tree");
const tracked = (await sh(["git", "ls-files", "-z"], { cwd: ROOT }))
  .split("\0")
  .filter(Boolean);
let copied = 0;
for (const rel of tracked) {
  if (
    EXCLUDE_PREFIXES.some(
      (p) => rel.startsWith(p) || rel === p.replace(/\/$/, ""),
    )
  )
    continue;
  const src = join(ROOT, rel);
  if (!existsSync(src)) continue; // deleted in the worktree but still tracked
  const dst = join(STAGE, rel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  copied++;
}
// The web UI serves the PWA icon from the desktop shell's build dir
// (routes/static-assets.ts); the shell itself is not shipped, the icon is.
for (const rel of ["os1-mac/build/icon-512.png"]) {
  if (existsSync(join(ROOT, rel))) {
    mkdirSync(dirname(join(STAGE, rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(STAGE, rel));
    copied++;
  }
}
console.log(`${copied} files`);

step("frontend bundle");
// Compiled in this checkout (dist is gitignored, so git ls-files never lists
// it), then copied file by file from the meta: the local dist may also hold
// chunks kept for older tabs, which a fresh install has no use for.
const meta = await compileAssets();
const distFiles = [".bundle-meta.json", "ghostty-vt.wasm", ...meta.assets];
mkdirSync(join(STAGE, ".frontend-dist"), { recursive: true });
let shipped = 0;
for (const f of distFiles) {
  const src = join(FRONTEND_DIST, f);
  if (!existsSync(src)) continue; // the wasm copy is fail-soft in compileAssets
  cpSync(src, join(STAGE, ".frontend-dist", f));
  shipped++;
}
console.log(`${shipped} files (inputs ${meta.inputsHash})`);

step(`dependencies for ${os}/${arch}`);
await sh(
  [
    "bun",
    "install",
    "--production",
    "--frozen-lockfile",
    "--ignore-scripts",
    `--os=${os}`,
    `--cpu=${arch}`,
  ],
  {
    cwd: STAGE,
    env: { BUN_INSTALL_CACHE_DIR: join(OUT, "bun-cache") },
  },
);
// bun's --os/--cpu keeps musl variants for linux; nothing here targets musl.
const store = join(STAGE, "node_modules", ".bun");
function dirBytes(p: string): number {
  const st = lstatSync(p); // lstat: the store symlinks siblings into node_modules
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const c of readdirSync(p)) n += dirBytes(join(p, c));
  return n;
}
let pruned = 0;
let prunedBytes = 0;
let prunedClaude = 0;
let prunedClaudeBytes = 0;
if (existsSync(store)) {
  for (const d of readdirSync(store)) {
    const foreign =
      /musl/.test(d) ||
      (os === "linux" && /darwin|win32/.test(d)) ||
      (os === "darwin" && /linux|win32/.test(d));
    // Never executed: Open Session shells out to the installed `claude` CLI
    // (config paths.claudeBin): the Agent SDK gets pathToClaudeCodeExecutable
    // and Meridian gets MERIDIAN_CLAUDE_PATH, so the SDK's and claude-code's
    // per-platform binary packages (~220-240 MB each) are dead weight. Only the
    // binary packages go; the JS packages they hang off stay. Same for the
    // The Agent SDK and claude-code carry a ~220-240 MB per-platform binary
    // each that is never executed (every call runs the installed claude CLI).
    // sharp is NOT pruned here: the server loads it at runtime for session
    // social cards, and the foreign-platform check above already drops the
    // sharp variants for other platforms.
    const bundledClaude =
      /^@anthropic-ai\+claude-agent-sdk-|^@anthropic-ai\+claude-code-/.test(d);
    if (!foreign && !bundledClaude) continue;
    const bytes = dirBytes(join(store, d));
    rmSync(join(store, d), { recursive: true, force: true });
    if (bundledClaude && !foreign) {
      prunedClaude++;
      prunedClaudeBytes += bytes;
    } else {
      pruned++;
      prunedBytes += bytes;
    }
  }
}
console.log(
  `pruned ${pruned} foreign-platform packages (${(prunedBytes / 1e6).toFixed(0)} MB)`,
);
console.log(
  `pruned ${prunedClaude} bundled Claude Code binary packages (${(prunedClaudeBytes / 1e6).toFixed(0)} MB)`,
);

step(`bun ${BUN_VERSION} for ${os}/${arch}`);
const bunAsset = `bun-${os}-${arch === "arm64" ? "aarch64" : "x64"}`;
const bunUrl = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${bunAsset}.zip`;
const zip = join(OUT, `${bunAsset}-${BUN_VERSION}.zip`);
if (!existsSync(zip)) {
  await sh(["curl", "-fsSL", "--retry", "3", "-o", zip, bunUrl]);
}
const binDir = join(STAGE, "bin");
mkdirSync(binDir, { recursive: true });
await sh(["unzip", "-o", "-q", zip, "-d", join(OUT, "bun-unzip")]);
cpSync(join(OUT, "bun-unzip", bunAsset, "bun"), join(binDir, "bun"));
await sh(["chmod", "755", join(binDir, "bun")]);

step("release.json");
writeFileSync(
  join(STAGE, "release.json"),
  JSON.stringify(
    {
      name,
      version,
      commit,
      os,
      arch,
      bun: BUN_VERSION,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);

step("tarball");
const tarball = join(OUT, `${name}.tar.gz`);
rmSync(tarball, { force: true });
// No Apple xattrs/resource forks in the archive: GNU tar on the box warns
// about them on every file otherwise.
await sh(
  ["tar", "--no-xattrs", "-C", join(OUT, "stage"), "-czf", tarball, name],
  { env: { COPYFILE_DISABLE: "1" } },
);
const mb = (statSync(tarball).size / 1e6).toFixed(0);
console.log(`${tarball} (${mb} MB)`);
console.log(`\nInstall: install.sh --artifact ${tarball}`);
