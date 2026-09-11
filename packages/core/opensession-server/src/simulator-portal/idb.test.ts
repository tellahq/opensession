import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { openIdbSimulator, type IdbSimulatorDependencies } from "./idb";

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
} => {
  const commands: string[][] = [];
  const spawned: string[][] = [];
  const dependencies: IdbSimulatorDependencies = {
    platform: "darwin",
    pid: process.pid,
    capacityRoot,
    runner: {
      async run(argv) {
        commands.push(argv);
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
  return { dependencies, commands, spawned };
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

    const companion = fake.spawned[0] ?? [];
    expect(companion).toContain("--device-set-path");
    expect(companion).toContain("--grpc-domain-sock");
    expect(companion).toContain(UDID);
    const tapCommand = fake.commands.find((argv) => argv.includes("tap"));
    expect(tapCommand).toEqual(
      expect.arrayContaining([
        "/usr/local/bin/idb",
        "--companion",
        "ui",
        "tap",
        "20",
        "40",
      ]),
    );
    expect(tapCommand?.[2]?.endsWith("/idb.sock")).toBe(true);
    expect(fake.commands).toContainEqual(
      expect.arrayContaining([
        "ui",
        "swipe",
        "10",
        "20",
        "30",
        "40",
        "--duration",
        "0.5",
      ]),
    );

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

  test("streams MJPEG through the callback API", async () => {
    const fixture = await createApp();
    const fake = fakeDependencies(fixture.capacityRoot);
    const videoBytes = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    fake.dependencies.runner.spawn = (argv) => {
      fake.spawned.push(argv);
      if (argv[0]?.endsWith("idb_companion")) {
        return longLivedProcess(
          streamFrom(['{"grpc_path":"/tmp/private.sock"}\n']),
        );
      }
      return longLivedProcess(
        new ReadableStream({
          start(controller) {
            controller.enqueue(videoBytes);
          },
        }),
      );
    };
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
    await Bun.sleep(0);
    expect(fake.spawned.at(-1)).toEqual(
      expect.arrayContaining(["video-stream", "--format", "mjpeg"]),
    );
    expect(chunks).toEqual([videoBytes]);
    await stop();
    expect(errors).toEqual([]);
    await simulator.close();
  });

  test("fails and deletes its own device when logical dimensions are absent", async () => {
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
    expect(fake.commands).toContainEqual(
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

test("two concurrent sessions use separate device sets and a third cannot exceed capacity", async () => {
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
  const [first, second] = await Promise.all([start("first"), start("second")]);
  try {
    const sets = fake.commands
      .filter((args) => args.includes("create"))
      .map((args) => args[2]);
    expect(new Set(sets).size).toBe(2);
    await expect(start("third")).rejects.toThrow("capacity is full");
    await first.input({ kind: "text", text: "--help" });
    expect(fake.commands.at(-1)?.slice(-4)).toEqual([
      "ui",
      "text",
      "--",
      "--help",
    ]);
  } finally {
    await first.close();
    await second.close();
  }
  const next = await start("third");
  await next.close();
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
