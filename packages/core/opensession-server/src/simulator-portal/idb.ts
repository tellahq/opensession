import { simulatorStorageRoot } from "./storage-root";
import { createHash, randomUUID } from "crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "path";
import {
  createPersistentIdbInput,
  idbHidEvent,
  idbTextEvents,
  type PersistentIdbInput,
} from "./idb-input";

export type SimulatorInput =
  | { kind: "tap"; x: number; y: number }
  | { kind: "touch"; phase: "down" | "move" | "up"; x: number; y: number }
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
  /** Pinned by the supervisor, never accepted as an MCP argument. */
  storageRoot?: string;
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
  /** Durable storage root. Tests should always provide a private directory. */
  durableRoot?: string;
  createInput?: (socketPath: string) => PersistentIdbInput;
};

const COMMAND_TIMEOUT_MS = 30_000;
const BOOT_TIMEOUT_MS = 120_000;
const COMPANION_READY_TIMEOUT_MS = 30_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;
const CAPACITY_ROOT = "/tmp/opensession-idb-simulator-capacity";
const MAX_ACTIVE_SIMULATORS = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_LEASE_ROOT = /^\/tmp\/osi-[0-9a-f]{8}-[0-9a-f]{8}$/;

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

const coordinate = (value: number, label: string): number => {
  finite(value, label);
  if (value < 0) throw new Error(`${label} must not be negative`);
  return Math.round(value);
};

const touchCoordinate = (value: number, label: string): number => {
  finite(value, label);
  if (value < 0) throw new Error(`${label} must not be negative`);
  return value;
};

const inputEvents = (
  command: Exclude<SimulatorInput, { kind: "touch" }>,
): Uint8Array[] => {
  switch (command.kind) {
    case "tap": {
      const x = coordinate(command.x, "tap x");
      const y = coordinate(command.y, "tap y");
      return [idbHidEvent.touch(x, y, "down"), idbHidEvent.touch(x, y, "up")];
    }
    case "swipe": {
      finite(command.duration, "swipe duration");
      if (command.duration < 0)
        throw new Error("swipe duration must not be negative");
      return [
        idbHidEvent.swipe(
          coordinate(command.x, "swipe x"),
          coordinate(command.y, "swipe y"),
          coordinate(command.endX, "swipe endX"),
          coordinate(command.endY, "swipe endY"),
          command.duration,
        ),
      ];
    }
    case "text":
      if (command.text.length > 10_000)
        throw new Error("text input is too long");
      return idbTextEvents(command.text);
    case "button":
      return [idbHidEvent.buttonHome("down"), idbHidEvent.buttonHome("up")];
    case "key":
      if (!Number.isSafeInteger(command.key) || command.key < 0) {
        throw new Error("key must be a non-negative integer");
      }
      return [
        idbHidEvent.key(command.key, "down"),
        idbHidEvent.key(command.key, "up"),
      ];
  }
};

type SlotOwner = {
  pid: number;
  token: string;
  leaseRoot: string;
  deviceSet: string;
  udid?: string;
  kind?: "persistent";
  repositoryRoot?: string;
  durableRoot?: string;
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
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.token !== "string" ||
    !/^[A-Za-z0-9-]{1,128}$/.test(value.token) ||
    typeof value.leaseRoot !== "string" ||
    typeof value.deviceSet !== "string" ||
    (value.udid !== undefined && typeof value.udid !== "string") ||
    (value.kind !== undefined && value.kind !== "persistent") ||
    (value.repositoryRoot !== undefined &&
      typeof value.repositoryRoot !== "string") ||
    (value.durableRoot !== undefined && typeof value.durableRoot !== "string")
  )
    return undefined;
  if (value.kind === "persistent" && !UUID.test(value.token)) return undefined;
  return {
    pid: value.pid,
    token: value.token,
    leaseRoot: value.leaseRoot,
    deviceSet: value.deviceSet,
    ...(value.udid === undefined ? {} : { udid: value.udid }),
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    ...(value.repositoryRoot === undefined
      ? {}
      : { repositoryRoot: value.repositoryRoot }),
    ...(value.durableRoot === undefined
      ? {}
      : { durableRoot: value.durableRoot }),
  };
};

