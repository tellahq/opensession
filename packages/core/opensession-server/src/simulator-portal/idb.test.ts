import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "fs/promises";
import { join } from "path";
import {
  clearIdbSimulatorStorage,
  openIdbSimulator,
  type IdbSimulatorDependencies,
} from "./idb";

const UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const createApp = async (): Promise<{
  workspaceDir: string;
  appPath: string;
  capacityRoot: string;
}> => {
  const workspaceDir = await mkdtemp("/tmp/idb-backend-test-");
  temporaryDirectories.push(workspaceDir);
  const appPath = join(workspaceDir, "Build", "Example.app");
  await mkdir(appPath, { recursive: true });
  await writeFile(join(appPath, "Info.plist"), "fixture");
  return {
    workspaceDir,
    appPath,
    capacityRoot: join(workspaceDir, "capacity"),
  };
};

const streamFrom = (chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

type FakeProcess = {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: (signal?: number) => void;
};

const longLivedProcess = (stdout: ReadableStream<Uint8Array>): FakeProcess => {
  let finish: ((code: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  return {
    stdout,
    exited,
    kill() {
      finish?.(0);
    },
  };
};

const fakeDependencies = (
  capacityRoot: string,
  describeResult: unknown = {
    screen_dimensions: {
      width: 1179,
      height: 2556,
      density: 3,
      width_points: 393,
      height_points: 852,
    },
  },
): {
  dependencies: IdbSimulatorDependencies;
  commands: string[][];
  spawned: string[][];
  inputBatches: Uint8Array[][];
  touches: Array<{ phase: "down" | "move" | "up"; x: number; y: number }>;
} => {
  const commands: string[][] = [];
  const spawned: string[][] = [];
  const inputBatches: Uint8Array[][] = [];
  const touches: Array<{
    phase: "down" | "move" | "up";
    x: number;
    y: number;
  }> = [];
  const dependencies: IdbSimulatorDependencies = {
    platform: "darwin",
    pid: process.pid,
    capacityRoot,
    durableRoot: join(capacityRoot, "durable"),
    createInput: () => ({
      async send(events) {
        inputBatches.push(events);
      },
      async touch(phase, x, y) {
        touches.push({ phase, x, y });
      },
      async screenshot() {
        return new Uint8Array();
      },
      async close() {},
    }),
    runner: {
      async run(argv) {
        commands.push(argv);
        if (argv[0] === "/usr/bin/git") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "not a git repository",
          };
        }
        if (argv[0] === "/usr/bin/plutil") {
          return {
            exitCode: 0,
            stdout: argv.includes("CFBundleIdentifier")
              ? "com.example.fixture\n"
              : '["iPhoneSimulator"]\n',
            stderr: "",
          };
        }
        if (argv[0] === "/usr/bin/xcrun") {
          return { exitCode: 0, stdout: "/usr/bin/simctl\n", stderr: "" };
        }
        if (argv[0] === "/usr/bin/which") {
          return {
            exitCode: 0,
            stdout: `/usr/local/bin/${argv[1]}\n`,
            stderr: "",
          };
        }
        if (
          argv[0] === "/usr/bin/simctl" &&
          argv.includes("list") &&
          argv.includes("devices")
        ) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ devices: { "iOS 18.2": [] } }),
            stderr: "",
          };
        }
        if (argv[0] === "/usr/bin/simctl" && argv[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              devicetypes: [
                {
                  name: "iPhone 16 Pro",
                  identifier:
                    "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
                },
              ],
              runtimes: [
                {
                  name: "iOS 18.2",
                  identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
                  platform: "iOS",
                  version: "18.2",
                  isAvailable: true,
                },
              ],
            }),
            stderr: "",
          };
        }
        if (argv.includes("create")) {
          return { exitCode: 0, stdout: `${UDID}\n`, stderr: "" };
        }
        if (argv.includes("describe")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify(describeResult),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn(argv) {
        spawned.push(argv);
        if (argv[0]?.endsWith("idb_companion")) {
          return longLivedProcess(
            streamFrom(['diagnostic\n{"grpc_path":"/tmp/private.sock"}\n']),
          );
        }
        return longLivedProcess(streamFrom([]));
      },
    },
  };
  return { dependencies, commands, spawned, inputBatches, touches };
};

