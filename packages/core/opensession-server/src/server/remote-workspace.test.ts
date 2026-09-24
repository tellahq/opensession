import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  INLINE_GITHUB_CREDENTIAL_HELPER,
  RemoteWorkspace,
  makeRemoteGrepExecute,
  makeRemoteToolOps,
  mirrorRemoteContext,
  parseRemoteCommandOutput,
  remoteCommandEnv,
  remoteWorkspaceForRun,
  runRemoteCommand,
  sniffImageBytes,
  type RemoteWorkspaceTransport,
} from "./remote-workspace";

// The "Sandbox" is a temp dir on this machine, and the transport runs each
// script the way sandbox/workspace-rpc.ts does: `bash -c` after a cd.
let root: string;
let checkout: string;
let scratch: string;
let calls: string[] = [];

const transport: RemoteWorkspaceTransport = async (body) => {
  calls.push(String(body.script));
  const proc = Bun.spawn(
    [
      "bash",
      "-c",
      'cd -- "$OS_CWD" 2>/dev/null || { echo "No such directory in the Sandbox: $OS_CWD" >&2; exit 125; }\n' +
        String(body.script),
    ],
    {
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        HOME: root,
        ...(body.env as Record<string, string> | undefined),
        OS_CWD: String(body.cwd || "/"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

function workspace(): RemoteWorkspace {
  return new RemoteWorkspace(
    {
      provider: "box",
      sandboxId: "bx_test",
      cwd: checkout,
      scratchDir: scratch,
    },
    transport,
  );
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "os-remote-ws-"));
  checkout = join(root, "worktrees", "acme-feature");
  scratch = join(root, "scratch");
  mkdirSync(join(checkout, "src", "nested"), { recursive: true });
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(checkout, "README.md"), "hello\nworld\n");
  writeFileSync(
    join(checkout, "src", "index.ts"),
    "export const answer = 42;\n",
  );
  writeFileSync(
    join(checkout, "src", "nested", "deep.ts"),
    "// answer lives here\n",
  );
  writeFileSync(join(checkout, "AGENTS.md"), "# Acme rules\n");
  mkdirSync(join(checkout, ".agents", "skills", "ship"), { recursive: true });
  writeFileSync(
    join(checkout, ".agents", "skills", "ship", "SKILL.md"),
    "---\nname: ship\ndescription: Ship it\n---\nDo the thing.\n",
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("remote file operations", () => {
  test("reads, writes, and lists in one command each", async () => {
    const ws = workspace();
    const ops = makeRemoteToolOps(ws);
    calls = [];
    expect((await ops.read.readFile("README.md")).toString()).toBe(
      "hello\nworld\n",
    );
    // access followed by readFile is one round trip.
    await ops.read.access(join(checkout, "src", "index.ts"));
    await ops.read.readFile(join(checkout, "src", "index.ts"));
    expect(calls).toHaveLength(2);

    await ops.write.writeFile(join(checkout, "new", "dir", "file.txt"), "hi");
    expect(readFileSync(join(checkout, "new", "dir", "file.txt"), "utf8")).toBe(
      "hi",
    );

    calls = [];
    const entries = await ops.ls.readdir(checkout);
    expect(entries.sort()).toEqual(
      [".agents", "AGENTS.md", "README.md", "new", "src"].sort(),
    );
    // ls stats every entry; the listing already answered those.
    expect((await ops.ls.stat(join(checkout, "src"))).isDirectory()).toBe(true);
    expect((await ops.ls.stat(join(checkout, "README.md"))).isDirectory()).toBe(
      false,
    );
    expect(calls).toHaveLength(1);
  });

  test("missing files fail like the local filesystem", async () => {
    const ops = makeRemoteToolOps(workspace());
    await expect(ops.read.readFile("nope.txt")).rejects.toThrow("ENOENT");
    expect(await ops.ls.exists(join(checkout, "nope"))).toBe(false);
    await expect(ops.edit.access("nope.txt")).rejects.toThrow("ENOENT");
  });

  test("edits round-trip", async () => {
    const ops = makeRemoteToolOps(workspace());
    const path = join(checkout, "src", "index.ts");
    await ops.edit.access(path);
    const before = (await ops.edit.readFile(path)).toString();
    await ops.edit.writeFile(path, before.replace("42", "43"));
    expect(readFileSync(path, "utf8")).toBe("export const answer = 43;\n");
    // A write invalidates the cached read.
    expect((await ops.read.readFile(path)).toString()).toContain("43");
  });

  test("large files are written in chunks and moved into place", async () => {
    const ws = workspace();
    const big = "x".repeat(200_000) + "\nend\n";
    calls = [];
    await ws.writeFile(join(checkout, "big.txt"), big);
    expect(readFileSync(join(checkout, "big.txt"), "utf8")).toBe(big);
    expect(calls.length).toBeGreaterThan(2);
    expect(readFileSync(join(checkout, "big.txt"), "utf8").length).toBe(
      big.length,
    );
  });

  test("binary content survives the trip", async () => {
    const ws = workspace();
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255,
    ]);
    await ws.writeFile(join(scratch, "attachments", "shot.png"), png);
    const back = await ws.readFile(join(scratch, "attachments", "shot.png"));
    expect(back.equals(png)).toBe(true);
    expect(sniffImageBytes(back)).toBe("image/png");
  });

  test("find globs like fd, relative to the search root", async () => {
    const ops = makeRemoteToolOps(workspace());
    const found = await ops.find.glob("*.ts", checkout, {
      ignore: [],
      limit: 10,
    });
    expect(found).toEqual([
      join(checkout, "src", "index.ts"),
      join(checkout, "src", "nested", "deep.ts"),
    ]);
  });

  test("shipped skills are read here, never written", async () => {
    const shipped = join(root, "shipped");
    mkdirSync(join(shipped, "demo"), { recursive: true });
    writeFileSync(join(shipped, "demo", "SKILL.md"), "shipped skill\n");
    const ops = makeRemoteToolOps(workspace(), [shipped]);
    calls = [];
    expect(
      (await ops.read.readFile(join(shipped, "demo", "SKILL.md"))).toString(),
    ).toBe("shipped skill\n");
    expect(calls).toHaveLength(0);
    await expect(
      ops.write.writeFile(join(shipped, "demo", "SKILL.md"), "x"),
    ).rejects.toThrow("read only");
  });
});

describe("remote grep", () => {
  test("prints workspace-relative matches", async () => {
    const execute = makeRemoteGrepExecute(workspace());
    const result = await execute("t", { pattern: "answer", path: "src" });
    const text = result.content[0].text;
    expect(text).toContain("index.ts:1:");
    expect(text).toContain("nested/deep.ts:1:");
    const none = await execute("t", { pattern: "zebra-not-there" });
    expect(none.content[0].text).toBe("No matches found");
  });
});

describe("remote commands", () => {
  test("merges output, reports the exit code, and runs in the checkout", async () => {
    const ws = workspace();
    const ok = await runRemoteCommand(ws, {
      command: 'pwd; echo out; echo err >&2; echo "tmp=$TMPDIR"',
      timeoutS: 30,
      outputCap: 40_000,
      env: { OPENSESSION_SCRATCH: scratch, OS_TMPDIR: join(scratch, "tmp") },
      signals: [],
    });
    expect(ok.exitCode).toBe(0);
    expect(ok.output).toContain(checkout);
    expect(ok.output).toContain("out");
    expect(ok.output).toContain("err");
    expect(ok.output).toContain(`tmp=${join(scratch, "tmp")}`);
    const failed = await runRemoteCommand(ws, {
      command: "exit 3",
      timeoutS: 30,
      outputCap: 40_000,
      env: { OPENSESSION_SCRATCH: scratch },
      signals: [],
    });
    expect(failed.exitCode).toBe(3);
  });

  test("a backgrounded server does not hold the command open", async () => {
    const started = Date.now();
    const result = await runRemoteCommand(workspace(), {
      command: "sleep 30 & echo started",
      timeoutS: 60,
      outputCap: 40_000,
      env: { OPENSESSION_SCRATCH: scratch },
      signals: [],
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("started");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("times out and kills the whole process group", async () => {
    const marker = join(scratch, "survivor");
    const result = await runRemoteCommand(workspace(), {
      command: `(sleep 4; touch ${marker}) & sleep 30`,
      timeoutS: 1,
      outputCap: 40_000,
      env: { OPENSESSION_SCRATCH: scratch },
      signals: [],
    });
    expect(result.timedOut).toBe(true);
    await Bun.sleep(4_500);
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  test("a stop kills the command", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runRemoteCommand(workspace(), {
      command: "sleep 30",
      timeoutS: 60,
      outputCap: 40_000,
      env: { OPENSESSION_SCRATCH: scratch },
      signals: [controller.signal],
    });
    await Bun.sleep(500);
    controller.abort();
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  test("keeps the tail of long output and says how much was dropped", () => {
    const parsed = parseRemoteCommandOutput(
      `${"y".repeat(10)}\n__OPENSESSION_EXIT__ 0 500 0\n`,
      10,
    );
    expect(parsed).toEqual({
      output: "y".repeat(10),
      droppedChars: 490,
      exitCode: 0,
      timedOut: false,
    });
    expect(parseRemoteCommandOutput("killed", 10)).toBeNull();
  });
});

describe("remote command environment", () => {
  test("drops what names this machine and keeps GitHub transport working", () => {
    const env = remoteCommandEnv(
      {
        PATH: "/host/bin",
        HOME: "/home/host",
        TMPDIR: "/host/tmp",
        AWS_SHARED_CREDENTIALS_FILE: "/host/aws",
        CLAUDE_CODE_OAUTH_TOKEN: "secret",
        GH_TOKEN: "ghs_example",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
        GIT_CONFIG_VALUE_1: "!/host/bin/opensession github-credential",
        GIT_AUTHOR_NAME: "acme[bot]",
      },
      { scratchDir: "/home/ubuntu/.opensession/session-scratch/s1" },
      "run-1",
      false,
    );
    expect(env.PATH).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBe("ghs_example");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    expect(env.GIT_CONFIG_VALUE_1).toBe(INLINE_GITHUB_CREDENTIAL_HELPER);
    expect(env.GIT_AUTHOR_NAME).toBe("acme[bot]");
    expect(env.OPENSESSION_SCRATCH).toBe(
      "/home/ubuntu/.opensession/session-scratch/s1",
    );
    // Exported by the command wrapper once the directory exists.
    expect(env.TMPDIR).toBeUndefined();
    expect(env.OS_TMPDIR).toBe(
      "/home/ubuntu/.opensession/session-scratch/s1/tmp",
    );
  });
});

describe("remote context", () => {
  test("mirrors AGENTS.md and the checkout's skills, mapping paths back", async () => {
    const mirror = join(root, "mirror");
    const context = await mirrorRemoteContext(workspace(), mirror);
    expect(readFileSync(join(mirror, "AGENTS.md"), "utf8")).toBe(
      "# Acme rules\n",
    );
    const skill = join(mirror, ".agents", "skills", "ship", "SKILL.md");
    expect(readFileSync(skill, "utf8")).toContain("name: ship");
    expect(context.toRemote(skill)).toBe(
      join(checkout, ".agents", "skills", "ship", "SKILL.md"),
    );
    expect(context.toRemote("/elsewhere/file")).toBe("/elsewhere/file");
  });
});

describe("remote workspace for a run", () => {
  test("refuses a spec without its run token", () => {
    expect(() =>
      remoteWorkspaceForRun({
        provider: "box",
        sandboxId: "bx_1",
        cwd: "/home/ubuntu/worktrees/acme",
        scratchDir: "/home/ubuntu/.opensession/session-scratch/s1",
        rpcToken: "",
      }),
    ).toThrow("never run anywhere else");
  });
});

describe("review hardening", () => {
  test("a command larger than one argument travels as a file", async () => {
    const big = `echo start; : '${"z".repeat(200_000)}'; echo end`;
    const result = await runRemoteCommand(workspace(), {
      command: big,
      timeoutS: 30,
      outputCap: 40_000,
      env: { OPENSESSION_SCRATCH: scratch },
      signals: [],
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("start");
    expect(result.output).toContain("end");
  });

  test("a Stop before the command starts still stops it", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const result = await runRemoteCommand(workspace(), {
      command: "sleep 30",
      timeoutS: 60,
      outputCap: 1_000,
      env: { OPENSESSION_SCRATCH: scratch },
      signals: [controller.signal],
    });
    expect(result.cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  test("an edit never writes back a truncated read", async () => {
    const huge = join(checkout, "huge.bin");
    writeFileSync(huge, Buffer.alloc(9 * 1024 * 1024, 97));
    const ops = makeRemoteToolOps(workspace());
    expect((await ops.read.readFile(huge)).length).toBe(8 * 1024 * 1024);
    await expect(ops.edit.readFile(huge)).rejects.toThrow("EFBIG");
    rmSync(huge);
  });

  test("a command invalidates what was read before it", async () => {
    const ws = workspace();
    const ops = makeRemoteToolOps(ws);
    const path = join(checkout, "cached.txt");
    writeFileSync(path, "before\n");
    await ops.read.access(path);
    await runRemoteCommand(ws, {
      command: `printf 'after\\n' > ${path}`,
      timeoutS: 30,
      outputCap: 1_000,
      env: { OPENSESSION_SCRATCH: scratch },
      signals: [],
    });
    expect((await ops.read.readFile(path)).toString()).toBe("after\n");
  });

  test("a server left running keeps its log in scratch", async () => {
    const tmp = join(scratch, "tmp");
    const result = await runRemoteCommand(workspace(), {
      command: "(for i in 1 2 3; do echo tick; sleep 1; done) &",
      timeoutS: 30,
      outputCap: 1_000,
      env: { OPENSESSION_SCRATCH: scratch, OS_TMPDIR: tmp },
      signals: [],
    });
    expect(result.exitCode).toBe(0);
    const logs = await Array.fromAsync(
      new Bun.Glob("os-cmd-*").scan({ cwd: tmp }),
    );
    expect(logs.length).toBeGreaterThan(0);
  });
});
