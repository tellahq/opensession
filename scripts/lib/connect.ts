/**
 * `opensession connect` — attach this machine to a server as a Runner.
 *
 * The motivating case is platform-locked work: an iOS build needs macOS with
 * Xcode, a Windows build needs MSVC, and neither can happen on the Linux box
 * running the server. Sandboxes do not help — they are ephemeral Linux
 * containers. A Runner is a persistent machine you own.
 *
 * Deliberately NOT the same thing as a tunnel product. Tools like T3 Connect
 * solve *ingress* (reach my box from my phone, through NAT, without a VPN).
 * This solves *execution* (run this build somewhere that can build it), and it
 * requires the tailnet rather than working around the lack of one — which means
 * no relay to operate and no bandwidth to pay for.
 *
 * The credential lives in ~/.opensession/runner.json (0600). Pairing codes are
 * one-time and expire in ten minutes, and the server records the address it saw
 * rather than one we claim.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { arch, cpus, hostname, platform, tmpdir, totalmem, userInfo } from "os";
import { dirname, join, resolve } from "path";
import { OPENSESSION_HOME } from "./paths";
import { bold, dim, fail, heading, info, ok, run, warn } from "./ui";
import { localAutomationToken } from "./local-auth";
import { isCompiledBinary, runnerHostArgv } from "../../src/runner-host/exe";

const IDENTITY_PATH = join(OPENSESSION_HOME, "runner.json");
const HEARTBEAT_MS = 60_000;
const RUNNER_HOST_ENTRY = resolve(import.meta.dir, "../../src/runner-host/host.ts");
const RUNNER_SERVICE_LABEL = "dev.tella.opensession.runner";
export const RUNNER_TASK_NAME = "OpenSessionRunner";

type Identity = { server: string; id: string; token: string; name: string };

/**
 * Windows ships PowerShell, schtasks and the rest of its core tools at a fixed
 * location under %SystemRoot%\System32. Looking them up through PATH makes the
 * Runner's core function depend on a variable that any installer, group policy
 * or truncated `setx` can damage, and the failures are miserable: every
 * delegated command dies at spawn with `ENOENT ... uv_spawn 'powershell.exe'`,
 * and the sign-in scheduled task launches nothing at all, so the Runner just
 * never appears online with no error anywhere. Build the path instead.
 *
 * The segments are joined with backslashes by hand rather than path.join, so
 * the result is the same string when these functions are unit tested on Linux.
 * Exported for that reason: no Windows box runs the suite locally.
 */