describe("openIdbSimulator", () => {
  test("owns a private device and addresses only its private companion", async () => {
    const fixture = await createApp();
    const fake = fakeDependencies(fixture.capacityRoot);
    const simulator = await openIdbSimulator(
      {
        sessionId: "session-one",
        workspaceDir: fixture.workspaceDir,
        appPath: fixture.appPath,
      },
      fake.dependencies,
    );

    expect(simulator.udid).toBe(UDID);
    expect(simulator.dimensions).toEqual({ width: 393, height: 852 });
    expect(simulator.density).toBe(3);
    await simulator.input({ kind: "tap", x: 20, y: 40 });
    await simulator.input({
      kind: "swipe",
      x: 10,
      y: 20,
      endX: 30,
      endY: 40,
      duration: 0.5,
    });
    await simulator.input({ kind: "touch", phase: "down", x: 1.2, y: 2.8 });
    await simulator.input({ kind: "touch", phase: "move", x: 3, y: 4 });
    await simulator.input({ kind: "touch", phase: "up", x: 5, y: 6 });

    const companion = fake.spawned[0] ?? [];
    expect(companion).toContain("--device-set-path");
    expect(companion).toContain("--grpc-domain-sock");
    expect(
      companion[companion.indexOf("--grpc-domain-sock") + 1]!.length,
    ).toBeLessThan(104);
    expect(companion).toContain(UDID);
    expect(fake.inputBatches.map((batch) => batch.length)).toEqual([2, 1]);
    expect(fake.touches).toEqual([
      { phase: "down", x: 1.2, y: 2.8 },
      { phase: "move", x: 3, y: 4 },
      { phase: "up", x: 5, y: 6 },
    ]);
    expect(fake.commands.some((argv) => argv.includes("ui"))).toBe(false);

    await simulator.close();
    const targetCommands = fake.commands.filter(
      (argv) =>
        argv[0] === "/usr/bin/simctl" &&
        ["boot", "bootstatus", "install", "launch", "shutdown", "delete"].some(
          (verb) => argv.includes(verb),
        ),
    );
    expect(targetCommands.length).toBeGreaterThan(0);
    for (const argv of targetCommands) {
      expect(argv[1]).toBe("--set");
      expect(argv).toContain(UDID);
    }
  });

  test("streams bounded screenshot RPCs through the MJPEG callback API", async () => {
    const fixture = await createApp();
    const fake = fakeDependencies(fixture.capacityRoot);
    const videoBytes = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    const screenshotOptions: Array<{ quality: number; scale: number }> = [];
    fake.dependencies.createInput = () => ({
      async send() {},
      async touch() {},
      async screenshot(options) {
        screenshotOptions.push(options);
        return videoBytes;
      },
      async close() {},
    });
    const simulator = await openIdbSimulator(
      {
        sessionId: "video-session",
        workspaceDir: fixture.workspaceDir,
        appPath: fixture.appPath,
      },
      fake.dependencies,
    );
    const chunks: Uint8Array[] = [];
    const errors: Error[] = [];
    const stop = await simulator.startVideo(
      (chunk) => chunks.push(chunk),
      (error) => errors.push(error),
    );
    await Bun.sleep(10);
    await stop();
    expect(chunks).toEqual([videoBytes]);
    expect(screenshotOptions).toEqual([{ quality: 0.5, scale: 0.5 }]);
    expect(fake.spawned).toHaveLength(1);
    expect(errors).toEqual([]);
    await simulator.close();
  });

  test("fails but retains its device when logical dimensions are absent", async () => {
    const fixture = await createApp();
    const fake = fakeDependencies(fixture.capacityRoot, {
      screen_dimensions: { width: 1179, height: 2556 },
    });
    await expect(
      openIdbSimulator(
        {
          sessionId: "bad-description",
          workspaceDir: fixture.workspaceDir,
          appPath: fixture.appPath,
        },
        fake.dependencies,
      ),
    ).rejects.toThrow("logical dimensions and density");
    expect(fake.commands).toContainEqual(
      expect.arrayContaining(["shutdown", UDID]),
    );
    expect(fake.commands).not.toContainEqual(
      expect.arrayContaining(["delete", UDID]),
    );
  });

  test("does not steal newly-created ownerless capacity slots", async () => {
    const fixture = await createApp();
    await mkdir(join(fixture.capacityRoot, "slot-0"), { recursive: true });
    await mkdir(join(fixture.capacityRoot, "slot-1"), { recursive: true });
    const fake = fakeDependencies(fixture.capacityRoot);
    await expect(
      openIdbSimulator(
        {
          sessionId: "capacity-race",
          workspaceDir: fixture.workspaceDir,
          appPath: fixture.appPath,
        },
        fake.dependencies,
      ),
    ).rejects.toThrow("capacity is full");
    expect(fake.commands.some((argv) => argv.includes("create"))).toBe(false);
  });

  test("rejects a physical-device app before creating a simulator", async () => {
    const fixture = await createApp();
    const fake = fakeDependencies(fixture.capacityRoot);
    const originalRun = fake.dependencies.runner.run;
    fake.dependencies.runner.run = async (argv, options) => {
      if (argv.includes("CFBundleSupportedPlatforms")) {
        fake.commands.push(argv);
        return { exitCode: 0, stdout: '["iPhoneOS"]', stderr: "" };
      }
      return originalRun(argv, options);
    };
    await expect(
      openIdbSimulator(
        {
          sessionId: "device-app",
          workspaceDir: fixture.workspaceDir,
          appPath: fixture.appPath,
        },
        fake.dependencies,
      ),
    ).rejects.toThrow("not a physical device");
    expect(fake.commands.some((argv) => argv.includes("create"))).toBe(false);
  });
});