const readOwner = async (slot: string): Promise<SlotOwner | undefined> => {
  try {
    const ownerPath = join(slot, "owner.json");
    const ownerStat = await lstat(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) return undefined;
    return parseSlotOwner(JSON.parse(await readFile(ownerPath, "utf8")));
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

const validatedPersistentSet = async (
  owner: SlotOwner,
  expectedDurableRoot: string | undefined,
): Promise<string> => {
  if (
    owner.kind !== "persistent" ||
    owner.repositoryRoot === undefined ||
    owner.durableRoot === undefined ||
    !isAbsolute(owner.repositoryRoot) ||
    !isAbsolute(owner.durableRoot) ||
    !isAbsolute(owner.deviceSet) ||
    owner.durableRoot !== expectedDurableRoot
  ) {
    throw new Error("Invalid persistent simulator lease metadata");
  }
  const durableRoot = await realpath(owner.durableRoot);
  const repositoryRoot = await realpath(owner.repositoryRoot);
  const deviceSet = await realpath(owner.deviceSet);
  const repositoryRelative = relative(durableRoot, repositoryRoot);
  const setRelative = relative(repositoryRoot, deviceSet);
  if (
    durableRoot !== owner.durableRoot ||
    repositoryRoot !== owner.repositoryRoot ||
    deviceSet !== owner.deviceSet ||
    !/^repositories\/[0-9a-f]{64}$/.test(repositoryRelative) ||
    !(
      /^profiles\/[0-9a-f]{64}\/set$/.test(setRelative) ||
      setRelative === "control-set" ||
      setRelative === "clear-set"
    ) ||
    (await lstat(deviceSet)).isSymbolicLink()
  ) {
    throw new Error("Unsafe persistent simulator path; refusing cleanup");
  }
  return deviceSet;
};

const cleanupStale = async (
  runner: ProcessRunner,
  simctl: string,
  owner: SlotOwner | undefined,
  expectedDurableRoot?: string,
): Promise<void> => {
  if (owner?.kind === "persistent") {
    const deviceSet = await validatedPersistentSet(owner, expectedDurableRoot);
    await runChecked(runner, [simctl, "--set", deviceSet, "shutdown", "all"]);
    await assertDeviceSetShutdown(runner, simctl, deviceSet);
    return;
  }
  if (
    owner === undefined ||
    !LEGACY_LEASE_ROOT.test(owner.leaseRoot) ||
    owner.deviceSet !== join(owner.leaseRoot, "set")
  ) {
    throw new Error(
      "Invalid simulator lease metadata; refusing automatic cleanup",
    );
  }
  const prefix = [simctl, "--set", owner.deviceSet];
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
    let repositoryRecovery: RepositoryLease | undefined;
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
      if (
        previous.kind === "persistent" &&
        previous.repositoryRoot !== owner.repositoryRoot
      ) {
        if (
          previous.repositoryRoot === undefined ||
          previous.durableRoot === undefined
        )
          continue;
        try {
          // Capacity is host-wide; a dead owner can belong to another instance.
          await validatedPersistentSet(previous, previous.durableRoot);
          repositoryRecovery = await acquireRepository(
            runner,
            simctl,
            previous.repositoryRoot,
            {
              ...previous,
              pid: owner.pid,
              token: randomUUID(),
            },
          );
        } catch {
          // A newer owner may already be using this repository. Its stale
          // capacity record must never be allowed to shut that owner down.
          continue;
        }
      }
      // Keep the capacity slot occupied throughout recovery. Moving the slot
      // away would admit another simulator before the old device was deleted.
      const recovery = join(slot, "recovering");
      try {
        await mkdir(recovery, { mode: 0o700 });
      } catch {
        await repositoryRecovery?.release();
        continue;
      }
      const current = await readOwner(slot);
      if (
        current?.token !== previous?.token ||
        (current && (await processExists(runner, current.pid)))
      ) {
        await rm(recovery, { recursive: true, force: true });
        await repositoryRecovery?.release();
        continue;
      }
      try {
        await cleanupStale(runner, simctl, current, previous.durableRoot);
      } catch (cause) {
        await rm(recovery, { recursive: true, force: true });
        await repositoryRecovery?.release();
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
    try {
      await writeOwner();
      if (recovering) await rm(recovering, { recursive: true, force: true });
    } catch (error) {
      await repositoryRecovery?.release();
      throw error;
    }
    await repositoryRecovery?.release();
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

type RepositoryLease = {
  update: () => Promise<void>;
  release: () => Promise<void>;
};
type StoredProfile = {
  deviceIdentifier: string;
  runtimeIdentifier: string;
  deviceName: string;
  udid?: string;
};

type RepositoryStorage = {
  repositoryRoot: string;
  durableRoot: string;
};

const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  const temporary = join(
    dirname(path),
    `.${basename(path)}-${randomUUID()}.tmp`,
  );
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
};

const canonicalRepository = async (
  runner: ProcessRunner,
  workspaceDir: string,
): Promise<string> => {
  const workspace = await realpath(workspaceDir);
  const git = await runner.run(
    [
      "/usr/bin/git",
      "-C",
      workspace,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    { timeoutMs: COMMAND_TIMEOUT_MS },
  );
  if (git.exitCode !== 0) {
    const detail = git.stderr.trim() || git.stdout.trim();
    if (/not a git repository|not a git work tree/i.test(detail))
      return workspace;
    throw new Error(
      `Could not resolve git common directory: ${detail || `exit ${git.exitCode}`}`,
    );
  }
  const commonDirectory = git.stdout.trim();
  if (!isAbsolute(commonDirectory)) {
    throw new Error("git returned a non-absolute common directory");
  }
  return realpath(commonDirectory);
};

const prepareRepositoryStorage = async (
  runner: ProcessRunner,
  workspaceDir: string,
  durableRootOption: string | undefined,
): Promise<RepositoryStorage> => {
  const canonicalPath = await canonicalRepository(runner, workspaceDir);
  const requestedRoot = durableRootOption ?? simulatorStorageRoot();
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const durableRoot = await realpath(requestedRoot);
  const repositoryRoot = join(
    durableRoot,
    "repositories",
    createHash("sha256").update(canonicalPath).digest("hex"),
  );
  await mkdir(repositoryRoot, { recursive: true, mode: 0o700 });
  if ((await realpath(repositoryRoot)) !== repositoryRoot) {
    throw new Error("Unsafe simulator repository storage path");
  }
  const metadataPath = join(repositoryRoot, "repository.json");
  try {
    if ((await lstat(metadataPath)).isSymbolicLink())
      throw new Error("Unsafe simulator repository metadata");
    const metadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
    if (!isRecord(metadata) || metadata.canonicalPath !== canonicalPath) {
      throw new Error("Simulator repository metadata does not match workspace");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await writeJsonAtomic(metadataPath, { version: 1, canonicalPath });
    } else if (error instanceof SyntaxError) {
      throw new Error("Invalid simulator repository metadata; refusing access");
    } else {
      throw error;
    }
  }
  return { repositoryRoot, durableRoot };
};

const profilePath = (
  repositoryRoot: string,
  deviceIdentifier: string,
  runtimeIdentifier: string,
): string =>
  join(
    repositoryRoot,
    "profiles",
    createHash("sha256")
      .update(`${deviceIdentifier}\0${runtimeIdentifier}`)
      .digest("hex"),
  );

const readStoredProfile = async (
  profileRoot: string,
  expected: Omit<StoredProfile, "udid">,
): Promise<StoredProfile> => {
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  if ((await realpath(profileRoot)) !== profileRoot)
    throw new Error("Unsafe simulator profile path");
  const metadataPath = join(profileRoot, "profile.json");
  try {
    await lstat(join(profileRoot, ".clearing"));
    throw new Error(
      "Simulator storage clear was interrupted; retry clearing storage",
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  try {
    if ((await lstat(metadataPath)).isSymbolicLink())
      throw new Error("Unsafe simulator profile metadata");
    const value: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
    if (
      !isRecord(value) ||
      value.deviceIdentifier !== expected.deviceIdentifier ||
      value.runtimeIdentifier !== expected.runtimeIdentifier ||
      value.deviceName !== expected.deviceName ||
      (value.udid !== undefined &&
        (typeof value.udid !== "string" || !UUID.test(value.udid)))
    ) {
      throw new Error("Invalid simulator profile metadata; refusing access");
    }
    return { ...expected, ...(value.udid ? { udid: value.udid } : {}) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await writeJsonAtomic(metadataPath, expected);
      return expected;
    }
    throw error instanceof SyntaxError
      ? new Error("Invalid simulator profile metadata; refusing access")
      : error;
  }
};

const acquireRepository = async (
  runner: ProcessRunner,
  simctl: string,
  repositoryRoot: string,
  owner: SlotOwner,
): Promise<RepositoryLease> => {
  const active = join(repositoryRoot, "active");
  try {
    await mkdir(active, { mode: 0o700 });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
    const activeStat = await lstat(active);
    if (!activeStat.isDirectory() || activeStat.isSymbolicLink())
      throw new Error("Unsafe simulator repository lock path");
    const previous = await readOwner(active);
    if (previous === undefined)
      throw new Error("Simulator repository is locked by invalid metadata");
    if (await processExists(runner, previous.pid))
      throw new Error("A simulator for this repository is already in use");
    const recovery = join(active, "recovering");
    try {
      await mkdir(recovery, { mode: 0o700 });
    } catch {
      throw new Error("Simulator repository recovery is already in progress");
    }
    const current = await readOwner(active);
    if (
      current?.token !== previous.token ||
      current.repositoryRoot !== repositoryRoot ||
      current.durableRoot !== owner.durableRoot ||
      (await processExists(runner, current.pid))
    ) {
      await rm(recovery, { recursive: true, force: true });
      throw new Error("A simulator for this repository is already in use");
    }
    try {
      await cleanupStale(runner, simctl, current, owner.durableRoot);
      await rm(active, { recursive: true });
    } catch (cause) {
      await rm(recovery, { recursive: true, force: true });
      throw new Error(
        "Could not safely recover the repository simulator lock",
        {
          cause,
        },
      );
    }
    return acquireRepository(runner, simctl, repositoryRoot, owner);
  }
  const writeOwner = () => writeJsonAtomic(join(active, "owner.json"), owner);
  try {
    await writeOwner();
  } catch (error) {
    await rm(active, { recursive: true, force: true });
    throw error;
  }
  return {
    update: writeOwner,
    async release() {
      if ((await readOwner(active))?.token === owner.token)
        await rm(active, { recursive: true, force: true });
    },
  };
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

const findStoredUdid = async (
  runner: ProcessRunner,
  simctl: string,
  deviceSet: string,
  configuration: {
    deviceIdentifier: string;
    runtimeIdentifier: string;
  },
): Promise<string | undefined> => {
  const value: unknown = JSON.parse(
    await runChecked(runner, [
      simctl,
      "--set",
      deviceSet,
      "list",
      "devices",
      "-j",
    ]),
  );
  if (!isRecord(value) || !isRecord(value.devices))
    throw new Error("simctl returned invalid retained device data");
  const retained: string[] = [];
  for (const [runtime, devices] of Object.entries(value.devices)) {
    if (!Array.isArray(devices))
      throw new Error("simctl returned invalid retained device data");
    for (const device of devices) {
      if (
        runtime !== configuration.runtimeIdentifier ||
        !isRecord(device) ||
        typeof device.udid !== "string" ||
        !UUID.test(device.udid) ||
        (device.deviceTypeIdentifier !== undefined &&
          device.deviceTypeIdentifier !== configuration.deviceIdentifier)
      ) {
        throw new Error("Unexpected device in retained simulator profile");
      }
      retained.push(device.udid);
    }
  }
  if (retained.length > 1)
    throw new Error("Retained simulator profile contains multiple devices");
  return retained[0];
};

const assertDeviceSetShutdown = async (
  runner: ProcessRunner,
  simctl: string,
  deviceSet: string,
): Promise<void> => {
  const value: unknown = JSON.parse(
    await runChecked(runner, [
      simctl,
      "--set",
      deviceSet,
      "list",
      "devices",
      "-j",
    ]),
  );
  if (!isRecord(value) || !isRecord(value.devices))
    throw new Error(
      "simctl returned invalid device state while clearing storage",
    );
  for (const devices of Object.values(value.devices)) {
    if (!Array.isArray(devices))
      throw new Error(
        "simctl returned invalid device state while clearing storage",
      );
    for (const device of devices) {
      if (!isRecord(device) || device.state !== "Shutdown")
        throw new Error("Simulator did not shut down; storage was preserved");
    }
  }
};

const releaseRepositoryCapacityRecords = async (
  runner: ProcessRunner,
  capacityRoot: string,
  storage: RepositoryStorage,
  verifiedDeviceSets: ReadonlySet<string>,
): Promise<void> => {
  for (let index = 0; index < MAX_ACTIVE_SIMULATORS; index += 1) {
    const slot = join(capacityRoot, `slot-${index}`);
    let slotStat;
    try {
      slotStat = await lstat(slot);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
    if (!slotStat.isDirectory() || slotStat.isSymbolicLink())
      throw new Error("Unsafe simulator capacity slot; refusing clear");
    const previous = await readOwner(slot);
    if (previous === undefined)
      throw new Error("Invalid simulator capacity metadata; refusing clear");
    if (
      previous.kind !== "persistent" ||
      previous.repositoryRoot !== storage.repositoryRoot ||
      previous.durableRoot !== storage.durableRoot
    ) {
      continue;
    }
    const setRelative = relative(storage.repositoryRoot, previous.deviceSet);
    if (
      !isAbsolute(previous.deviceSet) ||
      !/^profiles\/[0-9a-f]{64}\/set$/.test(setRelative) ||
      !verifiedDeviceSets.has(previous.deviceSet)
    ) {
      throw new Error("Invalid repository capacity metadata; refusing clear");
    }
    if (await processExists(runner, previous.pid))
      throw new Error(
        "The repository still has an active simulator capacity lease",
      );
    const recovery = join(slot, "recovering");
    try {
      await mkdir(recovery, { mode: 0o700 });
    } catch {
      throw new Error("Simulator capacity recovery is already in progress");
    }
    const current = await readOwner(slot);
    if (
      current?.token !== previous.token ||
      current.repositoryRoot !== storage.repositoryRoot ||
      current.durableRoot !== storage.durableRoot ||
      (await processExists(runner, current.pid))
    ) {
      await rm(recovery, { recursive: true, force: true });
      throw new Error("Simulator capacity changed while clearing storage");
    }
    await rm(slot, { recursive: true });
  }
};

export const clearIdbSimulatorStorage = async (
  options: { workspaceDir: string; storageRoot?: string },
  dependencies: IdbSimulatorDependencies = {
    runner: defaultRunner,
    platform: process.platform,
    pid: process.pid,
  },
): Promise<void> => {
  if (dependencies.platform !== "darwin")
    throw new Error("Simulator storage can only be cleared on macOS");
  const simctl = await findExecutable(dependencies.runner, "simctl");
  const storage = await prepareRepositoryStorage(
    dependencies.runner,
    options.workspaceDir,
    dependencies.durableRoot ?? options.storageRoot,
  );
  const clearSet = join(storage.repositoryRoot, "clear-set");
  await mkdir(clearSet, { recursive: true, mode: 0o700 });
  if ((await realpath(clearSet)) !== clearSet)
    throw new Error("Unsafe simulator clear path");
  const token = randomUUID();
  const owner: SlotOwner = {
    pid: dependencies.pid,
    token,
    leaseRoot: storage.repositoryRoot,
    deviceSet: clearSet,
    kind: "persistent",
    repositoryRoot: storage.repositoryRoot,
    durableRoot: storage.durableRoot,
  };
  const lease = await acquireRepository(
    dependencies.runner,
    simctl,
    storage.repositoryRoot,
    owner,
  );
  try {
    const profilesRoot = join(storage.repositoryRoot, "profiles");
    let entries: Array<{
      name: string;
      isDirectory: () => boolean;
      isSymbolicLink: () => boolean;
    }> = [];
    try {
      if ((await realpath(profilesRoot)) !== profilesRoot)
        throw new Error("Unsafe simulator profiles path");
      entries = await readdir(profilesRoot, { withFileTypes: true });
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    const profiles: Array<{ root: string; deviceSet: string }> = [];
    const metadataOnlyProfiles: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("Invalid simulator profile entry; refusing clear");
      const root = join(profilesRoot, entry.name);
      if ((await realpath(root)) !== root)
        throw new Error("Unsafe simulator profile path; refusing clear");
      const metadataPath = join(root, "profile.json");
      let clearing = false;
      try {
        const marker = await lstat(join(root, ".clearing"));
        if (!marker.isFile() || marker.isSymbolicLink())
          throw new Error("Unsafe simulator clear marker");
        clearing = true;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
      let hasStoredDevice = true;
      if (!clearing) {
        if ((await lstat(metadataPath)).isSymbolicLink())
          throw new Error("Unsafe simulator profile metadata; refusing clear");
        const metadata: unknown = JSON.parse(
          await readFile(metadataPath, "utf8"),
        );
        if (
          !isRecord(metadata) ||
          typeof metadata.deviceIdentifier !== "string" ||
          typeof metadata.runtimeIdentifier !== "string" ||
          typeof metadata.deviceName !== "string" ||
          (metadata.udid !== undefined &&
            (typeof metadata.udid !== "string" || !UUID.test(metadata.udid)))
        ) {
          throw new Error("Invalid simulator profile metadata; refusing clear");
        }
        hasStoredDevice = metadata.udid !== undefined;
      }
      const deviceSet = join(root, "set");
      try {
        // lstat distinguishes the pre-device crash gap from a dangling symlink.
        await lstat(deviceSet);
      } catch (error) {
        if (
          !hasStoredDevice &&
          !clearing &&
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          metadataOnlyProfiles.push(root);
          continue;
        }
        throw error;
      }
      if ((await realpath(deviceSet)) !== deviceSet)
        throw new Error("Unsafe simulator device set; refusing clear");
      profiles.push({ root, deviceSet });
    }
    // Preflight every retained profile before changing any of them.
    for (const { deviceSet } of profiles) {
      await runChecked(dependencies.runner, [
        simctl,
        "--set",
        deviceSet,
        "shutdown",
        "all",
      ]);
    }
    for (const { deviceSet } of profiles)
      await assertDeviceSetShutdown(dependencies.runner, simctl, deviceSet);
    await releaseRepositoryCapacityRecords(
      dependencies.runner,
      dependencies.capacityRoot ?? CAPACITY_ROOT,
      storage,
      new Set(profiles.map(({ deviceSet }) => deviceSet)),
    );
    for (const root of metadataOnlyProfiles)
      await rm(root, { recursive: true });
    for (const { root, deviceSet } of profiles) {
      await writeJsonAtomic(join(root, ".clearing"), { version: 1 });
      await rm(join(root, "profile.json"), { force: true });
      await runChecked(dependencies.runner, [
        simctl,
        "--set",
        deviceSet,
        "delete",
        "all",
      ]);
      // Removing each completed profile makes an interrupted clear retryable:
      // no retained metadata can point at a device that was already deleted.
      await rm(root, { recursive: true });
    }
    await rm(profilesRoot, { recursive: true, force: true });
  } finally {
    await lease.release();
  }
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
  const configuration = await chooseConfiguration(
    dependencies.runner,
    simctl,
    options.deviceType,
    options.runtime,
  );
  const storage = await prepareRepositoryStorage(
    dependencies.runner,
    options.workspaceDir,
    dependencies.durableRoot ?? options.storageRoot,
  );
  const profileRoot = profilePath(
    storage.repositoryRoot,
    configuration.deviceIdentifier,
    configuration.runtimeIdentifier,
  );
  const deviceSet = join(profileRoot, "set");
  const controlSet = join(storage.repositoryRoot, "control-set");
  await mkdir(controlSet, { recursive: true, mode: 0o700 });
  if ((await realpath(controlSet)) !== controlSet)
    throw new Error("Unsafe simulator control path");

  const token = randomUUID();
  const repositoryHash = basename(storage.repositoryRoot).slice(0, 8);
  const runtimeRoot = `/tmp/osi-${repositoryHash}-${token.slice(0, 8)}`;
  const socketPath = join(runtimeRoot, "idb.sock");
  await mkdir(runtimeRoot, { mode: 0o700 });
  const owner: SlotOwner = {
    pid: dependencies.pid,
    token,
    leaseRoot: runtimeRoot,
    deviceSet: controlSet,
    kind: "persistent",
    repositoryRoot: storage.repositoryRoot,
    durableRoot: storage.durableRoot,
  };
  let repositoryLease: RepositoryLease;
  let capacity: CapacityLease;
  let storedProfile: StoredProfile;
  try {
    repositoryLease = await acquireRepository(
      dependencies.runner,
      simctl,
      storage.repositoryRoot,
      owner,
    );
    try {
      storedProfile = await readStoredProfile(profileRoot, configuration);
      await mkdir(deviceSet, { recursive: true, mode: 0o700 });
      if ((await realpath(deviceSet)) !== deviceSet)
        throw new Error("Unsafe simulator device set path");
      owner.deviceSet = deviceSet;
      if (storedProfile.udid !== undefined) owner.udid = storedProfile.udid;
      await repositoryLease.update();
      capacity = await acquireCapacity(
        dependencies.runner,
        simctl,
        owner,
        dependencies.capacityRoot ?? CAPACITY_ROOT,
      );
    } catch (error) {
      await repositoryLease.release();
      throw error;
    }
  } catch (error) {
    await rm(runtimeRoot, { recursive: true, force: true });
    throw error;
  }
  let udid: string | undefined = storedProfile.udid;
  let companionProcess: RunningProcess | undefined;
  let video: { stop: () => Promise<void> } | undefined;
  let inputTransport: PersistentIdbInput | undefined;
  let closed = false;
  const simctlPrefix = [simctl, "--set", deviceSet];

  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (video !== undefined) await video.stop().catch(() => undefined);
    if (inputTransport !== undefined)
      await inputTransport.close().catch(() => undefined);
    if (companionProcess !== undefined)
      await stopProcess(companionProcess).catch(() => undefined);
    if (udid !== undefined) {
      // Do not release either lease until CoreSimulator confirms shutdown.
      // A failed shutdown remains recoverable without admitting a third boot.
      await runChecked(dependencies.runner, [
        ...simctlPrefix,
        "shutdown",
        udid,
      ]);
      await assertDeviceSetShutdown(dependencies.runner, simctl, deviceSet);
    }
    await capacity.release();
    await repositoryLease.release();
    await rm(runtimeRoot, { recursive: true, force: true });
  };

  try {
    if (udid === undefined) {
      udid = await findStoredUdid(
        dependencies.runner,
        simctl,
        deviceSet,
        configuration,
      );
      if (udid !== undefined) {
        await writeJsonAtomic(join(profileRoot, "profile.json"), {
          ...configuration,
          udid,
        });
      }
    }
    if (udid === undefined) {
      const uniqueName = `Open Session ${repositoryHash} ${basename(profileRoot).slice(0, 6)}`;
      udid = await runChecked(dependencies.runner, [
        ...simctlPrefix,
        "create",
        uniqueName,
        configuration.deviceIdentifier,
        configuration.runtimeIdentifier,
      ]);
      if (!UUID.test(udid))
        throw new Error(`simctl create returned an invalid UDID: ${udid}`);
      await writeJsonAtomic(join(profileRoot, "profile.json"), {
        ...configuration,
        udid,
      });
    }
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
      join(runtimeRoot, "companion.log"),
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
    inputTransport = (dependencies.createInput ?? createPersistentIdbInput)(
      socketPath,
    );

    return {
      udid,
      deviceName: configuration.deviceName,
      ...measurements,
      async startVideo(onChunk, onError) {
        if (closed) throw new Error("Simulator is closed");
        if (video !== undefined)
          throw new Error("Simulator video is already running");
        let stopping = false;
        let resolveStopped: (() => void) | undefined;
        const stopped = new Promise<void>((resolve) => {
          resolveStopped = resolve;
        });
        const current = {
          async stop() {
            stopping = true;
            await stopped;
          },
        };
        video = current;
        void (async () => {
          try {
            while (!stopping && !closed) {
              const started = performance.now();
              const frame = await inputTransport!.screenshot({
                quality: 0.5,
                scale: 0.5,
              });
              if (stopping || closed) break;
              onChunk(frame);
              const remaining = 1000 / 30 - (performance.now() - started);
              if (remaining > 0) await Bun.sleep(remaining);
            }
          } catch (error) {
            if (!stopping && !closed) {
              onError(
                error instanceof Error ? error : new Error(String(error)),
              );
            }
          } finally {
            if (video === current) video = undefined;
            resolveStopped?.();
          }
        })();
        return current.stop;
      },
      async input(command) {
        if (closed) throw new Error("Simulator is closed");
        if (command.kind === "touch") {
          const x = touchCoordinate(command.x, "touch x");
          const y = touchCoordinate(command.y, "touch y");
          await inputTransport?.touch(command.phase, x, y);
          return;
        }
        await inputTransport?.send(inputEvents(command));
      },
      close: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
};
