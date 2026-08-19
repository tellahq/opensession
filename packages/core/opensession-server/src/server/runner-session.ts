/**
 * Runner-backed session turns.
 *
 * A Runner owns only the workspace and detached run-host process. The server
 * remains the transcript, queue, approval, collaboration and RPC authority.
 * This deliberately uses the remote run-ws transport, not the command socket
 * as a second agent-event protocol.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { configuredServer } from "./config";
import { HostHandle, type HandleCallbacks, type HostLauncher } from "./host-client";
import { HOST_SPEC_NAME, runHostsDir, type RunHostSpec } from "../runner-host/protocol";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { registerRunToken, unregisterRunToken } from "./run-rpc";
import { launchRunnerHost, runnerHostAlive, runnerHostStatus } from "./runner-ws";
import { claimRunnerWorkload, getRunner, setRunnerWorkload } from "./runners";
import { registerRunWsHost, runWsConnector } from "./run-ws";
import type { UnifiedSession } from "./types";
import { interactiveMcpServers } from "./interactive-mcp";
import { interactiveFallbackModel } from "./models";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { commitAuthorFor } from "./shared/user-mappings";
import { makeAskHandler } from "./asks";
import type { McpScope } from "./runner-shared";
import type { StreamEvent } from "./agent-runner";
import type { ImageInput } from "./run-events";
import { journalClear, journalSet, type ActiveRunRecord } from "./run-journal";
import { writeJsonAtomic } from "./shared/atomic-write";

type RunnerLaunchOpts = {
	prompt: string;
	engineSessionId?: string;
	images?: ImageInput[];
	mcpServers?: McpScope;
	user?: string;
	reposNote?: string;
};

type RunnerEvents = AsyncGenerator<StreamEvent> & { runnerId: string };

function serverWsBase(): string {
	return configuredServer().publicBaseUrl.replace(/\/$/, "");
}

/** Start a turn in the session-owned workspace already materialized by this Runner. */
export async function maybeLaunchRunnerRun(
	session: UnifiedSession,
	opts: RunnerLaunchOpts,
): Promise<RunnerEvents | null> {
	const target = session.runner;
	if (!target) return null;
	if (!session.repo || !session.worktreeDir) throw new Error("Runner session is missing its repository workspace");
	const registeredRunner = getRunner(target.id);
	if (!registeredRunner)
		throw new Error("This Runner is no longer available for this session");
	const runner = claimRunnerWorkload(registeredRunner.id, { user: opts.user, repo: session.repo, sessionId: session.id, operation: "full session" });
	if (!runner) throw new Error("This Runner is no longer available for this session");

	const hostId = `rh-${Bun.randomUUIDv7()}`;
	const rpcToken = crypto.randomUUID();
	const wsToken = crypto.randomUUID();
	const hostDir = `${runHostsDir(OPENSESSION_SESSIONS_DIR)}/${hostId}`;
	mkdirSync(hostDir, { recursive: true });
	const spec: RunHostSpec = {
		hostId,
		osSessionId: session.id,
		prompt: opts.prompt,
		engineSessionId: opts.engineSessionId,
		cwd: session.worktreeDir,
		mode: session.mode,
		model: session.model,
		effort: session.effort,
		fastMode: session.fastMode,
		accountId: session.accountId,
		images: opts.images,
		mcpServers: opts.mcpServers ?? "all",
		proxyMcpServers: Object.keys(
			interactiveMcpServers(opts.user, session.id, opts.mcpServers ?? "all"),
		),
		rpcToken,
		wsToken,
		reposNote: opts.reposNote,
		confirmTools: STRIPE_CONFIRM_TOOLS,
		author: commitAuthorFor(opts.user, session.startedBy),
		user: opts.user,
		mcpGrantUser: session.startedBy || undefined,
		fallbackModel: interactiveFallbackModel(session.model),
		journalKind: "prompt",
	};
	writeJsonAtomic(`${hostDir}/${HOST_SPEC_NAME}`, spec);
	journalSet({
		runKey: session.id,
		osSessionId: session.id,
		prompt: opts.prompt,
		cwd: session.worktreeDir,
		mode: session.mode,
		mcpServers: opts.mcpServers ?? "all",
		user: opts.user,
		model: session.model,
		effort: session.effort,
		fastMode: session.fastMode,
		accountId: session.accountId,
		fallbackModel: interactiveFallbackModel(session.model),
		kind: "prompt",
		runnerId: runner.id,
		startedAt: new Date().toISOString(),
	});
	registerRunToken(rpcToken, { sessionId: session.id, user: opts.user });
	registerRunWsHost(hostId, wsToken);
	const hostSpecs = new Map<string, RunHostSpec>([[hostId, spec]]);

	const launcher: HostLauncher = {
		alive: async (_dir, meta) => runnerHostAlive(meta?.hostId || hostId) && runnerHostStatus(runner.id, {
			sessionId: session.id, repo: session.repo!, workspacePath: session.worktreeDir!, hostId: meta?.hostId || hostId, user: opts.user,
		}),
		newRunDir: (nextHostId) => `${runHostsDir(OPENSESSION_SESSIONS_DIR)}/${nextHostId}`,
		connector: (_dir, hostSpec) => runWsConnector(hostSpec.hostId),
		async writeSpec(dir, nextSpec) {
			mkdirSync(dir, { recursive: true });
			writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, nextSpec);
			hostSpecs.set(nextSpec.hostId, nextSpec);
			registerRunWsHost(nextSpec.hostId, nextSpec.wsToken!);
		},
		async launch(nextHostId, _dir) {
			const nextSpec = hostSpecs.get(nextHostId);
			if (!nextSpec) throw new Error(`Missing Runner host specification for ${nextHostId}`);
			await launchRunnerHost(runner.id, {
				sessionId: session.id, repo: session.repo!, user: opts.user,
				server: serverWsBase(), spec: nextSpec,
			});
		},
	};
	const callbacks: HandleCallbacks = {
		onAskUser: makeAskHandler(session.id),
		onSteerFailed: () => {}, // normal queue handling re-delivers a later prompt
	};
	let handle: HostHandle | undefined;
	try {
		handle = new HostHandle(hostDir, spec, callbacks, launcher);
		await handle.connectWithWait(20_000);
		const events = (async function* (): AsyncGenerator<StreamEvent> {
			try {
				yield* handle!.events();
			} finally {
				journalClear(session.id);
				setRunnerWorkload(runner.id, undefined, session.id);
			}
		})() as RunnerEvents;
		events.runnerId = runner.id;
		return events;
	} catch (error) {
		handle?.abandon();
		unregisterRunToken(rpcToken);
		journalClear(session.id);
		setRunnerWorkload(runner.id, undefined, session.id);
		throw error;
	}
}

