/**
 * Compiled-binary awareness for the self-re-exec paths.
 *
 * Open Session runs two ways:
 *   - from source, under `bun` (`bun run opensession.ts`, `bun scripts/cli.ts`),
 *     where a side-entrypoint is reached as `bun run <entry.ts>`; and
 *   - as a single `bun build --compile` executable, where `process.execPath` is
 *     the executable itself (not `bun`) and there is no `.ts` tree to `run`.
 *     The same executable re-invokes itself with a subcommand instead, such as
 *     `opensession runner-host <spec>`, `opensession mcp-proxy`, or
 *     `opensession transcript-search-worker`. src/main.ts is the front
 *     controller that dispatches those subcommands.
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
export function runnerHostArgv(
  bun: string,
  entry: string,
  specPath: string,
): string[] {
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
export function mcpProxyArgv(
  bun: string,
  entry: string,
  opts: { smol?: boolean } = {},
): string[] {
  return isCompiledBinary()
    ? [process.execPath, "mcp-proxy"]
    : [bun, ...(opts.smol ? ["--smol"] : []), "run", entry];
}

/** argv to run the read-only transcript search worker. */
export function transcriptSearchWorkerArgv(
  bun: string,
  entry: string,
): string[] {
  return isCompiledBinary()
    ? [process.execPath, "transcript-search-worker"]
    : [bun, entry];
}

/**
 * Resolve a Web Worker entry that survives `bun build --compile`, which does not
 * embed Worker entry points: at runtime `new Worker(new URL("./w.ts",
 * import.meta.url))` resolves to a bunfs path that was never bundled and fails
 * with ModuleNotFound. A compiled binary loads the worker from a sibling
 * `<name>.js` staged beside the executable (scripts/build-compile.ts, next to
 * the sharp sidecar); a source checkout runs the TypeScript entry at `sourceUrl`.
 * Keep the sidecar names in sync with build-compile's WORKER_SIDECARS list.
 */
export function workerEntry(
  sidecarName: string,
  sourceUrl: string | URL,
): string | URL {
  return isCompiledBinary()
    ? join(dirname(process.execPath), sidecarName)
    : sourceUrl;
}
