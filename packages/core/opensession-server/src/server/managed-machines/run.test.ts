import { describe, expect, test } from "bun:test";
import { commandEnv, runCommand } from "./run";

describe("runCommand", () => {
  test("passes arguments as data, never through a shell", async () => {
    const result = await runCommand(["printf", "%s", "$(echo hi); rm -rf x"], {
      timeoutMs: 5_000,
    });
    expect(result).toEqual({
      code: 0,
      stdout: "$(echo hi); rm -rf x",
      stderr: "",
    });
  });

  test("passes stdin through", async () => {
    const result = await runCommand(["cat"], {
      timeoutMs: 5_000,
      stdin: "hello\n",
    });
    expect(result.stdout).toBe("hello\n");
  });

  test("reports the exit code and stderr", async () => {
    const result = await runCommand(["sh", "-c", "echo bad >&2; exit 3"], {
      timeoutMs: 5_000,
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toBe("bad\n");
  });

  test("kills the child on timeout", async () => {
    const started = Date.now();
    const result = await runCommand(["sleep", "30"], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(-1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("kills the child on cancel", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runCommand(["sleep", "30"], {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
  });

  test("bounds output", async () => {
    const result = await runCommand(["sh", "-c", "yes | head -c 50000"], {
      timeoutMs: 5_000,
      maxOutput: 1_000,
    });
    expect(result.stdout.length).toBeLessThan(1_100);
    expect(result.stdout.endsWith("[output truncated]")).toBe(true);
  });

  test("does not inherit the server's environment", async () => {
    const env = commandEnv(
      { EXTRA: "1" },
      { PATH: "/bin", HOME: "/h", SECRET: "x" },
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", EXTRA: "1" });
  });
});