test("an owned device created before metadata was written is reused", async () => {
  const fixture = await createApp();
  const fake = fakeDependencies(fixture.capacityRoot);
  const run = fake.dependencies.runner.run;
  fake.dependencies.runner.run = async (args, options) => {
    if (
      args[0] === "/usr/bin/simctl" &&
      args.includes("list") &&
      args.includes("devices")
    ) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
              {
                udid: UDID,
                state: "Shutdown",
                deviceTypeIdentifier:
                  "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
              },
            ],
          },
        }),
        stderr: "",
      };
    }
    return run(args, options);
  };
  const simulator = await openIdbSimulator(
    {
      sessionId: "orphan-recovery",
      workspaceDir: fixture.workspaceDir,
      appPath: fixture.appPath,
    },
    fake.dependencies,
  );
  await simulator.close();
  expect(fake.commands.some((args) => args.includes("create"))).toBe(false);
  expect(fake.commands).toContainEqual(expect.arrayContaining(["boot", UDID]));
});

test("a repository is exclusive and reuses its stopped device", async () => {
  const fixture = await createApp();
  const fake = fakeDependencies(fixture.capacityRoot);
  const start = (sessionId: string) =>
    openIdbSimulator(
      {
        sessionId,
        workspaceDir: fixture.workspaceDir,
        appPath: fixture.appPath,
      },
      fake.dependencies,
    );
  const first = await start("first");
  await expect(start("second")).rejects.toThrow("already in use");
  await first.close();

  const reopened = await start("second");
  await reopened.close();
  expect(fake.commands.filter((args) => args.includes("create"))).toHaveLength(
    1,
  );
  expect(fake.commands.filter((args) => args.includes("install"))).toHaveLength(
    2,
  );
  expect(fake.commands.some((args) => args.includes("delete"))).toBe(false);
});

test("linked worktrees sharing a git common directory share exclusivity", async () => {
  const firstFixture = await createApp();
  const secondFixture = await createApp();
  const commonDirectory = await mkdtemp("/tmp/idb-common-git-");
  temporaryDirectories.push(commonDirectory);
  const fake = fakeDependencies(firstFixture.capacityRoot);
  const run = fake.dependencies.runner.run;
  fake.dependencies.runner.run = async (args, options) => {
    if (args[0] === "/usr/bin/git")
      return { exitCode: 0, stdout: `${commonDirectory}\n`, stderr: "" };
    return run(args, options);
  };
  const first = await openIdbSimulator(
    {
      sessionId: "worktree-one",
      workspaceDir: firstFixture.workspaceDir,
      appPath: firstFixture.appPath,
    },
    fake.dependencies,
  );
  try {
    await expect(
      openIdbSimulator(
        {
          sessionId: "worktree-two",
          workspaceDir: secondFixture.workspaceDir,
          appPath: secondFixture.appPath,
        },
        fake.dependencies,
      ),
    ).rejects.toThrow("already in use");
  } finally {
    await first.close();
  }
});

