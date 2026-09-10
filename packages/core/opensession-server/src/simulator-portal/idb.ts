import { createHash, randomUUID } from "crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "fs/promises";
import { basename, extname, isAbsolute, join, relative } from "path";

export type SimulatorInput =
  | { kind: "tap"; x: number; y: number }
  | {
      kind: "swipe";
      x: number;
      y: number;
      endX: number;
      endY: number;
      duration: number;
    }
  | { kind: "text"; text: string }
  | { kind: "button"; button: "HOME" }
  | { kind: "key"; key: number };

export type IdbSimulator = {
  udid: string;
  deviceName: string;
  /** Logical screen size in points, matching idb UI command coordinates. */
  dimensions: { width: number; height: number };
  /** Video pixels per logical point. */
  density: number;
  startVideo: (
    onChunk: (chunk: Uint8Array) => void,
    onError: (error: Error) => void,
  ) => Promise<() => Promise<void>>;
  input: (command: SimulatorInput) => Promise<void>;
  close: () => Promise<void>;
};

export type OpenIdbSimulatorOptions = {
  sessionId: string;
  workspaceDir: string;
  appPath: string;
  deviceType?: string;
  runtime?: string;
};

type RunResult = { exitCode: number; stdout: string; stderr: string };
type RunningProcess = {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: (signal?: number) => void;
};
type ProcessRunner = {
  run: (argv: string[], options: { timeoutMs: number }) => Promise<RunResult>;
  spawn: (argv: string[]) => RunningProcess;
};

/** Exported only so tests can replace the executable boundary. */
export type IdbSimulatorDependencies = {
  runner: ProcessRunner;
  platform: NodeJS.Platform;
  pid: number;
  capacityRoot?: string;
};

const COMMAND_TIMEOUT_MS = 30_000;
const BOOT_TIMEOUT_MS = 120_000;
const COMPANION_READY_TIMEOUT_MS = 30_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;
const CAPACITY_ROOT = "/tmp/opensession-idb-simulator-capacity";
const MAX_ACTIVE_SIMULATORS = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEASE_ROOT = /^\/tmp\/osi-[0-9a-f]{8}-[0-9a-f]{8}$/;

const environment = (): Record<string, string> => {
  const result: Record<string, string> = {
    PATH:
      process.env.PATH ??
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
  };
  for (const key of ["HOME", "TMPDIR", "USER", "LOGNAME"] as const) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
};

const readText = async (
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (output.length < limit)
      output += decoder.decode(next.value, { stream: true });
  }
  return output.slice(-limit);
};