export function windowsSystem32(binary: string, systemRoot?: string): string {
	const root = (systemRoot ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows").replace(/[\\/]+$/, "");
	return `${root}\\System32\\${binary.replace(/^[\\/]+/, "")}`;
}

/** The fully qualified Windows PowerShell, which is what the scheduled task's
 * <Command> has to name. Task Scheduler resolves a bare name through whatever
 * PATH the logon session happens to have. */
export function windowsPowerShellPath(systemRoot?: string): string {
	return windowsSystem32("WindowsPowerShell\\v1.0\\powershell.exe", systemRoot);
}

export type WindowsBinaryProbe = {
	systemRoot?: string;
	exists?: (path: string) => boolean;
	which?: (binary: string) => string | null;
};

/**
 * Resolution order for the shell every delegated command runs under: the fully
 * qualified Windows PowerShell if it is really there, then PowerShell 7 if
 * PATH can find it, then the bare name as a last resort. The last step keeps
 * today's behaviour rather than regressing a machine that works.
 */
export function resolveWindowsShell(probe: WindowsBinaryProbe = {}): string {
	const exists = probe.exists ?? existsSync;
	const which = probe.which ?? ((binary: string) => Bun.which(binary));
	const qualified = windowsPowerShellPath(probe.systemRoot);
	if (exists(qualified)) return qualified;
	return which("pwsh.exe") || which("pwsh") || "powershell.exe";
}

/** Same idea for schtasks.exe, which installRunnerService needs before it can
 * register anything. Undefined means neither the known path nor PATH has it,
 * which is worth saying out loud rather than skipping in silence. */
export function resolveWindowsSchtasks(probe: WindowsBinaryProbe = {}): string | undefined {
	const exists = probe.exists ?? existsSync;
	const which = probe.which ?? ((binary: string) => Bun.which(binary));
	const qualified = windowsSystem32("schtasks.exe", probe.systemRoot);
	if (exists(qualified)) return qualified;
	return which("schtasks.exe") || which("schtasks") || undefined;
}

/** The argv behind every delegated command. Exported so CI can spawn exactly
 * what the exec path spawns, with a deliberately broken PATH. */
export function runnerExecCommand(command: string, host: string = platform()): string[] {
	return host === "win32"
		? [resolveWindowsShell(), "-NoProfile", "-NonInteractive", "-Command", command]
		: ["bash", "-lc", command];
}

async function readIdentity(): Promise<Identity | undefined> {
  if (!existsSync(IDENTITY_PATH)) return undefined;
  try {
    return JSON.parse(await Bun.file(IDENTITY_PATH).text());
  } catch {
    return undefined;
  }
}

/** What this machine can do that the server's own box may not. */
async function detectCapabilities(): Promise<string[]> {
  const found: string[] = [];
  const has = async (bin: string) => Boolean(Bun.which(bin));

  if (platform() === "darwin") {
    // xcodebuild exists as a stub without the full Xcode; -version fails then.
    if (await has("xcodebuild")) {
      const { code } = await run(["xcodebuild", "-version"]);
      if (code === 0) found.push("xcode");
    }
    if (await has("swift")) found.push("swift");
  }
  if (platform() === "win32" && (await has("msbuild"))) found.push("msbuild");

  for (const [bin, cap] of [
    ["docker", "docker"],
    ["cargo", "rust"],
    ["go", "go"],
    ["bun", "bun"],
    ["dotnet", "dotnet"],
    ["ffmpeg", "ffmpeg"],
    ["ollama", "ollama"],
    ["vllm", "vllm"],
  ] as const) {
    if (await has(bin)) found.push(cap);
  }
  return found;
}

async function commandOutput(args: string[]): Promise<string> {
	try {
		const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
		const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return code === 0 ? output.trim() : "";
	} catch {
		return "";
	}
}

async function detectResources(): Promise<Record<string, unknown>> {
	const resources: Record<string, unknown> = {
		cpuCores: cpus().length,
		memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
	};
	if (platform() === "win32") {
		const probe = runnerExecCommand("(Get-PSDrive ((Get-Location).Drive.Name)).Free");
		const free = Number(await commandOutput(probe));
		if (Number.isFinite(free) && free > 0) resources.freeDiskGb = Math.round((free / 1024 ** 3) * 10) / 10;
		// Silence here used to register a Runner with no freeDiskGb and no clue why.
		else warn("free disk space was not measured", `${probe[0]} did not report it`);
	} else {
		const disk = await commandOutput(["df", "-Pk", "."]);
		const diskLine = disk.split("\n").at(-1)?.trim().split(/\s+/);
		if (diskLine && Number.isFinite(Number(diskLine.at(-3)))) {
			resources.freeDiskGb = Math.round((Number(diskLine.at(-3)) * 1024 / 1024 ** 3) * 10) / 10;
		}
	}
	const nvidia = await commandOutput(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"]);
	if (nvidia) {
		const [model, vram, driver] = nvidia.split("\n")[0].split(",").map((part) => part.trim());
		const cudaVersion = (await commandOutput(["nvidia-smi"])).match(/CUDA Version:\s*([\d.]+)/)?.[1];
		resources.gpu = { kind: "nvidia", model, vramGb: Number.isFinite(Number(vram)) ? Math.round(Number(vram) / 102.4) / 10 : undefined, driver, cuda: cudaVersion };
	} else if (platform() === "darwin") {
		const displays = await commandOutput(["system_profiler", "SPDisplaysDataType", "-json"]);
		try {
			const display = JSON.parse(displays).SPDisplaysDataType?.[0] as Record<string, unknown> | undefined;
			if (display) resources.gpu = { kind: "apple", model: String(display.sppci_model ?? display._name ?? "Apple GPU"), metal: Boolean(display.spdisplays_metal) };
		} catch {}
	} else {
		const rocm = await commandOutput(["rocm-smi", "--showproductname", "--showmeminfo", "vram"]);
		if (rocm) {
			const model = rocm.split("\n").find((line) => /card series|product name/i.test(line))?.split(":").at(-1)?.trim();
			resources.gpu = { kind: "amd", ...(model ? { model } : {}), rocm: (await commandOutput(["rocm-smi", "--showversion"])).match(/[\d.]+/)?.[0] };
		} else {
			const intel = await commandOutput(["lspci"]);
			const line = intel.split("\n").find((value) => /vga|3d controller/i.test(value) && /intel/i.test(value));
			if (line) resources.gpu = { kind: "intel", model: line.split(":").slice(2).join(":").trim() || "Intel GPU" };
		}
	}
	const inference: Array<{ runtime: string; models: string[] }> = [];
	const ollama = await commandOutput(["ollama", "list"]);
	if (ollama) {
		const models = ollama.split("\n").slice(1).map((line) => line.trim().split(/\s+/)[0]).filter((model) => model && model.length <= 160).slice(0, 64);
		inference.push({ runtime: "ollama", models });
	}
	if (await commandOutput(["vllm", "--version"])) inference.push({ runtime: "vllm", models: [] });
	if (inference.length) resources.localInference = inference;
	return resources;
}

function normalizeServer(url: string): string {
  let value = url.trim().replace(/\/+$/, "");
  if (!value) return "";
  if (!/^https?:\/\//.test(value)) value = `http://${value}`;
  return value;
}

export type ConnectOptions = { server?: string; code?: string; name?: string; label?: string };

export async function connect(opts: ConnectOptions): Promise<number> {
  heading("Connect this machine");

  const server = normalizeServer(opts.server ?? "");
  if (!server) {
    fail("--server is required", "e.g. --server http://100.64.12.34:3850");
    return 1;
  }
  if (!opts.code) {
    fail("--code is required", "get one from the server with `opensession runners pair`");
    return 1;
  }

  const name = opts.name?.trim() || hostname().replace(/\.local$/, "");
	const capabilities = await detectCapabilities();
	const resources = await detectResources();

  info(dim(`server        ${server}`));
  info(dim(`this machine  ${name} (${platform()}/${arch()})`));
  info(dim(`capabilities  ${capabilities.join(", ") || "none detected"}`));

  let response: Response;
  try {
    response = await fetch(`${server}/api/runners/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: opts.code,
        name,
        platform: platform(),
        arch: arch(),
		capabilities,
		resources,
        label: opts.label,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    fail(`could not reach ${server}`, (err as Error).message);
    info(dim("  the server must be reachable from this machine — usually the tailnet"));
    return 1;
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}) as any);
    fail(`registration refused (${response.status})`, body?.error ?? "");
    if (response.status === 403) {
      info(dim("  either the pairing code is wrong/expired, or this machine is not"));
      info(dim("  on the tailnet — see docs/setup/networking.md"));
    }
    return 1;
  }

  const { runner, token } = (await response.json()) as { runner: { id: string }; token: string };

  mkdirSync(OPENSESSION_HOME, { recursive: true });
  await Bun.write(IDENTITY_PATH, JSON.stringify({ server, id: runner.id, token, name }, null, 2) + "\n");
  chmodSync(IDENTITY_PATH, 0o600);

  ok(`registered as ${name}`, runner.id);
  info(dim(`  credential written to ${IDENTITY_PATH} (0600)`));

	if (await installRunnerService()) return 0;
	heading("Next");
	info(`${bold("opensession runner run")}    hold the outbound control channel open`);
	info(dim("  install a service manager, then run `opensession runner service install`"));
	return 0;
}

function runnerCommandPath(): string {
	return process.argv[1] || "opensession";
}

/** Env keys a Windows child process cannot function without. PowerShell fails
 * to start with no SystemRoot, git resolves its config through USERPROFILE and
 * APPDATA, and PATHEXT is how .cmd/.bat resolution works at all. Everything
 * else (tokens, keys) is deliberately withheld, matching the Unix branch. */
const WINDOWS_ENV_KEYS = new Set([
	"PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
	"TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA",
	"LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
	"PROGRAMW6432", "ALLUSERSPROFILE", "PUBLIC", "USERNAME", "USERDOMAIN",
	"NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
]);

/** The three System32 directories a Windows shell session cannot work without:
 * the tools themselves, Windows PowerShell, and WMI (which `Get-CimInstance`
 * and much of what people write in a delegated command reach for). */
function windowsCorePathDirs(systemRoot?: string): string[] {
	return [
		windowsSystem32("", systemRoot).replace(/\\$/, ""),
		windowsSystem32("WindowsPowerShell\\v1.0", systemRoot),
		windowsSystem32("Wbem", systemRoot),
	];
}

/**
 * Put the core System32 directories back on a PATH that is missing them.
 *
 * Resolving our own spawn at a known path fixes the spawn, and nothing else:
 * the command we then hand to PowerShell is written by a person or an agent and
 * will say `git`, `where`, `robocopy`, `Get-CimInstance`. On the machine that
 * prompted this, all of those would still fail inside a shell that started
 * fine. Repairing the child's PATH is what makes one bootstrap command enough,
 * with no registry edit and no elevation. The machine's own PATH is left
 * untouched; this only shapes what the Runner's children inherit.
 *
 * Exported and pure so it is testable off Windows.
 */
export function repairWindowsPath(current: string | undefined, systemRoot?: string): string {
	const present = new Set(
		(current || "").split(";").map((part) => part.trim().replace(/[\\/]+$/, "").toLowerCase()).filter(Boolean),
	);
	const missing = windowsCorePathDirs(systemRoot).filter((dir) => !present.has(dir.toLowerCase()));
	if (!missing.length) return current || "";
	return current ? `${missing.join(";")};${current}` : missing.join(";");
}

/** Matched case-insensitively because Windows environments mix Path, PATH and
 * SystemRoot freely; the original spelling is kept on the way through.
 * Exported for tests: no Windows box runs this suite locally. */
export function windowsRunnerEnvironment(source: Record<string, string | undefined> = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value && WINDOWS_ENV_KEYS.has(key.toUpperCase())) env[key] = value;
	}
	const systemRoot = Object.entries(env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1];
	const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "Path";
	env[pathKey] = repairWindowsPath(env[pathKey], systemRoot);
	return env;
}

function runnerEnvironment(): Record<string, string> {
	if (platform() === "win32") return windowsRunnerEnvironment();
	return {
		PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
		HOME: process.env.HOME || "/tmp",
	};
}

/** Rendered separately for a testable, deliberately narrow service contract. */
export function runnerLaunchdPlist(command = runnerCommandPath(), bun = process.execPath): string {
	const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${RUNNER_SERVICE_LABEL}</string><key>ProgramArguments</key><array><string>${xml(bun)}</string><string>${xml(command)}</string><string>runner</string><string>run</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>${xml(join(OPENSESSION_HOME, "runner.log"))}</string><key>StandardErrorPath</key><string>${xml(join(OPENSESSION_HOME, "runner.log"))}</string></dict></plist>\n`;
}

export function runnerSystemdUnit(command = runnerCommandPath(), bun = process.execPath): string {
	return `[Unit]\nDescription=Open Session Runner\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${bun} ${command} runner run\nRestart=always\nRestartSec=5\nEnvironment=HOME=${process.env.HOME || "/tmp"}\nEnvironment=PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}\n\n[Install]\nWantedBy=default.target\n`;
}

function windowsTaskUser(): string {
	let name = process.env.USERNAME || "";
	if (!name) { try { name = userInfo().username; } catch {} }
	const domain = process.env.USERDOMAIN;
	return domain && name ? `${domain}\\${name}` : name;
}

/** Render the Windows per-user Scheduled Task (registered via
 * `schtasks /Create /XML`). Task Scheduler is the launchd/systemd-user
 * equivalent here: no admin rights, starts at sign-in, and RestartOnFailure
 * re-arms the channel if the process itself dies. The action goes through a
 * hidden PowerShell so a console window does not land on the desktop at every
 * sign-in, and `*>>` appends all streams to the runner log. */
export function runnerScheduledTaskXml(command = runnerCommandPath(), bun = process.execPath, user = windowsTaskUser(), shell = windowsPowerShellPath()): string {
	const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
	const single = (value: string) => `'${value.replaceAll("'", "''")}'`;
	const action = `& ${single(bun)} ${single(command)} runner run *>> ${single(join(OPENSESSION_HOME, "runner.log"))}`;
	const args = `-NoProfile -NonInteractive -WindowStyle Hidden -Command "${action}"`;
	return `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n  <RegistrationInfo>\n    <Description>Open Session Runner: holds the outbound control channel open.</Description>\n  </RegistrationInfo>\n  <Triggers>\n    <LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>${xml(user)}</UserId>\n    </LogonTrigger>\n  </Triggers>\n  <Principals>\n    <Principal id="Author">\n      <UserId>${xml(user)}</UserId>\n      <LogonType>InteractiveToken</LogonType>\n      <RunLevel>LeastPrivilege</RunLevel>\n    </Principal>\n  </Principals>\n  <Settings>\n    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n    <StartWhenAvailable>true</StartWhenAvailable>\n    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n    <RestartOnFailure>\n      <Interval>PT1M</Interval>\n      <Count>10</Count>\n    </RestartOnFailure>\n  </Settings>\n  <Actions Context="Author">\n    <Exec>\n      <Command>${xml(shell)}</Command>\n      <Arguments>${xml(args)}</Arguments>\n    </Exec>\n  </Actions>\n</Task>\n`;
}

/** Install a per-user service. Runner credentials and workspaces stay owned by
 * the attaching user, so this never asks for a system-wide service or sudo. */
export async function installRunnerService(): Promise<boolean> {
	try {
		if (platform() === "darwin") {
			const path = join(process.env.HOME || "/tmp", "Library", "LaunchAgents", `${RUNNER_SERVICE_LABEL}.plist`);
			mkdirSync(dirname(path), { recursive: true });
			await Bun.write(path, runnerLaunchdPlist());
			const uid = typeof process.getuid === "function" ? process.getuid() : 0;
			await run(["launchctl", "bootout", `gui/${uid}/${RUNNER_SERVICE_LABEL}`], { quiet: true });
			const started = await run(["launchctl", "bootstrap", `gui/${uid}`, path], { quiet: true });
			if (started.code !== 0) throw new Error(started.stderr || "launchctl bootstrap failed");
			ok("Runner service installed", "LaunchAgent reconnects after restart");
			return true;
		}
		if (platform() === "linux") {
			if (!Bun.which("systemctl")) {
				fail("Runner service was not installed", "systemctl is not on this machine, so there is no user service manager to install into");
				return false;
			}
			const path = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || "/tmp", ".config"), "systemd", "user", "opensession-runner.service");
			mkdirSync(dirname(path), { recursive: true });
			await Bun.write(path, runnerSystemdUnit());
			const reload = await run(["systemctl", "--user", "daemon-reload"], { quiet: true });
			const enabled = await run(["systemctl", "--user", "enable", "--now", "opensession-runner.service"], { quiet: true });
			if (reload.code !== 0 || enabled.code !== 0) throw new Error(enabled.stderr || reload.stderr || "systemctl user service failed");
			ok("Runner service installed", "systemd user service reconnects after restart");
			return true;
		}
		if (platform() === "win32") {
			const schtasks = resolveWindowsSchtasks();
			if (!schtasks) {
				fail("Runner service was not installed", "schtasks.exe was not found");
				info(dim(`  looked at ${windowsSystem32("schtasks.exe")} and on PATH`));
				info(dim("  PATH is probably missing %SystemRoot%\\System32. Repair it, then run this again."));
				return false;
			}
			mkdirSync(OPENSESSION_HOME, { recursive: true });
			const path = join(OPENSESSION_HOME, "runner-task.xml");
			// UTF-16 LE with a BOM: the one encoding every Windows build's
			// schtasks accepts for /XML.
			const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(runnerScheduledTaskXml(), "utf16le")]);
			await Bun.write(path, new Uint8Array(body));
			const created = await run([schtasks, "/Create", "/TN", RUNNER_TASK_NAME, "/XML", path, "/F"], { quiet: true });
			if (created.code !== 0) throw new Error(created.stderr || created.stdout || "schtasks create failed");
			await run([schtasks, "/Run", "/TN", RUNNER_TASK_NAME], { quiet: true });
			ok("Runner service installed", "scheduled task reconnects after sign-in");
			return true;
		}
		fail("Runner service was not installed", `${platform()} has no supported per-user service manager`);
	} catch (error) {
		warn("Runner service was not installed", error instanceof Error ? error.message : String(error));
	}
	return false;
}

/**
 * Long-running: holds the channel open and runs what the server asks.
 *
 * A WebSocket rather than polling, because the server needs to *push* work. The
 * Runner dials out, so nothing has to be reachable on this machine.
 *
 * Everything the server sends runs as this user with this user's privileges.
 * That is the point of attaching a Runner, and it is why registration is
 * tailnet-gated and the tool exposing it is interactive-only.
 */
export async function runnerRun(): Promise<number> {
  const identity = await readIdentity();
  if (!identity) {
    fail("this machine is not connected", "run `opensession connect` first");
    return 1;
  }

  const wsUrl =
    identity.server.replace(/^http/, "ws") + `/runner-ws?id=${encodeURIComponent(identity.id)}`;
  let attempt = 0;
  let stopping = false;

  const connectOnce = () =>
    new Promise<void>((resolve) => {
      const socket = new WebSocket(wsUrl, {
        headers: { authorization: `Bearer ${identity.token}` },
      } as any);
		const running = new Map<string, ReturnType<typeof Bun.spawn>>();
		const persistent = new Map<string, ReturnType<typeof Bun.spawn>>();
		const portalSockets = new Map<string, WebSocket>();
		const terminals = new Map<string, RunnerTerminalProcess>();

      socket.addEventListener("open", async () => {
        attempt = 0;
        ok("attached", identity.server);
		 const report = async () => {
			const resources = await detectResources();
			return { capabilities: { platform: platform(), toolchains: await detectCapabilities(), tags: [], hardware: resources }, resources };
		 };
		 const initial = await report();
		 socket.send(JSON.stringify({ t: "hello", version: 1, ...initial }));
		 const heartbeat = setInterval(() => { void report().then((next) => socket.send(JSON.stringify({ t: "heartbeat", ...next }))).catch(() => {}); }, HEARTBEAT_MS);
		 socket.addEventListener("close", () => clearInterval(heartbeat), { once: true });
      });

      socket.addEventListener("message", async (event: any) => {
        let msg: any;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg?.t === "cancel") {
			const proc = running.get(String(msg.id)) || persistent.get(String(msg.id));
          if (proc) proc.kill();
          return;
        }
		if (msg?.t === "workspace_prepare" && msg.version === 1 && msg.operationToken) {
			await prepareWorkspace(socket, msg);
			return;
		}
		if (msg?.t === "workspace_cleanup" && msg.version === 1 && msg.operationToken) {
			await cleanupWorkspace(socket, msg);
			return;
		}
		if (msg?.t === "run_host" && msg.version === 1 && msg.operationToken) {
			await startRunHost(socket, persistent, msg);
			return;
		}
		if (msg?.t === "host_status" && msg.version === 1 && msg.operationToken) {
			await reportRunHostStatus(socket, persistent, msg);
			return;
		}
		if (["portal_allocate", "portal_start", "portal_list", "portal_stop", "portal_restart", "portal_path", "portal_http"].includes(msg?.t) && msg.version === 1 && msg.operationToken) {
			await handleRunnerPortal(socket, msg);
			return;
		}
		if (["portal_ws_open", "portal_ws_send", "portal_ws_close"].includes(msg?.t) && msg.version === 1) {
			handleRunnerPortalWebSocket(socket, portalSockets, msg);
			return;
		}
		if (["terminal_start", "terminal_input", "terminal_resize", "terminal_stop"].includes(msg?.t) && msg.version === 1) {
			await handleRunnerTerminal(socket, terminals, msg);
			return;
		}
        if (msg?.t !== "exec" || msg.version !== 1 || !msg.operationToken) return;

        const id = String(msg.id);
        info(dim(`exec ${id}: ${String(msg.command).slice(0, 80)}`));
        try {
		  const command = runnerExecCommand(String(msg.command));
		  const proc = Bun.spawn(command, {
            cwd: typeof msg.cwd === "string" && msg.cwd ? msg.cwd : undefined,
			env: runnerEnvironment(),
            stdout: "pipe",
            stderr: "pipe",
          });
          running.set(id, proc);

          // Stream both pipes as they arrive rather than buffering to the end,
          // so a long build reports progress instead of going silent.
          const pump = async (stream: ReadableStream, name: "stdout" | "stderr") => {
            const decoder = new TextDecoder();
            for await (const chunk of stream as any) {
              socket.send(
                JSON.stringify({ t: "out", id, operationToken: msg.operationToken, stream: name, data: decoder.decode(chunk) }),
              );
            }
          };
          await Promise.all([
            pump(proc.stdout as ReadableStream, "stdout"),
            pump(proc.stderr as ReadableStream, "stderr"),
          ]);
          const code = await proc.exited;
          running.delete(id);
          socket.send(JSON.stringify({ t: "exit", id, operationToken: msg.operationToken, code }));
        } catch (err) {
          running.delete(id);
          socket.send(
            JSON.stringify({ t: "out", id, operationToken: msg.operationToken, stream: "stderr", data: String((err as Error).message) }),
          );
          socket.send(JSON.stringify({ t: "exit", id, operationToken: msg.operationToken, code: -1 }));
        }
      });

      socket.addEventListener("close", (event: any) => {
        // 1008/4401 mean the server rejected us outright — retrying is pointless.
        if (event?.code === 1008 || event?.code === 4401) {
          fail("the server refused this Runner", "its credential may have been revoked");
          stopping = true;
        }
		for (const proc of running.values()) proc.kill();
		for (const portal of portalSockets.values()) { try { portal.close(); } catch {} }
		for (const proc of terminals.values()) { try { proc.kill(); } catch {} }
		resolve();
      });

      socket.addEventListener("error", () => {
        // close always follows; let that path do the reconnect bookkeeping.
      });
    });

  info(dim(`attaching to ${identity.server} as ${identity.name} (${identity.id})`));

  while (!stopping) {
    await connectOnce();
    if (stopping) break;
    // Backoff, capped: a Runner may be someone's laptop and the server may be
    // restarting or the tailnet may be briefly down.
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5));
    if (attempt === 1) warn("disconnected — retrying");
    await new Promise((r) => setTimeout(r, delay));
  }
  return 1;
}