test("separate clones are isolated while sharing global capacity", async () => {
  const fixtures = await Promise.all([createApp(), createApp(), createApp()]);
  const fake = fakeDependencies(fixtures[0]!.capacityRoot);
  const start = (index: number) =>
    openIdbSimulator(
      {
        sessionId: `clone-${index}`,
        workspaceDir: fixtures[index]!.workspaceDir,
        appPath: fixtures[index]!.appPath,
      },
      fake.dependencies,
    );
  const [first, second] = await Promise.all([start(0), start(1)]);
  try {
    await expect(start(2)).rejects.toThrow("capacity is full");
  } finally {
    await first.close();
    await second.close();
  }
});

test("stale capacity metadata cannot shut down a newer repository owner", async () => {
  const firstFixture = await createApp();
  const secondFixture = await createApp();
  const fake = fakeDependencies(firstFixture.capacityRoot);
  const first = await openIdbSimulator(
    {
      sessionId: "newer-owner",
      workspaceDir: firstFixture.workspaceDir,
      appPath: firstFixture.appPath,
    },
    fake.dependencies,
  );
  const slotOwnerPath = join(firstFixture.capacityRoot, "slot-0", "owner.json");
  const staleOwner = JSON.parse(await Bun.file(slotOwnerPath).text());
  staleOwner.pid = 99999999;
  staleOwner.token = "11111111-2222-4333-8444-555555555555";
  await writeFile(slotOwnerPath, JSON.stringify(staleOwner));
  const run = fake.dependencies.runner.run;
  fake.dependencies.runner.run = async (args, options) => {
    if (args[0] === "/bin/kill" && args[2] === "99999999")
      return { exitCode: 1, stdout: "", stderr: "no process" };
    return run(args, options);
  };
  const commandCount = fake.commands.length;
  const second = await openIdbSimulator(
    {
      sessionId: "other-repository",
      workspaceDir: secondFixture.workspaceDir,
      appPath: secondFixture.appPath,
    },
    fake.dependencies,
  );
  expect(
    fake.commands.slice(commandCount).some((args) => args.includes("shutdown")),
  ).toBe(false);
  await first.close();
  await second.close();
});

test("corrupt foreign capacity metadata cannot create an outside repository lock", async () => {
  const fixture = await createApp();
  const fake = fakeDependencies(fixture.capacityRoot);
  const outsideRoot = await mkdtemp("/tmp/idb-outside-repository-");
  temporaryDirectories.push(outsideRoot);
  const repositoryRoot = join(outsideRoot, "repositories", "a".repeat(64));
  const deviceSet = join(repositoryRoot, "profiles", "b".repeat(64), "set");
  await mkdir(deviceSet, { recursive: true });
  const slot = join(fixture.capacityRoot, "slot-0");
  await mkdir(slot, { recursive: true });
  await mkdir(fake.dependencies.durableRoot!, { recursive: true });
  await writeFile(
    join(slot, "owner.json"),
    JSON.stringify({
      pid: 99999999,
      token: "11111111-2222-4333-8444-555555555555",
      leaseRoot: join(outsideRoot, "runtime"),
      deviceSet,
      udid: UDID,
      kind: "persistent",
      repositoryRoot,
      durableRoot: await realpath(fake.dependencies.durableRoot!),
    }),
  );
  const run = fake.dependencies.runner.run;
  fake.dependencies.runner.run = async (args, options) => {
    if (args[0] === "/bin/kill" && args[2] === "99999999")
      return { exitCode: 1, stdout: "", stderr: "no process" };
    return run(args, options);
  };
  const simulator = await openIdbSimulator(
    {
      sessionId: "outside-path",
      workspaceDir: fixture.workspaceDir,
      appPath: fixture.appPath,
    },
    fake.dependencies,
  );
  expect(await Bun.file(join(repositoryRoot, "active")).exists()).toBe(false);
  await simulator.close();
});

