#!/usr/bin/env bun
/**
 * Guard: no server or executor module may bind a socket, arm a timer or spawn
 * a process just by being imported.
 *
 * Why this exists. interactive-mcp.ts called startRunRpcServer() at module
 * scope, and that file sits on the import chain of most of the server graph —
 * so any script, one-off `bun -e`, or test that touched the chain unlinked the
 * LIVE server's run-rpc socket and bound its own, then exited and left a dead
 * inode behind. Every in-flight run's MCP calls died until the heal ticker
 * noticed (2026-07-16, 2026-07-17, and four separate times on 2026-08-16).
 * The same shape had quieter versions all over: session-index's sweeper wrote
 * the live search index from `bun test`, preview-pool's sweep docker-rm'd the
 * warm pool 20s after any import, github-auth rotated live GitHub grants from
 * every run host, and a handful of scripts simply hung because a ticker kept
 * the loop alive (that is what a `process.exit(0)` at the end of a script is
 * usually papering over).
 *
 * How it measures. Importing a module and watching what it *does* is the only
 * check that survives refactors: a violation is usually a call to some
 * innocent-looking start function three files away, which no grep and no
 * single-file AST scan can see. So this spawns a child that replaces the
 * resource-creating globals with recording stubs — nothing real is ever
 * created — points the state dirs at a scratch dir, imports every module one
 * at a time, and reports each hit with the frame that made it.
 *
 * Nothing is exempt. frontend-build.ts was, for a day: it compiled the SPA at
 * import when .frontend-dist was stale, and the probe pre-stubbed the built
 * bundle so the scan came back clean around it. That is now
 * `ensureFrontendBuilt()`, awaited in opensession.ts before the port binds, so
 * the module allocates the bundle object and nothing else. If a module ever
 * needs an exemption again, prefer moving the resource — an exemption here is
 * a hole in the only check that sees through a start function three files away.
 *
 * Usage: bun scripts/check-module-side-effects.ts [--json]
 * Exit 1 when anything is created at import time.
 * scripts/check-module-side-effects.test.ts runs it, so `bun test` fails too.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

export const REPO_ROOT = resolve(import.meta.dir, "..");

export interface SideEffectHit {
	/** setInterval, Bun.serve, … */
	kind: string;
	/** the module whose import triggered it (may differ from `frame`) */
	module: string;
	/** repo-relative file:line that actually called it */
	frame: string;
}

export interface SideEffectScan {
	scanned: number;
	hits: SideEffectHit[];
	failed: { module: string; error: string }[];
}


export const EXECUTABLE_ENTRYPOINT_EXEMPTIONS = new Set([
	"packages/core/opensession-server/src/runner-host/host.ts",
	"packages/core/opensession-server/src/runner-host/mcp-proxy.ts",
	// Bun Worker entrypoints do not report import.meta.main; importing this file
	// intentionally starts the actor worker.
	"packages/core/opensession-server/src/session-kernel-worker.ts",
]);

/** Every module a server process could plausibly pull in. Tests and test
 *  helpers are excluded: they are not on any live import chain. */
export function serverModules(root = REPO_ROOT): string[] {
	const glob = new Bun.Glob(
		"packages/core/opensession-server/src/{server,executor,runner-host,agent-host}/**/*.ts",
	);
	return [...glob.scanSync({ cwd: root }),
		"packages/core/opensession-server/src/session-kernel-worker.ts"]
		.filter((p) =>
			!p.endsWith(".test.ts") &&
			!p.includes("/testing/") &&
			!EXECUTABLE_ENTRYPOINT_EXEMPTIONS.has(p)
		)
		.sort();
}

/** Run the scan in a fresh child process. Never throws for a violation — the
 *  caller decides what to do with the hits. */
export async function scanModuleSideEffects(
	modules: string[] = serverModules(),
): Promise<SideEffectScan> {
	const scratch = mkdtempSync(`${tmpdir()}/os-side-effect-scan-`);
	try {
		const listPath = `${scratch}/modules.json`;
		const outPath = `${scratch}/result.json`;
		await Bun.write(listPath, JSON.stringify(modules));
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			// Isolate every state path the graph might resolve at import.
			OPENSESSION_STATE_DIR: scratch,
			OPENSESSION_SESSIONS_DIR: `${scratch}/sessions`,
			OPENSESSION_SEARCH_DB: `${scratch}/search.db`,
		};
		// NODE_ENV=test is one of the guards under test (run-rpc skips binding
		// under it), so the child must not inherit `bun test`'s value — that
		// would hide exactly the regression this guard exists to catch.
		delete env.NODE_ENV;
		const proc = Bun.spawn(
			[process.execPath, `${import.meta.dir}/module-side-effect-probe.ts`, listPath, outPath],
			{ cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" },
		);
		const code = await proc.exited;
		if (code !== 0) {
			const err = await new Response(proc.stderr).text();
			throw new Error(`side-effect probe exited ${code}:\n${err.slice(-2000)}`);
		}
		return (await Bun.file(outPath).json()) as SideEffectScan;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

export function formatScan(scan: SideEffectScan): string {
	const lines: string[] = [];
	for (const h of scan.hits) {
		lines.push(
			`  ${h.kind.padEnd(14)} ${h.frame}${h.module === h.frame ? "" : `   (imported via ${h.module})`}`,
		);
	}
	return lines.join("\n");
}

if (import.meta.main) {
	const scan = await scanModuleSideEffects();
	if (process.argv.includes("--json")) {
		console.log(JSON.stringify(scan, null, 2));
	}
	for (const f of scan.failed) {
		console.error(`could not import ${f.module}: ${f.error}`);
	}
	if (scan.hits.length === 0 && scan.failed.length === 0) {
		console.log(
			`ok — ${scan.scanned} server/executor modules import cleanly (no listener, timer or subprocess at import time)`,
		);
		process.exit(0);
	}
	if (scan.hits.length) {
		console.error(
			`\n${scan.hits.length} resource(s) created at import time by ${scan.scanned} modules:\n${formatScan(scan)}\n`,
		);
		console.error(
			"Move each one behind an exported start*/ensure* function and call it from\n" +
				"opensession.ts (the boot block for tickers, the listener block for binds),\n" +
				"or arm it lazily on first real use. See scripts/check-module-side-effects.ts.",
		);
	}
	process.exit(1);
}
