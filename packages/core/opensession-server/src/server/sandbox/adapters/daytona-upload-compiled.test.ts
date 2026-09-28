import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Worst case build + sign + two runs = 130s, leaving cleanup margin inside
// the 150s test timeout.
const BUILD_TIMEOUT_MS = 80_000;
const SIGN_TIMEOUT_MS = 10_000;
const RUN_TIMEOUT_MS = 20_000;

interface Finished {
  code: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Spawns children this test owns. Each is killed at its deadline, and
 * `stopAll` kills and reaps any survivor before the temp dir is removed, so a
 * failed assertion never orphans a process or deletes files it is using.
 */
function ownedProcesses() {
  const live = new Set<Bun.Subprocess>();
  return {
    async run(
      cmd: string[],
      timeoutMs: number,
      options: { cwd?: string; env?: Record<string, string> } = {},
    ): Promise<Finished> {
      const child = Bun.spawn(cmd, {
        ...options,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      live.add(child);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { code, timedOut, stdout, stderr };
      } finally {
        clearTimeout(timer);
        // A rejected pipe read can leave the child running: reap it first.
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await child.exited;
        }
        live.delete(child);
      }
    },
    async stopAll(): Promise<void> {
      const survivors = [...live];
      for (const child of survivors) child.kill("SIGKILL");
      await Promise.all(survivors.map((child) => child.exited));
    },
  };
}

/**
 * A `bun build --compile` binary ships no `node_modules`, so the SDK's runtime
 * `require("form-data")` fails there. Build a binary outside the checkout and
 * upload through the real SDK signed URL to a loopback fixture: no Daytona
 * account or network is involved.
 *
 * `legacy` mode calls the SDK's `fs.uploadFile` instead: the control that
 * shows the binary really lacks `form-data`.
 */
test("a compiled binary writes Daytona files without the form-data package", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daytona-upload-"));
  const processes = ownedProcesses();
  try {
    const entry = join(dir, "entry.ts");
    const executable = join(dir, "upload.bin");
    await writeFile(
      entry,
      `
      import { uploadDaytonaFile } from ${JSON.stringify(join(import.meta.dir, "daytona-upload.ts"))};
      import { startUploadFixture } from ${JSON.stringify(join(import.meta.dir, "daytona-upload-fixture.ts"))};
      const fixture = startUploadFixture();
      const bytes = new Uint8Array(256).map((_, i) => i);
      try {
        if (process.argv[2] === "legacy") {
          await fixture.sandbox.fs.uploadFile(Buffer.from(bytes), "/tmp/a/blob.bin");
        } else {
          await uploadDaytonaFile(fixture.sandbox, "/tmp/a/blob.bin", bytes);
        }
        const [upload] = fixture.uploads;
        console.log(JSON.stringify({
          uploads: fixture.uploads.length,
          path: upload?.path,
          signatureValid: upload?.signatureValid,
          bytesMatch: Buffer.from(upload?.bytes ?? []).equals(Buffer.from(bytes)),
        }));
      } finally {
        fixture.close();
      }
    `,
    );
    const build = await processes.run(
      [process.execPath, "build", "--compile", entry, "--outfile", executable],
      BUILD_TIMEOUT_MS,
    );
    expect({
      code: build.code,
      timedOut: build.timedOut,
      error: build.code ? build.stdout + build.stderr : "",
    }).toEqual({ code: 0, timedOut: false, error: "" });
    if (process.platform === "darwin") {
      // Refresh the ad-hoc signature after Bun embeds the compiled payload.
      const sign = await processes.run(
        ["/usr/bin/codesign", "--force", "--sign", "-", executable],
        SIGN_TIMEOUT_MS,
      );
      expect({ code: sign.code, error: sign.code ? sign.stderr : "" }).toEqual({
        code: 0,
        error: "",
      });
    }
    await rm(entry);
    // Run from the temp dir with a minimal env: nothing beside the binary.
    const run = (mode: string) =>
      processes.run([executable, mode], RUN_TIMEOUT_MS, {
        cwd: dir,
        env: { PATH: "/usr/bin:/bin", HOME: dir },
      });
    const signed = await run("signed");
    expect({
      code: signed.code,
      timedOut: signed.timedOut,
      stderr: signed.code ? signed.stderr : "",
    }).toEqual({ code: 0, timedOut: false, stderr: "" });
    expect(JSON.parse(signed.stdout)).toEqual({
      uploads: 1,
      path: "/tmp/a/blob.bin",
      signatureValid: true,
      bytesMatch: true,
    });
    // Control: the same binary reproduces the compiled-install failure through
    // the SDK upload, so this test really runs without form-data available.
    const legacy = await run("legacy");
    expect(legacy.timedOut).toBe(false);
    expect(legacy.code).not.toBe(0);
    expect(legacy.stderr).toContain('Module "form-data" is not available');
  } finally {
    await processes.stopAll();
    await rm(dir, { recursive: true, force: true });
  }
}, 150_000);
