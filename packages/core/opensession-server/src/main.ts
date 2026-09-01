/**
 * Front controller for the compiled single-executable build.
 *
 * `bun build --compile` produces one `opensession` binary from THIS entry. The
 * same binary plays five roles that run as separate processes from source
 * (`opensession.ts`, `scripts/cli.ts`, `src/runner-host/host.ts`,
 * `src/runner-host/mcp-proxy.ts`, `src/server/transcript-search-worker.ts`). A
 * compiled process has no `bun`/`.ts` tree to re-exec, so it re-invokes itself
 * with a leading subcommand instead. The spawn
 * sites emit those subcommands via src/runner-host/exe.ts; this file routes
 * them back to the right module.
 *
 * argv shape: a compiled Bun binary keeps the same layout as `bun run <file>` —
 * process.argv is [exe, <in-binary main path>, ...userArgs] — so the subcommand
 * lands at process.argv[2]. For the side-entrypoints the subcommand token is
 * spliced out so the target module sees the exact argv it gets from source
 * (host.ts still reads its spec at argv[2]); the CLI's argv already matches.
 *
 *   opensession runner-host <spec>  → host.ts   (spec at argv[2] after splice)
 *   opensession mcp-proxy           → mcp-proxy.ts (config from env)
 *   opensession executor            → executor/main.ts (fixed launch policy)
 *   opensession session-kernel-service → session-kernel-service.ts
 *   opensession transcript-search-worker
 *                                    → transcript-search-worker.ts (JSON via stdio)
 *   opensession server              → opensession.ts (the HTTP/WS server)
 *   opensession <anything else>     → scripts/cli.ts (onboard, start, doctor, …)
 *
 * Targets run on import or expose a small entry function for this dispatcher.
 * Only source mode runs the modules directly.
 */

export {}; // module marker so top-level await is allowed

// pi-ai hides its OAuth flow modules behind a variable-specifier dynamic
// import so bundlers cannot follow them into Node-only flow code. A compiled
// binary therefore ships without them and every OAuth-derived pi model fails
// with "Cannot find module './openai-codex.js'". Register the statically
// bundled flows up front, exactly like pi's own standalone CLI entrypoint.
{
  const { registerBunOAuthFlows } =
    await import("@earendil-works/pi-ai/bun-oauth");
  registerBunOAuthFlows();
}

// The source install runs through a bash shim that puts the `claude` CLI on
// PATH before handing off; the compiled binary has no such shim, so do it here.
// Without this a thin PATH (a non-login shell, cron, the service unit if it
// ever loses its Environment=) resolves no `claude`, and Anthropic turns find
// nothing to exec. Only this binary imports main.ts.
{
  const { homedir } = await import("os");
  const { join } = await import("path");
  const extra = [join(homedir(), ".local", "bin")];
  const seen = new Set(process.env.PATH ? process.env.PATH.split(":") : []);
  const add = extra.filter((d) => !seen.has(d));
  if (add.length)
    process.env.PATH = [...add, process.env.PATH ?? ""]
      .filter(Boolean)
      .join(":");
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
} else if (sub === "executor") {
  process.argv.splice(2, 1);
  const { runExecutor } = await import("./executor/main");
  await runExecutor();
} else if (sub === "session-kernel-service") {
  process.argv.splice(2, 1);
  const { runSessionKernelService } = await import("./session-kernel-service");
  await runSessionKernelService();
} else if (sub === "transcript-search-worker") {
  process.argv.splice(2, 1);
  const { runTranscriptSearchWorker } =
    await import("./server/transcript-search-worker");
  try {
    await runTranscriptSearchWorker();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
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
  await import("../../../../scripts/cli");
}
