/**
 * Front controller for the compiled single-executable build.
 *
 * `bun build --compile` produces one `opensession` binary from THIS entry. The
 * same binary plays four roles that run as four separate processes from source
 * (`opensession.ts`, `scripts/cli.ts`, `src/runner-host/host.ts`,
 * `src/runner-host/mcp-proxy.ts`); a compiled process has no `bun`/`.ts` tree to
 * re-exec, so it re-invokes itself with a leading subcommand instead. The spawn
 * sites emit those subcommands via src/runner-host/exe.ts (runnerHostArgv /
 * mcpProxyArgv); this file routes them back to the right module.
 *
 * argv shape: a compiled Bun binary keeps the same layout as `bun run <file>` —
 * process.argv is [exe, <in-binary main path>, ...userArgs] — so the subcommand
 * lands at process.argv[2]. For the side-entrypoints the subcommand token is
 * spliced out so the target module sees the exact argv it gets from source
 * (host.ts still reads its spec at argv[2]); the CLI's argv already matches.
 *
 *   opensession runner-host <spec>  → host.ts   (spec at argv[2] after splice)
 *   opensession mcp-proxy           → mcp-proxy.ts (config from env)
 *   opensession server              → opensession.ts (the HTTP/WS server)
 *   opensession <anything else>     → scripts/cli.ts (onboard, start, doctor, …)
 *
 * Each target runs on import (top-level side effects). Only source mode ever
 * runs those modules directly; nothing here executes under `bun run <file>`.
 */

export {}; // module marker so top-level await is allowed

// The source install runs through a bash shim that puts the engine CLIs
// (opencode, claude) on PATH before handing off; the compiled binary has no
// such shim, so do it here. Without this a thin PATH (a non-login shell, cron,
// the service unit if it ever loses its Environment=) resolves no engine, and
// the server finds nothing to run turns on. Only this binary imports main.ts.
{
  const { homedir } = await import("os");
  const { join } = await import("path");
  const extra = [join(homedir(), ".opencode", "bin"), join(homedir(), ".local", "bin")];
  const seen = new Set(process.env.PATH ? process.env.PATH.split(":") : []);
  const add = extra.filter((d) => !seen.has(d));
  if (add.length) process.env.PATH = [...add, process.env.PATH ?? ""].filter(Boolean).join(":");
}

const sub = process.argv[2];
if (process.env.OPENSESSION_DISPATCH_DEBUG === "1")
	console.error(
		`[dispatch] sub=${JSON.stringify(sub)} execPath=${process.execPath} argv=${JSON.stringify(process.argv)}`,
	);

if (sub === "runner-host") {
	process.argv.splice(2, 1);
	await import("./runner-host/host");
} else if (sub === "mcp-proxy") {
	process.argv.splice(2, 1);
	await import("./runner-host/mcp-proxy");
} else if (sub === "server") {
	process.argv.splice(2, 1);
	// Surface a boot failure with a clear origin: a compiled binary's otherwise
	// opaque top-level-await rejection becomes a labelled message + exit 1.
	try {
		await import("../opensession");
	} catch (e) {
		console.error("[opensession] server failed to boot:", e);
		process.exit(1);
	}
} else {
	// The CLI reads process.argv.slice(2); a compiled binary already produces
	// that shape ([exe, main, ...args]), so no realignment is needed.
	await import("../scripts/cli");
}