async function prepareWorkspace(socket: WebSocket, msg: any): Promise<void> {
	const id = String(msg.id);
	const token = String(msg.operationToken);
	const workspacePath = typeof msg.workspacePath === "string" ? msg.workspacePath : "";
	const repositoryUrl = typeof msg.repositoryUrl === "string" ? msg.repositoryUrl : "";
	const cloneToken = typeof msg.cloneToken === "string" ? msg.cloneToken : "";
	const branch = typeof msg.branch === "string" ? msg.branch : "";
	try {
		const absolute = platform() === "win32" ? /^[A-Za-z]:[\\/]/.test(workspacePath) : workspacePath.startsWith("/");
		if (!workspacePath || !absolute || workspacePath.includes("\0")) throw new Error("Invalid managed workspace path");
		if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(repositoryUrl)) throw new Error("Runner only accepts an approved GitHub repository URL");
		if (!/^[A-Za-z0-9._/-]{1,240}$/.test(branch) || branch.includes("..")) throw new Error("Invalid branch");
		const scoped = await scopedGitEnvironment(cloneToken);
		const env = scoped.env;
		try {
			if (existsSync(workspacePath)) {
				const origin = await runnerCommand(["git", "-C", workspacePath, "remote", "get-url", "origin"], env);
				if (origin.code !== 0 || origin.stdout.trim() !== repositoryUrl) throw new Error("Managed workspace does not match this session repository");
				const fetch = await runnerCommand(["git", "-C", workspacePath, "fetch", "--prune", "origin"], env);
				if (fetch.code !== 0) throw new Error(fetch.stderr.trim() || "Could not refresh managed workspace");
				const remoteBranch = await runnerCommand(["git", "-C", workspacePath, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], env);
				const checkout = remoteBranch.code === 0
					? await runnerCommand(["git", "-C", workspacePath, "checkout", "-B", branch, `origin/${branch}`], env)
					: await runnerCommand(["git", "-C", workspacePath, "checkout", "-B", branch, "origin/HEAD"], env);
				if (checkout.code !== 0) throw new Error(checkout.stderr.trim() || "Could not check out managed branch");
			} else {
				mkdirSync(dirname(workspacePath), { recursive: true });
				const clone = await runnerCommand(["git", "clone", repositoryUrl, workspacePath], env);
				if (clone.code !== 0) throw new Error(clone.stderr.trim() || "Could not clone managed workspace");
				const remoteBranch = await runnerCommand(["git", "-C", workspacePath, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], env);
				const checkout = remoteBranch.code === 0
					? await runnerCommand(["git", "-C", workspacePath, "checkout", "-B", branch, `origin/${branch}`], env)
					: await runnerCommand(["git", "-C", workspacePath, "checkout", "-B", branch, "origin/HEAD"], env);
				if (checkout.code !== 0) throw new Error(checkout.stderr.trim() || "Could not check out managed branch");
			}
		} finally {
			scoped.cleanup();
		}
		socket.send(JSON.stringify({ t: "workspace_ready", id, operationToken: token, cwd: workspacePath }));
	} catch (error) {
		socket.send(JSON.stringify({ t: "workspace_error", id, operationToken: token, error: error instanceof Error ? error.message : String(error) }));
	}
}