function readRunnerHostSpec(path: string): RunHostSpec | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as RunHostSpec;
	} catch {
		return null;
	}
}

/** Reattach a still-running Runner host after an Open Session restart. A
 * missing remote host fails recovery explicitly instead of falling back to the
 * server machine and crossing the selected execution boundary. */
export async function resumeRunnerRun(
	run: ActiveRunRecord,
	callbacks: HandleCallbacks,
): Promise<AsyncGenerator<StreamEvent> | null> {
	if (!run.osSessionId || !run.runnerId) return null;
	const { findSession } = await import("./session-cache");
	const session = findSession(run.osSessionId);
	if (!session?.runner || session.runner.id !== run.runnerId || !session.repo || !session.worktreeDir) return null;
	const hostsRoot = runHostsDir(OPENSESSION_SESSIONS_DIR);
	if (!existsSync(hostsRoot)) return null;
	const candidates = readdirSync(hostsRoot)
		.map((name) => {
			const dir = `${hostsRoot}/${name}`;
			return { dir, spec: readRunnerHostSpec(`${dir}/${HOST_SPEC_NAME}`) };
		})
		.filter((entry): entry is { dir: string; spec: RunHostSpec } => {
			const candidate = entry.spec;
			return Boolean(
				candidate &&
				candidate.osSessionId === session.id &&
				candidate.cwd === session.worktreeDir &&
				candidate.wsToken &&
				candidate.rpcToken,
			);
		});
	const candidate = candidates.at(-1);
	if (!candidate) return null;
	const spec = candidate.spec;
	registerRunToken(spec.rpcToken!, { sessionId: session.id, user: spec.user });
	registerRunWsHost(spec.hostId, spec.wsToken!);
	const alive = await runnerHostStatus(run.runnerId, {
		sessionId: session.id,
		repo: session.repo,
		workspacePath: session.worktreeDir,
		hostId: spec.hostId,
		user: spec.user,
	});
	if (!alive) {
		unregisterRunToken(spec.rpcToken);
		return null;
	}
	const hostSpecs = new Map<string, RunHostSpec>([[spec.hostId, spec]]);
	const launcher: HostLauncher = {
		alive: async (_dir, meta) => runnerHostAlive(meta?.hostId || spec.hostId) && runnerHostStatus(run.runnerId!, {
			sessionId: session.id, repo: session.repo!, workspacePath: session.worktreeDir!, hostId: meta?.hostId || spec.hostId, user: spec.user,
		}),
		newRunDir: (hostId) => `${runHostsDir(OPENSESSION_SESSIONS_DIR)}/${hostId}`,
		connector: (_dir, hostSpec) => runWsConnector(hostSpec.hostId),
		async writeSpec(dir, nextSpec) {
			mkdirSync(dir, { recursive: true });
			writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, nextSpec);
			hostSpecs.set(nextSpec.hostId, nextSpec);
			registerRunWsHost(nextSpec.hostId, nextSpec.wsToken!);
		},
		async launch(hostId) {
			const nextSpec = hostSpecs.get(hostId);
			if (!nextSpec) throw new Error(`Missing Runner host specification for ${hostId}`);
			await launchRunnerHost(run.runnerId!, {
				sessionId: session.id, repo: session.repo!, user: spec.user, server: serverWsBase(), spec: nextSpec,
			});
		},
	};
	setRunnerWorkload(run.runnerId, { sessionId: session.id, operation: "full session", startedAt: run.startedAt });
	const handle = new HostHandle(candidate.dir, spec, callbacks, launcher);
	try {
		await handle.connectWithWait(20_000);
		return (async function* (): AsyncGenerator<StreamEvent> {
			try { yield* handle.events(); }
			finally { setRunnerWorkload(run.runnerId!, undefined, session.id); }
		})();
	} catch (error) {
		handle.abandon();
		setRunnerWorkload(run.runnerId, undefined, session.id);
		throw error;
	}
}
