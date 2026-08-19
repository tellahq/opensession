/**
 * Compiled-binary awareness for the self-re-exec paths.
 *
 * Open Session runs two ways:
 *   - from source, under `bun` (`bun run opensession.ts`, `bun scripts/cli.ts`),
 *     where a side-entrypoint is reached as `bun run <entry.ts>`; and
 *   - as a single `bun build --compile` executable, where `process.execPath` is
 *     the executable itself (not `bun`) and there is no `.ts` tree to `run` —
 *     the same executable re-invokes itself with a subcommand instead
 *     (`opensession runner-host <spec>`, `opensession mcp-proxy`). src/main.ts
 *     is the front controller that dispatches those subcommands.
 *
 * The spawn sites build their argv through the helpers here so one detection
 * decides the shape in both modes. Kept dependency-free (only `node:path`) so
 * the run-host and MCP proxy can import it without dragging in the server graph.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * True when this process is the compiled executable rather than `bun`.
 *
 * A `bun build --compile` binary runs as its own executable, so
 * `basename(process.execPath)` is `opensession` (or whatever the artefact was
 * named), never `bun`. Running from source — including `bun test` and
 * `bun --hot` — always execs through a binary named `bun`.
 */
export function isCompiledBinary(): boolean {
	return !/^bun(\b|-|\.|$)/i.test(basename(process.execPath));
}

/**
 * argv to launch the run host for the spec already written at `specPath`.
 * `bun`/`entry` are the source-mode interpreter and entrypoint; compiled mode
 * ignores them and re-execs this binary as `<exe> runner-host <spec>`.
 */
export function runnerHostArgv(bun: string, entry: string, specPath: string): string[] {
	return isCompiledBinary()
		? [process.execPath, "runner-host", specPath]
		: [bun, "run", entry, specPath];
}

/**
 * argv to launch the stdio MCP proxy. Compiled mode re-execs this binary as
 * `<exe> mcp-proxy`; source mode runs `bun [--smol] run <entry.ts>`. `--smol`
 * is a bun runtime flag with no compiled-binary equivalent, so it is dropped
 * there (correctness over the RSS trim; the proxy is still a thin stdio pipe).
 */
export function mcpProxyArgv(bun: string, entry: string, opts: { smol?: boolean } = {}): string[] {
	return isCompiledBinary()
		? [process.execPath, "mcp-proxy"]
		: [bun, ...(opts.smol ? ["--smol"] : []), "run", entry];
}

/** The release-artefact subdir holding the opencode plugins the external
 *  `opencode serve` / meridian processes load from disk (the meridian bridge
 *  stack in `node_modules` plus the `opencode-plugin-*.js` files). */
export const OPENCODE_PLUGINS_SIDECAR = "opencode-plugins";

/**
 * Directory the opencode/meridian plugin files and packages are resolved from.
 *
 * Source mode: `sourceDir` (the caller's `import.meta.dir`) — the `.js` plugins
 * sit there and `node_modules` resolves by walking up the checkout, exactly as
 * before. Compiled binary: `import.meta.dir` is `/$bunfs/root`, a path the
 * EXTERNAL opencode process cannot read, so use the sidecar shipped beside the
 * binary in the release dir instead (the same dir `paths.ts` REPO_ROOT resolves
 * to when compiled: the realpath of the executable's directory).
 */
export function pluginsRoot(sourceDir: string): string {
	if (!isCompiledBinary()) return sourceDir;
	let releaseDir: string;
	try {
		releaseDir = dirname(realpathSync(process.execPath));
	} catch {
		releaseDir = dirname(process.execPath);
	}
	return join(releaseDir, OPENCODE_PLUGINS_SIDECAR);
}