async function cleanupWorkspace(socket: WebSocket, msg: any): Promise<void> {
	const id = String(msg.id);
	const operationToken = String(msg.operationToken);
	try {
		const workspacePath = typeof msg.workspacePath === "string" ? msg.workspacePath : "";
		const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
		const absolute = platform() === "win32" ? /^[A-Za-z]:[\\/]/.test(workspacePath) : workspacePath.startsWith("/");
		const normalized = workspacePath.replace(/[\\/]+$/, "");
		if (!absolute || !sessionId || !/^[A-Za-z0-9_-]{3,128}$/.test(sessionId) || normalized.split(/[\\/]/).at(-1) !== sessionId || normalized.split(/[\\/]/).at(-2) !== "sessions") throw new Error("Invalid managed workspace cleanup path");
		if (existsSync(workspacePath)) rmSync(workspacePath, { recursive: true, force: true });
		socket.send(JSON.stringify({ t: "workspace_cleaned", id, operationToken, ok: true }));
	} catch (error) {
		socket.send(JSON.stringify({ t: "workspace_cleaned", id, operationToken, ok: false, error: error instanceof Error ? error.message : String(error) }));
	}
}

async function scopedGitEnvironment(cloneToken: string): Promise<{ env: Record<string, string>; cleanup: () => void }> {
	const env: Record<string, string> = {
		...runnerEnvironment(),
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: platform() === "win32" ? "NUL" : "/dev/null",
	};
	if (!cloneToken) return { env, cleanup: () => {} };
	const dir = mkdtempSync(join(tmpdir(), "opensession-runner-git-"));
	const askpass = join(dir, platform() === "win32" ? "askpass.cmd" : "askpass");
	await Bun.write(askpass, platform() === "win32"
		? "@echo off\r\necho %1 | findstr /I Username >nul && (echo x-access-token) || (echo %OPENSESSION_RUNNER_GIT_TOKEN%)\r\n"
		: "#!/bin/sh\ncase \"$1\" in *Username*) echo x-access-token ;; *) printf '%s\\n' \"$OPENSESSION_RUNNER_GIT_TOKEN\" ;; esac\n");
	if (platform() !== "win32") chmodSync(askpass, 0o700);
	return {
		env: { ...env, GIT_ASKPASS: askpass, OPENSESSION_RUNNER_GIT_TOKEN: cloneToken },
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

type RunnerPortalRecord = {
	name: string;
	key: string;
	command: string;
	port: number;
	description?: string;
	defaultPath?: string;
	state: "starting" | "awake" | "failed" | "stopped";
	pid?: number;
	startedAt?: string;
	lastError?: string;
	portalUrl?: string;
};

const PORTAL_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const PORTAL_MIN = 1024;
const PORTAL_MAX = 19_000;
/** Keep Runner-owned services in the same interoperable workspace registry as
 * local and sandbox Portals, without making either supervisor adopt the
 * other's process. */
const RUNNER_PORTAL_PREFIX = "# opensession-runner-portal ";

function runnerPortalRegistryPath(workspacePath: string): string {
	return join(workspacePath, ".ports.conf");
}

export function parseRunnerPortalRegistry(contents: string): RunnerPortalRecord[] {
	const records: RunnerPortalRecord[] = [];
	for (const line of contents.split("\n")) {
		if (!line.startsWith(RUNNER_PORTAL_PREFIX)) continue;
		try {
			const portal = JSON.parse(line.slice(RUNNER_PORTAL_PREFIX.length)) as RunnerPortalRecord;
			if (!portal || !PORTAL_NAME.test(portal.name) || !Number.isInteger(portal.port) || portal.port < PORTAL_MIN || portal.port > PORTAL_MAX || typeof portal.command !== "string") continue;
			records.push({ ...portal, key: runnerPortalKey(portal.name) });
		} catch {}
	}
	return records;
}

function readRunnerPortalRegistry(workspacePath: string): RunnerPortalRecord[] {
	try { return parseRunnerPortalRegistry(readFileSync(runnerPortalRegistryPath(workspacePath), "utf8")); }
	catch { return []; }
}

export function serializeRunnerPortalRegistry(previousText: string, portals: RunnerPortalRecord[]): string {
	const generatedKeys = new Set(portals.map((portal) => runnerPortalKey(portal.name)));
	const kept = previousText.split("\n").filter((line) => {
		if (line.startsWith(RUNNER_PORTAL_PREFIX)) return false;
		const key = line.match(/^\s*([A-Z0-9_]+_PORT)\s*=/)?.[1];
		return !key || !generatedKeys.has(key);
	});
	while (kept.at(-1) === "") kept.pop();
	return [...kept, ...portals.flatMap((portal) => [
		`${RUNNER_PORTAL_PREFIX}${JSON.stringify({ ...portal, key: runnerPortalKey(portal.name) })}`,
		`${runnerPortalKey(portal.name)}=${portal.port}`,
	]), ""].join("\n");
}

function writeRunnerPortalRegistry(workspacePath: string, portals: RunnerPortalRecord[]): void {
	const path = runnerPortalRegistryPath(workspacePath);
	let previous = "";
	try { previous = readFileSync(path, "utf8"); } catch {}
	writeFileSync(path, serializeRunnerPortalRegistry(previous, portals), { mode: 0o600 });
}

async function runnerPortListening(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
		void Bun.connect({ hostname: "127.0.0.1", port, socket: { open(socket) { try { socket.end(); } catch {} finish(true); }, connectError() { finish(false); }, close() { finish(false); } } }).catch(() => finish(false));
	});
}