const defaultRunner: ProcessRunner = {
  async run(argv, options) {
    const child = Bun.spawn(argv, {
      env: environment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(9), options.timeoutMs);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readText(child.stdout, 1_000_000),
      readText(child.stderr, 4_000),
    ]).finally(() => clearTimeout(timer));
    return { exitCode, stdout, stderr };
  },
  spawn(argv) {
    const child = Bun.spawn(argv, {
      env: environment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    return {
      stdout: child.stdout,
      exited: child.exited,
      kill: (signal) => child.kill(signal),
    };
  },
};

const runChecked = async (
  runner: ProcessRunner,
  argv: string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<string> => {
  const result = await runner.run(argv, { timeoutMs });
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new Error(
      `${basename(argv[0] ?? "command")} failed: ${detail.slice(-4_000)}`,
    );
  }
  return result.stdout.trim();
};

const findExecutable = async (
  runner: ProcessRunner,
  name: "simctl" | "idb" | "idb_companion",
): Promise<string> => {
  const argv =
    name === "simctl"
      ? ["/usr/bin/xcrun", "--find", name]
      : ["/usr/bin/which", name];
  try {
    const path = await runChecked(runner, argv);
    if (!isAbsolute(path))
      throw new Error(`resolved to non-absolute path ${path}`);
    return path;
  } catch (error) {
    const requirement = name === "simctl" ? "Xcode with simctl" : name;
    throw new Error(`Simulator portal requires ${requirement} on macOS`, {
      cause: error,
    });
  }
};

const finite = (value: number, label: string): void => {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
};

const coordinate = (value: number, label: string): string => {
  finite(value, label);
  if (value < 0) throw new Error(`${label} must not be negative`);
  return String(Math.round(value));
};

const inputArguments = (command: SimulatorInput): string[] => {
  switch (command.kind) {
    case "tap":
      return [
        "ui",
        "tap",
        coordinate(command.x, "tap x"),
        coordinate(command.y, "tap y"),
      ];
    case "swipe": {
      finite(command.duration, "swipe duration");
      if (command.duration < 0)
        throw new Error("swipe duration must not be negative");
      return [
        "ui",
        "swipe",
        coordinate(command.x, "swipe x"),
        coordinate(command.y, "swipe y"),
        coordinate(command.endX, "swipe endX"),
        coordinate(command.endY, "swipe endY"),
        "--duration",
        String(command.duration),
      ];
    }
    case "text":
      if (command.text.length > 10_000)
        throw new Error("text input is too long");
      return ["ui", "text", "--", command.text];
    case "button":
      return ["ui", "button", command.button];
    case "key":
      if (!Number.isSafeInteger(command.key) || command.key < 0) {
        throw new Error("key must be a non-negative integer");
      }
      return ["ui", "key", String(command.key)];
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
};

type SlotOwner = {
  pid: number;
  token: string;
  leaseRoot: string;
  deviceSet: string;
  udid?: string;
};
type CapacityLease = {
  updateUdid: (udid: string) => Promise<void>;
  release: () => Promise<void>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseSlotOwner = (value: unknown): SlotOwner | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.pid !== "number" ||
    typeof value.token !== "string" ||
    typeof value.leaseRoot !== "string" ||
    typeof value.deviceSet !== "string" ||
    (value.udid !== undefined && typeof value.udid !== "string")
  )
    return undefined;
  return {
    pid: value.pid,
    token: value.token,
    leaseRoot: value.leaseRoot,
    deviceSet: value.deviceSet,
    ...(value.udid === undefined ? {} : { udid: value.udid }),
  };
};

const readOwner = async (slot: string): Promise<SlotOwner | undefined> => {
  try {
    return parseSlotOwner(
      JSON.parse(await readFile(join(slot, "owner.json"), "utf8")),
    );
  } catch {
    return undefined;
  }
};

const processExists = async (
  runner: ProcessRunner,
  pid: number,
): Promise<boolean> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  return (
    (await runner.run(["/bin/kill", "-0", String(pid)], { timeoutMs: 2_000 }))
      .exitCode === 0
  );
};