test("device and runtime profiles retain independent devices", async () => {
  const fixture = await createApp();
  const fake = fakeDependencies(fixture.capacityRoot);
  const run = fake.dependencies.runner.run;
  fake.dependencies.runner.run = async (args, options) => {
    if (args[0] === "/usr/bin/simctl" && args[1] === "list") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          devicetypes: [
            {
              name: "iPhone 16 Pro",
              identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
            },
          ],
          runtimes: ["18-2", "18-3"].map((version) => ({
            name: `iOS ${version.replace("-", ".")}`,
            identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version}`,
            platform: "iOS",
            version: version.replace("-", "."),
            isAvailable: true,
          })),
        }),
        stderr: "",
      };
    }
    return run(args, options);
  };
  for (const runtime of ["iOS 18.2", "iOS 18.3", "iOS 18.2"]) {
    const simulator = await openIdbSimulator(
      {
        sessionId: runtime,
        workspaceDir: fixture.workspaceDir,
        appPath: fixture.appPath,
        runtime,
      },
      fake.dependencies,
    );
    await simulator.close();
  }
  const createCommands = fake.commands.filter((args) =>
    args.includes("create"),
  );
  expect(createCommands).toHaveLength(2);
  expect(new Set(createCommands.map((args) => args[2])).size).toBe(2);
});

test("clear refuses a busy repository and resets all stopped profiles", async () => {
  const fixture = await createApp();
  const fake = fakeDependencies(fixture.capacityRoot);
  const options = {
    sessionId: "clear",
    workspaceDir: fixture.workspaceDir,
    appPath: fixture.appPath,
  };
  const running = await openIdbSimulator(options, fake.dependencies);
  await expect(
    clearIdbSimulatorStorage(
      { workspaceDir: fixture.workspaceDir },
      fake.dependencies,
    ),
  ).rejects.toThrow("already in use");
  await running.close();
  await clearIdbSimulatorStorage(
    { workspaceDir: fixture.workspaceDir },
    fake.dependencies,
  );
  const reopened = await openIdbSimulator(options, fake.dependencies);
  await reopened.close();
  expect(fake.commands.filter((args) => args.includes("create"))).toHaveLength(
    2,
  );
  expect(fake.commands.some((args) => args.includes("delete"))).toBe(true);
});

test("clear removes its repository's dead capacity record before deleting profiles", async () => {
  const fixture = await createApp();
  const fake = fakeDependencies(fixture.capacityRoot);
  const options = {
    sessionId: "crashed-before-clear",
    workspaceDir: fixture.workspaceDir,
    appPath: fixture.appPath,
  };
  await openIdbSimulator(options, fake.dependencies);
  const slotOwnerPath = join(fixture.capacityRoot, "slot-0", "owner.json");
  const staleOwner = JSON.parse(await Bun.file(slotOwnerPath).text());
  staleOwner.pid = 99999999;
  staleOwner.token = "11111111-2222-4333-8444-555555555555";
  await writeFile(slotOwnerPath, JSON.stringify(staleOwner));
  await writeFile(
    join(staleOwner.repositoryRoot, "active", "owner.json"),
    JSON.stringify(staleOwner),
  );
  const run = fake.dependencies.runner.run;
  fake.dependencies.runner.run = async (args, commandOptions) => {
    if (args[0] === "/bin/kill" && args[2] === "99999999")
      return { exitCode: 1, stdout: "", stderr: "no process" };
    return run(args, commandOptions);
  };

  await clearIdbSimulatorStorage(
    { workspaceDir: fixture.workspaceDir },
    fake.dependencies,
  );
  expect(await Bun.file(slotOwnerPath).exists()).toBe(false);

  const other = await createApp();
  const next = await openIdbSimulator(
    {
      sessionId: "after-crashed-clear",
      workspaceDir: other.workspaceDir,
      appPath: other.appPath,
    },
    fake.dependencies,
  );
  await next.close();
});

test("clear preserves another repository's capacity record", async () => {
  const firstFixture = await createApp();
  const secondFixture = await createApp();
  const fake = fakeDependencies(firstFixture.capacityRoot);
  const first = await openIdbSimulator(
    {
      sessionId: "clear-target",
      workspaceDir: firstFixture.workspaceDir,
      appPath: firstFixture.appPath,
    },
    fake.dependencies,
  );
  await first.close();
  const foreign = await openIdbSimulator(
    {
      sessionId: "foreign-active",
      workspaceDir: secondFixture.workspaceDir,
      appPath: secondFixture.appPath,
    },
    fake.dependencies,
  );
  const foreignOwnerPath = join(
    firstFixture.capacityRoot,
    "slot-0",
    "owner.json",
  );
  const ownerBefore = await Bun.file(foreignOwnerPath).text();
  await clearIdbSimulatorStorage(
    { workspaceDir: firstFixture.workspaceDir },
    fake.dependencies,
  );
  expect(await Bun.file(foreignOwnerPath).text()).toBe(ownerBefore);
  await foreign.close();
});

test("an interrupted clear blocks start and can be retried", async () => {
  const fixture = await createApp();
  const fake = fakeDependencies(fixture.capacityRoot);
  const options = {
    sessionId: "interrupted-clear",
    workspaceDir: fixture.workspaceDir,
    appPath: fixture.appPath,
  };
  const simulator = await openIdbSimulator(options, fake.dependencies);
  await simulator.close();
  const repositoriesRoot = join(fake.dependencies.durableRoot!, "repositories");
  const [repositoryName] = await readdir(repositoriesRoot);
  const profilesRoot = join(repositoriesRoot, repositoryName!, "profiles");
  const [profileName] = await readdir(profilesRoot);
  const profileRoot = join(profilesRoot, profileName!);
  await writeFile(join(profileRoot, ".clearing"), '{"version":1}');
  await rm(join(profileRoot, "profile.json"));

  await expect(openIdbSimulator(options, fake.dependencies)).rejects.toThrow(
    "clear was interrupted",
  );
  await clearIdbSimulatorStorage(
    { workspaceDir: fixture.workspaceDir },
    fake.dependencies,
  );
  const reopened = await openIdbSimulator(options, fake.dependencies);
  await reopened.close();
  expect(fake.commands.filter((args) => args.includes("create"))).toHaveLength(
    2,
  );
});

test("corrupt and symlinked retained storage fail closed", async () => {
  const fixture = await createApp();
  const fake = fakeDependencies(fixture.capacityRoot);
  const options = {
    sessionId: "corrupt",
    workspaceDir: fixture.workspaceDir,
    appPath: fixture.appPath,
  };
  const simulator = await openIdbSimulator(options, fake.dependencies);
  await simulator.close();
  const repositoriesRoot = join(fake.dependencies.durableRoot!, "repositories");
  const [repositoryName] = await readdir(repositoriesRoot);
  const repositoryRoot = join(repositoriesRoot, repositoryName!);
  const [profileName] = await readdir(join(repositoryRoot, "profiles"));
  const profileRoot = join(repositoryRoot, "profiles", profileName!);
  await writeFile(join(profileRoot, "profile.json"), "not json");
  await expect(openIdbSimulator(options, fake.dependencies)).rejects.toThrow(
    "Invalid simulator profile metadata",
  );
  await rm(join(profileRoot, "profile.json"));
  await symlink(
    join(fixture.appPath, "Info.plist"),
    join(profileRoot, "profile.json"),
  );
  await expect(openIdbSimulator(options, fake.dependencies)).rejects.toThrow(
    "Unsafe simulator profile metadata",
  );
  await rm(join(profileRoot, "profile.json"));

  await writeFile(
    join(profileRoot, "profile.json"),
    JSON.stringify({
      deviceIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
      runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
      deviceName: "iPhone 16 Pro",
      udid: UDID,
    }),
  );
  await rm(join(profileRoot, "set"), { recursive: true });
  await symlink(fixture.workspaceDir, join(profileRoot, "set"));
  await expect(openIdbSimulator(options, fake.dependencies)).rejects.toThrow(
    "Unsafe simulator device set path",
  );
});

test("persistent crash recovery shuts down without deleting retained data", async () => {
  const fixture = await createApp();
  const fake = fakeDependencies(fixture.capacityRoot);
  const options = {
    sessionId: "persistent-crash",
    workspaceDir: fixture.workspaceDir,
    appPath: fixture.appPath,
  };
  const initial = await openIdbSimulator(options, fake.dependencies);
  await initial.close();
  const repositoriesRoot = join(fake.dependencies.durableRoot!, "repositories");
  const [repositoryName] = await readdir(repositoriesRoot);
  const repositoryRoot = await realpath(
    join(repositoriesRoot, repositoryName!),
  );
  const [profileName] = await readdir(join(repositoryRoot, "profiles"));
  const deviceSet = join(repositoryRoot, "profiles", profileName!, "set");
  const staleOwner = {
    pid: 99999999,
    token: "11111111-2222-4333-8444-555555555555",
    leaseRoot: join(repositoryRoot, "runtime-stale"),
    deviceSet,
    udid: UDID,
    kind: "persistent",
    repositoryRoot,
    durableRoot: await realpath(fake.dependencies.durableRoot!),
  };
  await mkdir(join(repositoryRoot, "active"));
  await writeFile(
    join(repositoryRoot, "active", "owner.json"),
    JSON.stringify(staleOwner),
  );
  await mkdir(join(fixture.capacityRoot, "slot-0"), { recursive: true });
  await writeFile(
    join(fixture.capacityRoot, "slot-0", "owner.json"),
    JSON.stringify(staleOwner),
  );
  const run = fake.dependencies.runner.run;
  fake.dependencies.runner.run = async (args, commandOptions) => {
    if (args[0] === "/bin/kill")
      return { exitCode: 1, stdout: "", stderr: "no process" };
    return run(args, commandOptions);
  };

  const recovered = await openIdbSimulator(options, fake.dependencies);
  await recovered.close();
  expect(fake.commands.some((args) => args.includes("delete"))).toBe(false);
  expect(fake.commands.filter((args) => args.includes("create"))).toHaveLength(
    1,
  );
});

test("failed stale deletion preserves the occupied slot and device set", async () => {
  const fixture = await createApp();
  const fake = fakeDependencies(fixture.capacityRoot);
  const slot = join(fixture.capacityRoot, "slot-0");
  const leaseRoot = `/tmp/osi-${crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  await mkdir(join(leaseRoot, "set"), { recursive: true });
  temporaryDirectories.push(leaseRoot);
  await mkdir(slot, { recursive: true });
  const owner = {
    pid: 99999999,
    token: "old-owner",
    leaseRoot,
    deviceSet: join(leaseRoot, "set"),
    udid: UDID,
  };
  await writeFile(join(slot, "owner.json"), JSON.stringify(owner));
  const run = fake.dependencies.runner.run;
  fake.dependencies.runner.run = async (args, options) => {
    if (args[0] === "/bin/kill")
      return { exitCode: 1, stdout: "", stderr: "no process" };
    if (args.includes("delete"))
      return { exitCode: 1, stdout: "", stderr: "CoreSimulator unavailable" };
    return run(args, options);
  };
  await expect(
    openIdbSimulator(
      {
        sessionId: "recovery",
        workspaceDir: fixture.workspaceDir,
        appPath: fixture.appPath,
      },
      fake.dependencies,
    ),
  ).rejects.toThrow("capacity slot was preserved");
  expect(JSON.parse(await Bun.file(join(slot, "owner.json")).text())).toEqual(
    owner,
  );
  const { stat } = await import("fs/promises");
  expect((await stat(join(leaseRoot, "set"))).isDirectory()).toBe(true);
  expect(fake.commands.some((args) => args.includes("create"))).toBe(false);
});

test("clearing an empty repository is idempotent", async () => {
  const fixture = await createApp();
  const fake = fakeDependencies(fixture.capacityRoot);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await clearIdbSimulatorStorage(
      { workspaceDir: fixture.workspaceDir },
      fake.dependencies,
    );
  }
  expect(fake.commands.some((args) => args.includes("delete"))).toBe(false);
});

test("clear cannot free a capacity record whose device set was not verified stopped", async () => {
  const fixture = await createApp();
  const fake = fakeDependencies(fixture.capacityRoot);
  const simulator = await openIdbSimulator(
    {
      sessionId: "unverified-set",
      workspaceDir: fixture.workspaceDir,
      appPath: fixture.appPath,
    },
    fake.dependencies,
  );
  const slot = join(fixture.capacityRoot, "slot-0");
  const owner = await Bun.file(join(slot, "owner.json")).json();
  await simulator.close();
  await rm(join(owner.deviceSet, ".."), { recursive: true });
  await mkdir(slot);
  owner.pid = 99999999;
  await writeFile(join(slot, "owner.json"), JSON.stringify(owner));
  const run = fake.dependencies.runner.run;
  fake.dependencies.runner.run = async (args, options) =>
    args[0] === "/bin/kill" && args[2] === "99999999"
      ? { exitCode: 1, stdout: "", stderr: "no process" }
      : run(args, options);
  await expect(
    clearIdbSimulatorStorage(
      { workspaceDir: fixture.workspaceDir },
      fake.dependencies,
    ),
  ).rejects.toThrow("Invalid repository capacity metadata");
  expect(await Bun.file(join(slot, "owner.json")).exists()).toBe(true);
  expect(fake.commands.some((args) => args.includes("delete"))).toBe(false);
});

test("global capacity recovers dead leases from a different instance root", async () => {
  const fixtures = await Promise.all([createApp(), createApp()]);
  const first = fakeDependencies(fixtures[0]!.capacityRoot);
  const oldSets: string[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    await openIdbSimulator(
      {
        sessionId: `old-${index}`,
        workspaceDir: fixture.workspaceDir,
        appPath: fixture.appPath,
      },
      first.dependencies,
    );
    const slotPath = join(
      fixtures[0]!.capacityRoot,
      `slot-${index}`,
      "owner.json",
    );
    const owner = await Bun.file(slotPath).json();
    owner.pid = 99999999;
    oldSets.push(owner.deviceSet);
    await writeFile(slotPath, JSON.stringify(owner));
    await writeFile(
      join(owner.repositoryRoot, "active", "owner.json"),
      JSON.stringify(owner),
    );
  }
  const next = fakeDependencies(fixtures[0]!.capacityRoot);
  next.dependencies.durableRoot = join(
    fixtures[0]!.capacityRoot,
    "another-instance",
  );
  const run = next.dependencies.runner.run;
  next.dependencies.runner.run = async (args, options) =>
    args[0] === "/bin/kill" && args[2] === "99999999"
      ? { exitCode: 1, stdout: "", stderr: "no process" }
      : run(args, options);
  const active = [];
  try {
    for (const [index, fixture] of fixtures.entries()) {
      active.push(
        await openIdbSimulator(
          {
            sessionId: `new-${index}`,
            workspaceDir: fixture.workspaceDir,
            appPath: fixture.appPath,
          },
          next.dependencies,
        ),
      );
    }
    for (const deviceSet of oldSets)
      expect(next.commands).toContainEqual([
        "/usr/bin/simctl",
        "--set",
        deviceSet,
        "shutdown",
        "all",
      ]);
    expect(next.commands.some((args) => args.includes("delete"))).toBe(false);
  } finally {
    for (const simulator of active) await simulator.close();
  }
});

test.each(["missing", "dangling symlink", "stored device"])(
  "clear handles a pre-device profile with %s set",
  async (state) => {
    const fixture = await createApp();
    const fake = fakeDependencies(fixture.capacityRoot);
    const simulator = await openIdbSimulator(
      {
        sessionId: "metadata-only",
        workspaceDir: fixture.workspaceDir,
        appPath: fixture.appPath,
      },
      fake.dependencies,
    );
    const owner = await Bun.file(
      join(fixture.capacityRoot, "slot-0", "owner.json"),
    ).json();
    await simulator.close();
    const metadataPath = join(owner.deviceSet, "..", "profile.json");
    const metadata = await Bun.file(metadataPath).json();
    if (state !== "stored device") delete metadata.udid;
    await writeFile(metadataPath, JSON.stringify(metadata));
    await rm(owner.deviceSet, { recursive: true });
    if (state === "dangling symlink")
      await symlink(join(fixture.workspaceDir, "absent"), owner.deviceSet);
    const before = fake.commands.length;
    const clear = clearIdbSimulatorStorage(
      { workspaceDir: fixture.workspaceDir },
      fake.dependencies,
    );
    if (state === "missing") {
      await clear;
      expect(await Bun.file(metadataPath).exists()).toBe(false);
    } else {
      await expect(clear).rejects.toThrow();
      expect(await Bun.file(metadataPath).exists()).toBe(true);
    }
    expect(
      fake.commands.slice(before).some((args) => args[0] === "/usr/bin/simctl"),
    ).toBe(false);
  },
);