function runnerPortalKey(name: string): string { return `PORTAL_${name.toUpperCase().replace(/-/g, "_")}_PORT`; }

function runnerPortalUpsert(records: RunnerPortalRecord[], next: RunnerPortalRecord): RunnerPortalRecord[] {
	const index = records.findIndex((record) => record.name === next.name);
	if (index < 0) return [...records, next];
	const copy = [...records]; copy[index] = next; return copy;
}

async function runnerPortalStatus(workspacePath: string): Promise<RunnerPortalRecord[]> {
	const records = readRunnerPortalRegistry(workspacePath);
	let changed = false;
	const next = await Promise.all(records.map(async (record) => {
		if (record.state === "stopped" || record.state === "failed") return record;
		const listening = await runnerPortListening(record.port);
		let alive = false;
		if (record.pid && record.pid > 1) { try { process.kill(record.pid, 0); alive = true; } catch {} }
		const state = listening ? "awake" as const : alive ? "starting" as const : "failed" as const;
		if (state === record.state) return record;
		changed = true;
		return { ...record, state, ...(state === "failed" ? { lastError: "The service is no longer listening." } : {}) };
	}));
	if (changed) writeRunnerPortalRegistry(workspacePath, next);
	return next;
}

async function startRunnerPortal(workspacePath: string, msg: any): Promise<RunnerPortalRecord> {
	const name = typeof msg.name === "string" ? msg.name.trim().toLowerCase() : "";
	const command = typeof msg.command === "string" ? msg.command.trim() : "";
	if (!PORTAL_NAME.test(name) || !command || command.length > 8_000) throw new Error("Invalid Portal service.");
	let records = await runnerPortalStatus(workspacePath);
	const current = records.find((record) => record.name === name);
	if (current && current.state !== "failed" && current.state !== "stopped") throw new Error(`Portal '${name}' already exists.`);
	let port = typeof msg.port === "number" ? msg.port : 0;
	if (port) {
		if (!Number.isInteger(port) || port < PORTAL_MIN || port > PORTAL_MAX) throw new Error("Invalid Portal port.");
		if (records.some((record) => record.name !== name && record.port === port) || await runnerPortListening(port)) throw new Error(`Port ${port} is already in use.`);
	} else {
		for (port = 4_000; port < 9_000; port++) if (!records.some((record) => record.port === port) && !(await runnerPortListening(port))) break;
		if (port >= 9_000) throw new Error("No Portal ports are available.");
	}
	const base: RunnerPortalRecord = {
		name, key: runnerPortalKey(name), command, port,
		...(typeof msg.description === "string" && msg.description.trim() ? { description: msg.description.trim().slice(0, 240) } : {}),
		...(typeof msg.portalUrl === "string" && msg.portalUrl.startsWith("https://") ? { portalUrl: msg.portalUrl } : {}),
		state: "starting", startedAt: new Date().toISOString(),
	};
	writeRunnerPortalRegistry(workspacePath, runnerPortalUpsert(records, base));
	const env = { ...runnerEnvironment(), PORT: String(port), PORTAL_URL: typeof msg.portalUrl === "string" ? msg.portalUrl : "", OPENSESSION_PORTAL: name };
	const child = platform() === "win32"
		? Bun.spawn(runnerExecCommand(command), { cwd: workspacePath, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
		: Bun.spawn(["setsid", "bash", "-lc", `exec ${command}`], { cwd: workspacePath, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	child.unref();
	const running = { ...base, pid: child.pid };
	writeRunnerPortalRegistry(workspacePath, runnerPortalUpsert(records, running));
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (await runnerPortListening(port)) {
			const awake = { ...running, state: "awake" as const };
			writeRunnerPortalRegistry(workspacePath, runnerPortalUpsert(records, awake));
			return awake;
		}
		await Bun.sleep(200);
	}
	const failed = { ...running, state: "failed" as const, lastError: `Nothing listened on port ${port} within 15 seconds.` };
	writeRunnerPortalRegistry(workspacePath, runnerPortalUpsert(records, failed));
	throw new Error(failed.lastError);
}

async function allocateRunnerPortalPort(workspacePath: string, requested: unknown): Promise<{ port: number }> {
	const records = await runnerPortalStatus(workspacePath);
	let port = typeof requested === "number" ? requested : 0;
	if (port) {
		if (!Number.isInteger(port) || port < PORTAL_MIN || port > PORTAL_MAX || records.some((record) => record.port === port) || await runnerPortListening(port)) throw new Error("Requested Portal port is unavailable.");
		return { port };
	}
	for (port = 4_000; port < 9_000; port++) if (!records.some((record) => record.port === port) && !(await runnerPortListening(port))) return { port };
	throw new Error("No Portal ports are available.");
}

async function stopRunnerPortal(workspacePath: string, nameValue: unknown): Promise<RunnerPortalRecord> {
	const name = typeof nameValue === "string" ? nameValue.trim().toLowerCase() : "";
	const records = readRunnerPortalRegistry(workspacePath);
	const current = records.find((record) => record.name === name);
	if (!current) throw new Error(`Portal '${name}' does not exist.`);
	if (current.pid && current.pid > 1) {
		try { process.kill(platform() === "win32" ? current.pid : -current.pid, "SIGTERM"); } catch { try { process.kill(current.pid, "SIGTERM"); } catch {} }
	}
	const stopped = { ...current, state: "stopped" as const, pid: undefined };
	writeRunnerPortalRegistry(workspacePath, runnerPortalUpsert(records, stopped));
	return stopped;
}

function setRunnerPortalPath(workspacePath: string, nameValue: unknown, pathValue: unknown): RunnerPortalRecord {
	const name = typeof nameValue === "string" ? nameValue.trim().toLowerCase() : "";
	const defaultPath = typeof pathValue === "string" ? pathValue.trim() : "";
	if (!PORTAL_NAME.test(name) || (defaultPath && (!defaultPath.startsWith("/") || defaultPath.startsWith("//") || defaultPath.includes("\n")))) throw new Error("Invalid Portal route.");
	const records = readRunnerPortalRegistry(workspacePath);
	const current = records.find((record) => record.name === name);
	if (!current) throw new Error(`Portal '${name}' does not exist.`);
	const updated = { ...current, defaultPath: defaultPath || undefined };
	writeRunnerPortalRegistry(workspacePath, runnerPortalUpsert(records, updated));
	return updated;
}

const RELAY_HEADERS = new Set(["connection", "host", "content-length", "transfer-encoding", "upgrade", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer"]);

async function runnerPortalHttp(workspacePath: string, msg: any): Promise<Record<string, unknown>> {
	const port = typeof msg.port === "number" ? msg.port : NaN;
	const path = typeof msg.path === "string" ? msg.path : "";
	const method = typeof msg.method === "string" ? msg.method.toUpperCase() : "GET";
	if (!Number.isInteger(port) || !path.startsWith("/") || path.startsWith("//") || path.includes("\0") || !/^[A-Z]{3,10}$/.test(method)) throw new Error("Invalid Portal HTTP request.");
	const portal = (await runnerPortalStatus(workspacePath)).find((record) => record.port === port && record.state === "awake");
	if (!portal) throw new Error("The requested Portal is not running.");
	const headers = new Headers();
	if (msg.headers && typeof msg.headers === "object" && !Array.isArray(msg.headers)) {
		for (const [name, value] of Object.entries(msg.headers as Record<string, unknown>)) {
			if (!RELAY_HEADERS.has(name.toLowerCase()) && typeof value === "string" && value.length <= 8_192) headers.set(name, value);
		}
	}
	let body: Uint8Array | undefined;
	if (typeof msg.body === "string" && msg.body) {
		body = Buffer.from(msg.body, "base64");
		if (body.byteLength > 5 * 1024 * 1024) throw new Error("Portal request body is too large.");
	}
	const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body && method !== "GET" && method !== "HEAD" ? Buffer.from(body) as unknown as BodyInit : undefined, redirect: "manual", signal: AbortSignal.timeout(30_000) });
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("Portal response is too large.");
	const responseHeaders: Record<string, string> = {};
	for (const [name, value] of response.headers) if (!RELAY_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
	return { status: response.status, headers: responseHeaders, body: Buffer.from(bytes).toString("base64") };
}

function handleRunnerPortalWebSocket(socket: WebSocket, portalSockets: Map<string, WebSocket>, msg: any): void {
	const connectionId = typeof msg.connectionId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(msg.connectionId) ? msg.connectionId : "";
	if (!connectionId) return;
	if (msg.t === "portal_ws_close") {
		try { portalSockets.get(connectionId)?.close(); } catch {}
		portalSockets.delete(connectionId);
		return;
	}
	if (msg.t === "portal_ws_send") {
		const portal = portalSockets.get(connectionId);
		if (!portal || portal.readyState !== WebSocket.OPEN) return;
		try {
			if (msg.binary === true && typeof msg.data === "string") portal.send(Buffer.from(msg.data, "base64"));
			else if (typeof msg.data === "string") portal.send(msg.data);
		} catch {}
		return;
	}
	const workspacePath = typeof msg.workspacePath === "string" ? msg.workspacePath : "";
	const port = typeof msg.port === "number" ? msg.port : NaN;
	const path = typeof msg.path === "string" ? msg.path : "";
	if (!workspacePath || workspacePath.includes("\0") || !Number.isInteger(port) || !path.startsWith("/") || path.startsWith("//")) return;
	void (async () => {
		try {
			const portal = (await runnerPortalStatus(workspacePath)).find((record) => record.port === port && record.state === "awake");
			if (!portal) throw new Error("Portal is not running");
			const headers = msg.headers && typeof msg.headers === "object" && !Array.isArray(msg.headers) ? msg.headers as Record<string, unknown> : {};
			const forwarded: Record<string, string> = {};
			for (const [name, value] of Object.entries(headers)) if (!RELAY_HEADERS.has(name.toLowerCase()) && typeof value === "string" && value.length <= 8_192) forwarded[name] = value;
			const remote = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: forwarded } as any);
			portalSockets.set(connectionId, remote);
			remote.addEventListener("open", () => { try { socket.send(JSON.stringify({ t: "portal_ws_opened", connectionId })); } catch {} });
			remote.addEventListener("message", (event: any) => {
				try {
					if (typeof event.data === "string") socket.send(JSON.stringify({ t: "portal_ws_event", connectionId, binary: false, data: event.data }));
					else socket.send(JSON.stringify({ t: "portal_ws_event", connectionId, binary: true, data: Buffer.from(event.data).toString("base64") }));
				} catch {}
			});
			const close = () => { portalSockets.delete(connectionId); try { socket.send(JSON.stringify({ t: "portal_ws_closed", connectionId })); } catch {} };
			remote.addEventListener("close", close);
			remote.addEventListener("error", close);
		} catch {
			try { socket.send(JSON.stringify({ t: "portal_ws_closed", connectionId })); } catch {}
		}
	})();
}

async function handleRunnerPortal(socket: WebSocket, msg: any): Promise<void> {
	const id = String(msg.id);
	const operationToken = String(msg.operationToken);
	try {
		const workspacePath = typeof msg.workspacePath === "string" ? msg.workspacePath : "";
		if (!workspacePath || workspacePath.includes("\0") || !existsSync(workspacePath)) throw new Error("Invalid Runner Portal workspace.");
		let result: unknown;
		if (msg.t === "portal_allocate") result = await allocateRunnerPortalPort(workspacePath, msg.port);
		else if (msg.t === "portal_start") result = await startRunnerPortal(workspacePath, msg);
		else if (msg.t === "portal_list") result = await runnerPortalStatus(workspacePath);
		else if (msg.t === "portal_stop") result = await stopRunnerPortal(workspacePath, msg.name);
		else if (msg.t === "portal_path") result = setRunnerPortalPath(workspacePath, msg.name, msg.path);
		else if (msg.t === "portal_restart") {
			const existing = await stopRunnerPortal(workspacePath, msg.name);
			result = await startRunnerPortal(workspacePath, { ...existing, ...(typeof msg.portalUrl === "string" ? { portalUrl: msg.portalUrl } : {}) });
		} else if (msg.t === "portal_http") result = await runnerPortalHttp(workspacePath, msg);
		else throw new Error("Unknown Runner Portal operation.");
		socket.send(JSON.stringify({ t: "portal_result", id, operationToken, ok: true, result }));
	} catch (error) {
		socket.send(JSON.stringify({ t: "portal_result", id, operationToken, ok: false, error: error instanceof Error ? error.message : String(error) }));
	}
}

type RunnerTerminalProcess = ReturnType<typeof Bun.spawn>;

function terminalSize(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

/** A typed, Runner-owned PTY. The server has already pinned its workspace and
 * verified the terminal permission before this message reaches the machine. */
async function handleRunnerTerminal(socket: WebSocket, terminals: Map<string, RunnerTerminalProcess>, msg: any): Promise<void> {
	const id = typeof msg.id === "string" && /^rt\d+-[A-Za-z0-9_-]{16}$/.test(msg.id) ? msg.id : "";
	if (!id) return;
	if (msg.t === "terminal_input") {
		if (typeof msg.data === "string" && msg.data.length <= 128_000) {
			try { (terminals.get(id) as any)?.terminal?.write(Buffer.from(msg.data, "base64")); } catch {}
		}
		return;
	}
	if (msg.t === "terminal_resize") {
		try { (terminals.get(id) as any)?.terminal?.resize(terminalSize(msg.cols, 100, 20, 500), terminalSize(msg.rows, 30, 5, 200)); } catch {}
		return;
	}
	if (msg.t === "terminal_stop") {
		try { terminals.get(id)?.kill(); } catch {}
		return;
	}
	const operationToken = String(msg.operationToken || "");
	try {
		const workspacePath = typeof msg.workspacePath === "string" ? msg.workspacePath : "";
		if (!workspacePath || workspacePath.includes("\0") || !existsSync(workspacePath)) throw new Error("Invalid Runner terminal workspace.");
		if (terminals.has(id)) throw new Error("Runner terminal already exists.");
		const shell = platform() === "win32" ? resolveWindowsShell() : (process.env.SHELL || "/bin/bash");
		const argv = platform() === "win32" ? [shell, "-NoLogo"] : [shell, "-il"];
		const proc = Bun.spawn(argv, {
			cwd: workspacePath,
			env: { ...runnerEnvironment(), TERM: "xterm-256color" },
			terminal: {
				cols: terminalSize(msg.cols, 100, 20, 500), rows: terminalSize(msg.rows, 30, 5, 200),
				data: (_terminal: unknown, chunk: Uint8Array) => {
					try { socket.send(JSON.stringify({ t: "terminal_data", id, data: Buffer.from(chunk).toString("base64") })); } catch {}
				},
			},
		} as any);
		terminals.set(id, proc);
		void proc.exited.then((code) => {
			terminals.delete(id);
			try { socket.send(JSON.stringify({ t: "terminal_exit", id, code })); } catch {}
		});
		socket.send(JSON.stringify({ t: "terminal_ready", id, operationToken, cwd: workspacePath }));
	} catch (error) {
		try { socket.send(JSON.stringify({ t: "terminal_error", id, operationToken, error: error instanceof Error ? error.message : String(error) })); } catch {}
	}
}

async function startRunHost(socket: WebSocket, persistent: Map<string, ReturnType<typeof Bun.spawn>>, msg: any): Promise<void> {
	const id = String(msg.id);
	const token = String(msg.operationToken);
	try {
		const spec = msg.spec;
		if (!spec || typeof spec !== "object" || typeof spec.hostId !== "string" || typeof spec.cwd !== "string" || !spec.wsToken) throw new Error("Invalid run-host request");
		// The compiled binary carries the run host as a subcommand, so there is
		// no source entrypoint file to check for; only the source install ships
		// host.ts on disk.
		if (!isCompiledBinary() && !existsSync(RUNNER_HOST_ENTRY)) throw new Error("This Runner installation does not include the run-host entrypoint");
		const stateDir = join(spec.cwd, ".opensession-run-hosts", spec.hostId);
		mkdirSync(stateDir, { recursive: true });
		const specPath = join(stateDir, "spec.json");
		await Bun.write(specPath, JSON.stringify(spec));
		const base = String(msg.server || "").replace(/\/$/, "").replace(/^http/, "ws");
		if (!/^wss?:\/\//.test(base)) throw new Error("Invalid Open Session endpoint");
		const env = {
			PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME || "/tmp",
			OPENSESSION_RUN_WS_URL: `${base}/run-ws/${encodeURIComponent(spec.hostId)}`,
			OPENSESSION_RUN_WS_TOKEN: String(spec.wsToken),
			OPENSESSION_RPC_WS_URL: `${base}/rpc-ws`,
			OPENSESSION_RPC_WS_HOST: spec.hostId,
			OPENSESSION_RPC_WS_AUTH: String(spec.wsToken),
		};
		const bun = Bun.which("bun") || process.execPath;
		const launch = runnerHostArgv(bun, RUNNER_HOST_ENTRY, specPath);
		const command = platform() === "win32" ? launch : ["setsid", ...launch];
		const proc = Bun.spawn(command, { cwd: spec.cwd, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		proc.unref();
		await Bun.write(join(stateDir, "pid"), `${proc.pid}\n`);
		persistent.set(spec.hostId, proc);
		void proc.exited.finally(async () => {
			persistent.delete(spec.hostId);
			try { socket.send(JSON.stringify({ t: "host_exited", hostId: spec.hostId })); } catch {}
		});
		socket.send(JSON.stringify({ t: "host_started", id, operationToken: token, hostId: spec.hostId }));
	} catch (error) {
		socket.send(JSON.stringify({ t: "host_error", id, operationToken: token, error: error instanceof Error ? error.message : String(error) }));
	}
}

async function reportRunHostStatus(socket: WebSocket, persistent: Map<string, ReturnType<typeof Bun.spawn>>, msg: any): Promise<void> {
	const id = String(msg.id);
	const token = String(msg.operationToken);
	const hostId = typeof msg.hostId === "string" ? msg.hostId : "";
	const workspacePath = typeof msg.workspacePath === "string" ? msg.workspacePath : "";
	let alive = false;
	try {
		if (!hostId || !workspacePath || workspacePath.includes("\0")) throw new Error("Invalid host status request");
		const proc = persistent.get(hostId);
		if (proc) alive = proc.exitCode === null;
		if (!alive) {
			const stateDir = join(workspacePath, ".opensession-run-hosts", hostId);
			const spec = JSON.parse(await Bun.file(join(stateDir, "spec.json")).text()) as { hostId?: string };
			const pid = Number((await Bun.file(join(stateDir, "pid")).text()).trim());
			if (spec.hostId !== hostId || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid host state");
			try { process.kill(pid, 0); alive = true; } catch { alive = false; }
		}
	} catch { alive = false; }
	socket.send(JSON.stringify({ t: "host_status", id, operationToken: token, hostId, alive }));
}

async function runnerCommand(cmd: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function runnerStatus(): Promise<number> {
  const identity = await readIdentity();
  heading("This machine");
  if (!identity) {
    info(dim("not connected to any server"));
    info(dim("  opensession connect --server <url> --code <code>"));
    return 0;
  }
  ok(`connected to ${identity.server}`, `${identity.name} (${identity.id})`);
  info(dim(`  capabilities: ${(await detectCapabilities()).join(", ") || "none detected"}`));
  return 0;
}

// ── server side: managing attached Runners ───────────────────────────────────

/** The local server's own address, from the config this CLI can read. */
async function localApi(): Promise<string> {
  const { CONFIG_PATH } = await import("./paths");
  let host = "127.0.0.1";
  let port = 3850;
  if (existsSync(CONFIG_PATH)) {
    try {
      const config = JSON.parse(await Bun.file(CONFIG_PATH).text());
      // 0.0.0.0 is a bind address, not a destination.
      const configured = config?.server?.host;
      if (configured && configured !== "0.0.0.0") host = configured;
      if (config?.server?.port) port = Number(config.server.port);
    } catch {
      // fall through to defaults
    }
  }
  return `http://${host}:${port}/api/runners`;
}

/**
 * A local bearer token, when GitHub web sign-in is active.
 *
 * With sign-in on, every /api/* call needs a session — including this CLI, which
 * runs on the server box and has no browser. Non-browser callers authenticate
 * with a token from the web-sessions store, which is the documented mechanism.
 * Absent (sign-in off) we send nothing and the request is allowed as before.
 */
async function operatorToken(): Promise<string | undefined> {
  try {
    return localAutomationToken() || undefined;
  } catch {
    // The request below reports the ordinary signed-out error without leaking
    // or borrowing a teammate's credential.
  }
  return undefined;
}

async function apiCall(path: string, init?: RequestInit): Promise<any | undefined> {
  const base = await localApi();
  const token = await operatorToken();
  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}) as any);
      fail(`server returned ${response.status}`, body?.error ?? "");
      if (response.status === 401) {
        info(dim("  sign-in is active and no local session token was found —"));
        info(dim("  sign in via the UI once, or run this on the server box"));
      }
      return undefined;
    }
    return await response.json();
  } catch (err) {
    fail("could not reach the local server", (err as Error).message);
    info(dim("  is it running? `opensession status`"));
    return undefined;
  }
}

export async function runnersPair(): Promise<number> {
  const result = await apiCall("/pair", { method: "POST" });
  if (!result) return 1;

  heading("Pairing code");
  info(`  ${bold(result.code)}`);
  info(dim(`  valid for 10 minutes, single use`));
  heading("On the machine you want to attach");
  info(dim("  curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash"));
  info(dim("  (Windows: irm https://raw.githubusercontent.com/tellahq/opensession/main/install.ps1 | iex)"));
  info(`  opensession connect --server ${(await localApi()).replace("/api/runners", "")} --code ${result.code}`);
  return 0;
}

export async function runnersList(): Promise<number> {
  const result = await apiCall("");
  if (!result) return 1;

  const runners = result.runners ?? [];
  heading("Runners");
  if (!runners.length) {
    info(dim("none attached · `opensession runners pair` to add one"));
    return 0;
  }
  for (const runner of runners) {
    const seen = runner.lastSeenAt
      ? `last seen ${new Date(runner.lastSeenAt).toISOString().replace("T", " ").slice(0, 19)}Z`
      : "never connected";
    info(`${runner.name}  ${dim(`${runner.platform}/${runner.arch}`)}  ${runner.state}`);
    info(dim(`  ${runner.id}  ${runner.address}  ${seen}`));
    if (runner.capabilities?.toolchains?.length) info(dim(`  can: ${runner.capabilities.toolchains.join(", ")}`));
  }
  return 0;
}

export async function runnersRemove(id: string): Promise<number> {
  if (!id) {
    fail("usage: opensession runners remove <runner-id>");
    return 1;
  }
  const result = await apiCall(`/${id}`, { method: "DELETE" });
  if (!result) return 1;
  ok(`removed ${id}`, "its credential no longer authenticates");
  return 0;
}
