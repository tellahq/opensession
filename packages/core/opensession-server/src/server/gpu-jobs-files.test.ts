/**
 * The files a GPU job carries: host files sent to the machine, outputs
 * copied back. The machine is a fake Sandbox that runs its commands with
 * this host's bash, so the real shell lines are what is tested.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "./sandbox/provider";

const root = mkdtempSync(join(tmpdir(), "opensession-gpu-job-files-"));
const previousState = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = join(root, "state");

const {
  __gpuJobsMachineFilesForTest: machine,
  __resetGpuJobsForTest,
  gpuJobEndedMessage,
  gpuJobFileTarget,
  gpuJobHostDir,
  loadGpuJobFiles,
  parseMachineFileList,
  parseRepoGpuJobs,
  safeRelativePath,
} = await import("./gpu-jobs");
type GpuJobRecord = import("./gpu-jobs").GpuJobRecord;

__resetGpuJobsForTest();
const jobIds: string[] = [];

afterAll(() => {
  if (previousState === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousState;
  for (const id of jobIds)
    rmSync(machine.remoteDir(id), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

/** A Sandbox whose workspace is a directory on this host. */
function localMachine(cwd: string): Sandbox & { written: string[] } {
  const written: string[] = [];
  return {
    id: "md-os-1--gpu",
    provider: "modal",
    cwd,
    written,
    async exec(cmd, opts) {
      const proc = Bun.spawn(cmd, {
        cwd,
        env: { ...process.env, ...opts?.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr };
    },
    async writeFile(path, content) {
      written.push(content);
      writeFileSync(path, content);
    },
    async ports() {
      return {};
    },
    async status() {
      return "running";
    },
  };
}

function job(id: string): GpuJobRecord {
  jobIds.push(id);
  return {
    id,
    sessionId: "os-files-test",
    title: "t",
    command: "true",
    gpu: "T4",
    state: "running",
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("declared identity", () => {
  test("a job may ask for a Portal's identity; anything else is dropped", () => {
    const jobs = parseRepoGpuJobs(
      JSON.stringify({
        jobs: {
          webapp: { command: "./.agents/start.sh", identity: "portal" },
          other: { command: "true", identity: "root" },
        },
      }),
    );
    expect(jobs.webapp?.identity).toBe("portal");
    expect(jobs.other?.identity).toBeUndefined();
  });
});

describe("paths", () => {
  test("a target resolves against the repository root, never into .git or the job's own files", () => {
    expect(gpuJobFileTarget("webapp/.env.local", "/repo")).toBe(
      "/repo/webapp/.env.local",
    );
    expect(gpuJobFileTarget("/root/.aws/config", "/repo")).toBe(
      "/root/.aws/config",
    );
    expect(gpuJobFileTarget(".git/config", "/repo")).toBeNull();
    expect(gpuJobFileTarget("a/../.git/hooks/x", "/repo")).toBeNull();
    expect(
      gpuJobFileTarget("/tmp/opensession-gpu-jobs/gj-1/exit", "/repo"),
    ).toBeNull();
    expect(gpuJobFileTarget("dir/", "/repo")).toBeNull();
    expect(gpuJobFileTarget("a\nb", "/repo")).toBeNull();
  });

  test("a file coming back stays inside its directory", () => {
    expect(safeRelativePath("shots/a.png")).toBe(join("shots", "a.png"));
    expect(safeRelativePath("../a.png")).toBeNull();
    expect(safeRelativePath("a/../../b")).toBeNull();
    expect(safeRelativePath("/etc/passwd")).toBeNull();
    expect(safeRelativePath("a//b")).toBeNull();
  });

  test("reads find's listing, names with tabs and newlines included", () => {
    expect(
      parseMachineFileList("12\ta.png\u000030\tdir/b\tc\nd\u0000", "/out"),
    ).toEqual([
      { remote: "/out/a.png", rel: "a.png", size: 12 },
      { remote: "/out/dir/b\tc\nd", rel: "dir/b\tc\nd", size: 30 },
    ]);
  });
});

describe("host files a job sends", () => {
  const worktree = join(root, "worktree");
  const scratch = join(root, "scratch");
  const main = join(root, "main");
  const elsewhere = join(root, "elsewhere");
  const roots = { worktree, scratch, mainCheckout: main };

  test("come only from the worktree's ignored files, scratch, or the main checkout", async () => {
    for (const dir of [worktree, scratch, main, elsewhere])
      mkdirSync(dir, { recursive: true });
    await $`git init -q ${worktree}`;
    writeFileSync(join(worktree, ".gitignore"), ".env.local\n");
    writeFileSync(join(worktree, ".env.local"), "SECRET=1\n");
    writeFileSync(join(worktree, "tracked.txt"), "x\n");
    writeFileSync(join(scratch, "key.pem"), "KEY\n");
    writeFileSync(join(main, ".env"), "MAIN=1\n");
    writeFileSync(join(elsewhere, "x"), "no\n");
    await $`ln -s ${join(elsewhere, "x")} ${join(scratch, "link")}`.nothrow();

    const ok = await loadGpuJobFiles(
      [
        { from: ".env.local", to: "webapp/.env.local" },
        { from: join(scratch, "key.pem"), to: "/root/key.pem", mode: "0400" },
        { from: join(main, ".env"), to: ".env" },
      ],
      roots,
    );
    expect("files" in ok && ok.files.map((f) => [f.to, f.mode])).toEqual([
      ["webapp/.env.local", "600"],
      ["/root/key.pem", "400"],
      [".env", "600"],
    ]);

    const refused = async (from: string) => {
      const result = await loadGpuJobFiles([{ from, to: "x" }], roots);
      return "error" in result ? result.error : "";
    };
    // Not ignored: it ships with the checkpoint already.
    expect(await refused("tracked.txt")).toContain("not gitignored");
    expect(await refused(join(elsewhere, "x"))).toContain("outside");
    // A symlink is judged by where it points.
    expect(await refused(join(scratch, "link"))).toContain("outside");
    expect(await refused(join(scratch, "missing"))).toContain("does not exist");
    expect(await refused(scratch)).toContain("not a file");
  });

  test("land with their mode, and are gone when the job ends", async () => {
    const cwd = join(root, "machine-workspace");
    mkdirSync(cwd, { recursive: true });
    const sandbox = localMachine(cwd);
    const record = job(`gj-files-${Date.now().toString(36)}`);
    const binary = Buffer.from([0, 1, 2, 255, 10, 13, 0]);
    await machine.stageFiles(sandbox, record, [
      { to: "webapp/.env.local", mode: "600", content: Buffer.from("A=1\n") },
      { to: "bin/blob", mode: "755", content: binary },
    ]);
    const env = join(cwd, "webapp/.env.local");
    expect(readFileSync(env, "utf8")).toBe("A=1\n");
    expect(statSync(env).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(cwd, "bin/blob"))).toEqual(binary);
    expect(statSync(join(cwd, "bin/blob")).mode & 0o777).toBe(0o755);
    // The record names where they went, nothing of what they hold.
    expect(record.stagedFiles).toEqual([env, join(cwd, "bin/blob")]);
    expect(JSON.stringify(record)).not.toContain("A=1");
    // Only base64 crossed the file API, and the inbox is empty again.
    expect(sandbox.written).toEqual([
      Buffer.from("A=1\n").toString("base64"),
      binary.toString("base64"),
    ]);
    expect(existsSync(`${machine.remoteDir(record.id)}/in/0`)).toBe(false);

    await machine.removeStaged(sandbox, record);
    expect(existsSync(env)).toBe(false);
    expect(existsSync(join(cwd, "bin/blob"))).toBe(false);
  });
});

describe("outputs", () => {
  test("come back byte for byte to the session's scratch, within the cap", async () => {
    const cwd = join(root, "machine-outputs");
    mkdirSync(cwd, { recursive: true });
    const sandbox = localMachine(cwd);
    const record = job(`gj-out-${Date.now().toString(36)}`);
    const out = `${machine.remoteDir(record.id)}/output`;
    mkdirSync(join(out, "shots"), { recursive: true });
    // Larger than one 4 MiB chunk, so it crosses in pieces.
    const png = Buffer.alloc(9 * 1024 * 1024 + 17);
    for (let i = 0; i < png.length; i += 4096) png[i] = i % 251;
    writeFileSync(join(out, "shots/page.png"), png);
    writeFileSync(join(out, "empty"), "");
    await $`ln -s /etc/hostname ${join(out, "link")}`;

    await machine.collectOutputs(sandbox, record);
    const dir = gpuJobHostDir(record);
    expect(record.outputDir).toBe(dir);
    expect(record.outputFiles).toBe(2);
    expect(readFileSync(join(dir, "shots/page.png")).equals(png)).toBe(true);
    expect(readFileSync(join(dir, "empty"), "utf8")).toBe("");
    // A symlink on the machine is not followed or recreated.
    expect(existsSync(join(dir, "link"))).toBe(false);
    expect(
      gpuJobEndedMessage({ ...record, state: "exited", exitCode: 0 }, ""),
    ).toContain(`Outputs ($OPENSESSION_JOB_OUTPUT, 2 files): ${dir}`);
  });
});