const cleanupStale = async (
  runner: ProcessRunner,
  simctl: string,
  owner: SlotOwner | undefined,
): Promise<void> => {
  if (
    owner === undefined ||
    !LEASE_ROOT.test(owner.leaseRoot) ||
    owner.deviceSet !== join(owner.leaseRoot, "set")
  ) {
    throw new Error(
      "Invalid simulator lease metadata; refusing automatic cleanup",
    );
  }
  const prefix = [simctl, "--set", owner.deviceSet];
  // A crash can happen between create and persisting the returned UDID.
  // This set belongs exclusively to this lease, so deleting all of *this
  // private set* also recovers that gap, never another session's devices.
  await runner.run([...prefix, "shutdown", "all"], {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  await runChecked(runner, [...prefix, "delete", "all"]);
  await rm(owner.leaseRoot, { recursive: true, force: true });
};

const acquireCapacity = async (
  runner: ProcessRunner,
  simctl: string,
  owner: SlotOwner,
  capacityRoot: string,
): Promise<CapacityLease> => {
  await mkdir(capacityRoot, { recursive: true, mode: 0o700 });
  for (let index = 0; index < MAX_ACTIVE_SIMULATORS; index += 1) {
    const slot = join(capacityRoot, `slot-${index}`);
    let recovering: string | undefined;
    try {
      await mkdir(slot, { mode: 0o700 });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
      const previous = await readOwner(slot);
      if (previous !== undefined && (await processExists(runner, previous.pid)))
        continue;
      // Missing or damaged metadata cannot prove which device set is ours.
      // Fail closed, including the brief initial mkdir/owner-write window.
      if (previous === undefined) continue;
      // Keep the capacity slot occupied throughout recovery. Moving the slot
      // away would admit another simulator before the old device was deleted.
      const recovery = join(slot, "recovering");
      try {
        await mkdir(recovery, { mode: 0o700 });
      } catch {
        continue;
      }
      const current = await readOwner(slot);
      if (
        current?.token !== previous?.token ||
        (current && (await processExists(runner, current.pid)))
      ) {
        await rm(recovery, { recursive: true, force: true });
        continue;
      }
      try {
        await cleanupStale(runner, simctl, current);
      } catch (cause) {
        await rm(recovery, { recursive: true, force: true });
        throw new Error(
          "Could not recover the previous simulator; its capacity slot was preserved",
          { cause },
        );
      }
      recovering = recovery;
    }
    const writeOwner = async () => {
      const temporary = join(slot, `owner-${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(owner));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(slot, "owner.json"));
    };
    await writeOwner();
    if (recovering) await rm(recovering, { recursive: true, force: true });
    return {
      async updateUdid(udid) {
        owner.udid = udid;
        await writeOwner();
      },
      async release() {
        if ((await readOwner(slot))?.token === owner.token) {
          await rm(slot, { recursive: true, force: true });
        }
      },
    };
  }
  throw new Error(
    `Simulator capacity is full (${MAX_ACTIVE_SIMULATORS} active sessions)`,
  );
};

type DeviceType = { name: string; identifier: string };
type Runtime = { name: string; identifier: string; version?: string };

const chooseConfiguration = async (
  runner: ProcessRunner,
  simctl: string,
  requestedDevice: string | undefined,
  requestedRuntime: string | undefined,
): Promise<{
  deviceIdentifier: string;
  runtimeIdentifier: string;
  deviceName: string;
}> => {
  const parsed: unknown = JSON.parse(
    await runChecked(runner, [simctl, "list", "-j"]),
  );
  if (!isRecord(parsed)) throw new Error("simctl returned an invalid catalog");
  const devices: DeviceType[] = (
    Array.isArray(parsed.devicetypes) ? parsed.devicetypes : []
  ).flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      typeof item.identifier !== "string" ||
      !item.name.startsWith("iPhone")
    )
      return [];
    return [{ name: item.name, identifier: item.identifier }];
  });
  const runtimes: Runtime[] = (
    Array.isArray(parsed.runtimes) ? parsed.runtimes : []
  ).flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      typeof item.identifier !== "string" ||
      (item.platform !== "iOS" && !item.identifier.includes("iOS")) ||
      item.isAvailable === false ||
      item.availability === "(unavailable)"
    )
      return [];
    return [
      {
        name: item.name,
        identifier: item.identifier,
        ...(typeof item.version === "string" ? { version: item.version } : {}),
      },
    ];
  });
  const device = requestedDevice
    ? devices.find(
        (item) =>
          item.name === requestedDevice || item.identifier === requestedDevice,
      )
    : (devices.find((item) => item.name === "iPhone 16 Pro") ?? devices.at(-1));
  const runtime = requestedRuntime
    ? runtimes.find(
        (item) =>
          item.name === requestedRuntime ||
          item.identifier === requestedRuntime,
      )
    : runtimes.toSorted((a, b) =>
        (b.version ?? b.name).localeCompare(a.version ?? a.name, undefined, {
          numeric: true,
        }),
      )[0];
  if (device === undefined) {
    throw new Error(
      `No available iPhone device type matches ${requestedDevice ?? "the default"}`,
    );
  }
  if (runtime === undefined) {
    throw new Error(
      `No available iOS runtime matches ${requestedRuntime ?? "the default"}`,
    );
  }
  return {
    deviceIdentifier: device.identifier,
    runtimeIdentifier: runtime.identifier,
    deviceName: device.name,
  };
};

const validateApp = async (
  runner: ProcessRunner,
  workspaceDir: string,
  appPath: string,
): Promise<{ appPath: string; bundleId: string }> => {
  const workspace = await realpath(workspaceDir);
  const resolvedApp = await realpath(
    isAbsolute(appPath) ? appPath : join(workspace, appPath),
  );
  const fromWorkspace = relative(workspace, resolvedApp);
  if (
    fromWorkspace === "" ||
    fromWorkspace.startsWith("..") ||
    isAbsolute(fromWorkspace)
  ) {
    throw new Error("appPath must be an .app inside workspaceDir");
  }
  if (
    !(await stat(resolvedApp)).isDirectory() ||
    extname(resolvedApp) !== ".app"
  ) {
    throw new Error("appPath must name an iOS Simulator .app directory");
  }
  const plist = await realpath(join(resolvedApp, "Info.plist"));
  const plistRelative = relative(workspace, plist);
  if (plistRelative.startsWith("..") || isAbsolute(plistRelative))
    throw new Error("The app Info.plist must stay inside workspaceDir");
  const bundleId = await runChecked(runner, [
    "/usr/bin/plutil",
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    plist,
  ]);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(bundleId)) {
    throw new Error("The app has an invalid CFBundleIdentifier");
  }
  const platforms: unknown = JSON.parse(
    await runChecked(runner, [
      "/usr/bin/plutil",
      "-extract",
      "CFBundleSupportedPlatforms",
      "json",
      "-o",
      "-",
      plist,
    ]),
  );
  if (
    !Array.isArray(platforms) ||
    !platforms.includes("iPhoneSimulator") ||
    platforms.includes("iPhoneOS")
  ) {
    throw new Error(
      "appPath must be built for the iPhone Simulator, not a physical device",
    );
  }
  return { appPath: resolvedApp, bundleId };
};

const waitForCompanion = async (child: RunningProcess): Promise<void> => {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        while (true) {
          const next = await reader.read();
          if (next.done)
            throw new Error("idb_companion exited before reporting ready");
          pending += decoder.decode(next.value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            try {
              const report: unknown = JSON.parse(line);
              if (isRecord(report) && typeof report.grpc_path === "string")
                return;
            } catch {
              // Diagnostics can precede the JSON readiness report.
            }
          }
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void reader
            .cancel()
            .finally(() =>
              reject(
                new Error(
                  "idb_companion did not become ready within 30 seconds",
                ),
              ),
            );
        }, COMPANION_READY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.releaseLock();
  }
};

const stopProcess = async (child: RunningProcess): Promise<void> => {
  child.kill(15);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    child.exited.then(() => false),
    new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), PROCESS_STOP_TIMEOUT_MS);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (timedOut) {
    child.kill(9);
    await child.exited;
  }
};

const parseDimensions = (
  raw: string,
): { dimensions: { width: number; height: number }; density: number } => {
  const description: unknown = JSON.parse(raw);
  if (!isRecord(description) || !isRecord(description.screen_dimensions)) {
    throw new Error("idb describe did not report simulator screen dimensions");
  }
  const screen = description.screen_dimensions;
  if (
    typeof screen.width_points !== "number" ||
    typeof screen.height_points !== "number" ||
    typeof screen.density !== "number" ||
    !Number.isFinite(screen.width_points) ||
    !Number.isFinite(screen.height_points) ||
    !Number.isFinite(screen.density) ||
    screen.width_points <= 0 ||
    screen.height_points <= 0 ||
    screen.density <= 0
  ) {
    throw new Error(
      "idb describe did not report positive logical dimensions and density",
    );
  }
  return {
    dimensions: { width: screen.width_points, height: screen.height_points },
    density: screen.density,
  };
};

export const openIdbSimulator = async (
  options: OpenIdbSimulatorOptions,
  dependencies: IdbSimulatorDependencies = {
    runner: defaultRunner,
    platform: process.platform,
    pid: process.pid,
  },
): Promise<IdbSimulator> => {
  if (dependencies.platform !== "darwin") {
    throw new Error(
      "Simulator portal requires macOS with Xcode and idb installed",
    );
  }
  if (options.sessionId.trim() === "") throw new Error("sessionId is required");

  const app = await validateApp(
    dependencies.runner,
    options.workspaceDir,
    options.appPath,
  );
  const [simctl, idb, companion] = await Promise.all([
    findExecutable(dependencies.runner, "simctl"),
    findExecutable(dependencies.runner, "idb"),
    findExecutable(dependencies.runner, "idb_companion"),
  ]);
  const token = randomUUID();
  const sessionHash = createHash("sha256")
    .update(options.sessionId)
    .digest("hex")
    .slice(0, 8);
  const leaseRoot = `/tmp/osi-${sessionHash}-${token.slice(0, 8)}`;
  const deviceSet = join(leaseRoot, "set");
  const socketPath = join(leaseRoot, "idb.sock");
  await mkdir(deviceSet, { recursive: true, mode: 0o700 });
  let capacity: CapacityLease;
  try {
    capacity = await acquireCapacity(
      dependencies.runner,
      simctl,
      { pid: dependencies.pid, token, leaseRoot, deviceSet },
      dependencies.capacityRoot ?? CAPACITY_ROOT,
    );
  } catch (error) {
    await rm(leaseRoot, { recursive: true, force: true });
    throw error;
  }
  let udid: string | undefined;
  let companionProcess: RunningProcess | undefined;
  let videoProcess: RunningProcess | undefined;
  let closed = false;
  const simctlPrefix = [simctl, "--set", deviceSet];

  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (videoProcess !== undefined)
      await stopProcess(videoProcess).catch(() => undefined);
    if (companionProcess !== undefined)
      await stopProcess(companionProcess).catch(() => undefined);
    if (udid !== undefined) {
      await dependencies.runner
        .run([...simctlPrefix, "shutdown", udid], {
          timeoutMs: COMMAND_TIMEOUT_MS,
        })
        .catch(() => undefined);
      // Keep the durable slot if CoreSimulator refuses deletion. The next
      // start can recover it after this owner exits instead of losing track
      // of a still-running device and admitting another one.
      await runChecked(dependencies.runner, [...simctlPrefix, "delete", udid]);
    }
    await rm(leaseRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await capacity.release();
  };

  try {
    const configuration = await chooseConfiguration(
      dependencies.runner,
      simctl,
      options.deviceType,
      options.runtime,
    );
    const uniqueName = `Open Session ${sessionHash} ${token.slice(0, 6)}`;
    udid = await runChecked(dependencies.runner, [
      ...simctlPrefix,
      "create",
      uniqueName,
      configuration.deviceIdentifier,
      configuration.runtimeIdentifier,
    ]);
    if (!UUID.test(udid))
      throw new Error(`simctl create returned an invalid UDID: ${udid}`);
    await capacity.updateUdid(udid);
    await runChecked(dependencies.runner, [...simctlPrefix, "boot", udid]);
    await runChecked(
      dependencies.runner,
      [...simctlPrefix, "bootstatus", udid, "-b"],
      BOOT_TIMEOUT_MS,
    );
    await runChecked(dependencies.runner, [
      ...simctlPrefix,
      "install",
      udid,
      app.appPath,
    ]);
    await runChecked(dependencies.runner, [
      ...simctlPrefix,
      "launch",
      udid,
      app.bundleId,
    ]);

    companionProcess = dependencies.runner.spawn([
      companion,
      "--udid",
      udid,
      "--device-set-path",
      deviceSet,
      "--grpc-domain-sock",
      socketPath,
      "--log-file-path",
      join(leaseRoot, "companion.log"),
      "--terminate-offline",
      "1",
    ]);
    await waitForCompanion(companionProcess);
    const idbPrefix = [idb, "--companion", socketPath];
    const measurements = parseDimensions(
      await runChecked(dependencies.runner, [
        ...idbPrefix,
        "describe",
        "--json",
      ]),
    );

    return {
      udid,
      deviceName: configuration.deviceName,
      ...measurements,
      async startVideo(onChunk, onError) {
        if (closed) throw new Error("Simulator is closed");
        if (videoProcess !== undefined)
          throw new Error("Simulator video is already running");
        const child = dependencies.runner.spawn([
          ...idbPrefix,
          "video-stream",
          "--format",
          "mjpeg",
          "--fps",
          "15",
          "--scale-factor",
          "0.5",
        ]);
        videoProcess = child;
        let stopping = false;
        void (async () => {
          try {
            const reader = child.stdout.getReader();
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              onChunk(next.value);
            }
            const exitCode = await child.exited;
            if (!stopping && !closed) {
              onError(new Error(`idb video-stream exited with ${exitCode}`));
            }
          } catch (error) {
            if (!stopping)
              onError(
                error instanceof Error ? error : new Error(String(error)),
              );
          } finally {
            if (videoProcess === child) videoProcess = undefined;
          }
        })();
        return async () => {
          if (videoProcess !== child) return;
          stopping = true;
          await stopProcess(child);
          if (videoProcess === child) videoProcess = undefined;
        };
      },
      async input(command) {
        if (closed) throw new Error("Simulator is closed");
        await runChecked(dependencies.runner, [
          ...idbPrefix,
          ...inputArguments(command),
        ]);
      },
      close: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
};
